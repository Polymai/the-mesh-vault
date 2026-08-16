package __POLYMAI_PACKAGE__;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.Closeable;
import java.net.URI;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** One-time Supabase cold start followed by the bounded native peer set. */
final class PolymaiAppMeshClient implements Closeable {
    interface Reporter { void update(String message); }

    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final String SCHEMA = "app717_meshvault";
    private static final int MAX_PEERS = 4;
    // Android remains available through its foreground service, so sparse
    // compatibility heartbeats are sufficient. WebRTC peers carry the actual
    // files and control cache traffic between these reports.
    private static final long HEARTBEAT_MS = 10L * 60L * 1000L;
    private static final long DISCOVERY_MS = 10L * 60L * 1000L;
    private static final long AUTH_REFRESH_MARGIN_MS = 120_000L;
    private static final AtomicBoolean WEBRTC_INITIALIZED = new AtomicBoolean(false);

    private final Context context;
    private final PolymaiAppBackgroundWorker.Configuration configuration;
    private final String nodeId;
    private final String failureDomainId;
    private final PolymaiAppMeshCrypto.Identity identity;
    private final PolymaiAppMeshStore store;
    private final AtomicBoolean stopRequested;
    private final Reporter reporter;
    private final OkHttpClient http;
    private final PolymaiAppMeshCrypto.SecurePreferences secrets;
    private final Map<String, PolymaiAppMeshPeer> peers = new ConcurrentHashMap<>();
    private final Set<String> seenSignals = Collections.synchronizedSet(new HashSet<>());
    private final AtomicLong signalReference = new AtomicLong(1);

    private volatile String accessToken;
    private volatile long accessExpiresAt;
    private volatile String authUserId;
    private volatile WebSocket realtime;
    private volatile String realtimeTopic;
    private volatile long lastHeartbeatAt;
    private volatile String lastError;
    private volatile List<org.webrtc.PeerConnection.IceServer> iceServers = Collections.emptyList();
    private volatile boolean bootstrapComplete;

    PolymaiAppMeshClient(
        Context context,
        PolymaiAppBackgroundWorker.Configuration configuration,
        String nodeId,
        String failureDomainId,
        PolymaiAppMeshCrypto.Identity identity,
        PolymaiAppMeshStore store,
        AtomicBoolean stopRequested,
        Reporter reporter
    ) {
        this.context = context.getApplicationContext();
        this.configuration = configuration;
        this.nodeId = nodeId;
        this.failureDomainId = failureDomainId;
        this.identity = identity;
        this.store = store;
        this.stopRequested = stopRequested;
        this.reporter = reporter;
        this.secrets = new PolymaiAppMeshCrypto.SecurePreferences(context);
        this.bootstrapComplete = "true".equals(secrets.get("mesh_bootstrap_complete_v3"));
        this.http = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(45, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build();
    }

    void run() throws Exception {
        initializeWebRtc();
        long nextHeartbeat = 0;
        long nextDiscovery = 0;
        long retryDelay = 2_000L;
        boolean registered = false;
        boolean announcedRunning = false;
        while (!stopRequested.get() && !Thread.currentThread().isInterrupted()) {
            long now = System.currentTimeMillis();
            try {
                if (!bootstrapComplete) {
                    if (accessToken == null || accessExpiresAt - now < AUTH_REFRESH_MARGIN_MS) {
                        authenticate();
                        if (realtime != null) reconnectRealtime();
                    }
                    if (!registered) {
                        refreshIceServers();
                        registerNode();
                        registered = true;
                        nextHeartbeat = 0;
                        nextDiscovery = 0;
                    }
                    if (realtime == null) connectRealtime();
                    if (now >= nextHeartbeat) {
                        heartbeat();
                        nextHeartbeat = now + HEARTBEAT_MS;
                    }
                    if (now >= nextDiscovery) {
                        discoverAndConnect();
                        nextDiscovery = now + DISCOVERY_MS;
                    }
                }
                prunePeers();
                if (!announcedRunning) {
                    if (bootstrapComplete && peerCount() == 0) reporter.update("Waiting for an app mesh handoff");
                    else reporter.update(configuration.anchorEnabled ? "Backbone running" : "Mesh node running");
                    announcedRunning = true;
                }
                retryDelay = 2_000L;
                Thread.sleep(1000L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw interrupted;
            } catch (Exception error) {
                lastError = safeMessage(error);
                announcedRunning = false;
                reporter.update("Waiting for network · retrying");
                WebSocket failedSocket = realtime;
                realtime = null;
                if (failedSocket != null) failedSocket.cancel();
                sleepInterruptibly(retryDelay);
                retryDelay = Math.min(60_000L, retryDelay * 2L);
            }
        }
    }

    private void initializeWebRtc() {
        if (!WEBRTC_INITIALIZED.compareAndSet(false, true)) return;
        try {
            org.webrtc.PeerConnectionFactory.initialize(
                org.webrtc.PeerConnectionFactory.InitializationOptions.builder(context)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions()
            );
        } catch (RuntimeException error) {
            WEBRTC_INITIALIZED.set(false);
            throw error;
        }
    }

    int peerCount() {
        int connected = 0;
        for (PolymaiAppMeshPeer peer : peers.values()) if (peer.isConnected()) connected++;
        return connected;
    }

    long lastHeartbeatAt() { return lastHeartbeatAt; }
    String lastError() { return lastError; }
    String nodeId() { return nodeId; }
    PolymaiAppMeshStore store() { return store; }
    boolean isAnchor() { return configuration.anchorEnabled; }
    boolean isControlParticipant() { return true; }
    Context context() { return context; }

    void sendSignal(String recipientNodeId, String kind, JSONObject payload) throws Exception {
        JSONObject signal = new JSONObject()
            .put("signalId", UUID.randomUUID().toString())
            .put("fromNodeId", nodeId)
            .put("toNodeId", recipientNodeId)
            .put("type", kind)
            .put("payload", payload)
            .put("sentAt", System.currentTimeMillis());
        if (bootstrapComplete) {
            PolymaiAppMeshPeer direct = peers.get(recipientNodeId);
            if (direct != null && direct.isConnected()) {
                direct.sendRelaySignal(signal);
                return;
            }
            for (PolymaiAppMeshPeer peer : peers.values()) {
                if (peer != null && peer.isConnected()) {
                    peer.sendRelaySignal(signal);
                    return;
                }
            }
            throw new IllegalStateException("No mesh route is available for signaling.");
        }
        JSONObject args = new JSONObject()
            .put("p_sender_node_id", nodeId)
            .put("p_recipient_node_id", recipientNodeId)
            .put("p_kind", kind)
            .put("p_payload", signal);
        Object accepted = rpc("send_mesh_signal", args);
        if (!(accepted instanceof Boolean) || !((Boolean) accepted)) throw new IllegalStateException("Signaling recipient is unavailable.");
    }

    void peerClosed(String peerId) {
        PolymaiAppMeshPeer current = peers.get(peerId);
        if (current != null && current.isClosed()) peers.remove(peerId, current);
    }

    void peerConnected(String peerId) {
        if (bootstrapComplete) return;
        // The anonymous node row exists only so Patient Zero can complete the
        // first WebRTC handshake. Retire it once a direct route is verified;
        // never retry the hosted cleanup at the cost of reopening bootstrap.
        try {
            if (accessToken != null) restArray("DELETE", "nodes?id=eq." + nodeId, null, "return=minimal");
        } catch (Exception ignored) {}
        bootstrapComplete = true;
        try {
            secrets.put("mesh_bootstrap_complete_v3", "true");
            secrets.put("supabase_refresh_token", null);
        } catch (Exception error) {
            lastError = safeMessage(error);
        }
        WebSocket socket = realtime;
        realtime = null;
        if (socket != null) socket.close(1000, "Mesh route verified");
        accessToken = null;
        accessExpiresAt = 0;
        authUserId = null;
        reporter.update("Mesh-only · " + peerCount() + " peers");
    }

    void routeRelayedSignal(JSONObject signal, String relayPeerId) {
        if (signal == null) return;
        String destination = signal.optString("toNodeId", "");
        if (nodeId.equals(destination)) {
            handleSignal(signal);
            return;
        }
        PolymaiAppMeshPeer target = peers.get(destination);
        if (target != null && target.isConnected() && !destination.equals(relayPeerId)) target.sendRelaySignal(signal);
    }

    boolean authorizeAndDelete(String shardHash, JSONObject authorization) {
        try {
            if (!verifyDeletionAuthorization(authorization, nodeId, shardHash)) return false;
            return store.deleteShard(shardHash);
        } catch (Exception error) {
            lastError = safeMessage(error);
            return false;
        }
    }

    void announceFragment(String shardHash) {
        // The sending peer records the acknowledged placement in the signed
        // mesh catalog. Native storage never publishes shard metadata to the
        // hosted bootstrap service.
    }

    private void authenticate() throws Exception {
        String refresh = secrets.get("supabase_refresh_token");
        JSONObject result = null;
        if (refresh != null && !refresh.isEmpty()) {
            try {
                result = authRequest("/auth/v1/token?grant_type=refresh_token", new JSONObject().put("refresh_token", refresh));
            } catch (Exception ignored) {}
        }
        if (result == null) result = authRequest("/auth/v1/signup", new JSONObject());
        accessToken = result.getString("access_token");
        String nextRefresh = result.optString("refresh_token", "");
        if (!nextRefresh.isEmpty()) secrets.put("supabase_refresh_token", nextRefresh);
        authUserId = result.optJSONObject("user") == null ? null : result.optJSONObject("user").optString("id", null);
        accessExpiresAt = System.currentTimeMillis() + Math.max(60L, result.optLong("expires_in", 3600L)) * 1000L;
        if (authUserId == null) throw new IllegalStateException("Anonymous coordination session did not include a user id.");
    }

    private JSONObject authRequest(String path, JSONObject body) throws Exception {
        Request request = new Request.Builder()
            .url(configuration.supabaseUrl + path)
            .header("apikey", configuration.publishableKey)
            .post(RequestBody.create(body.toString(), JSON))
            .build();
        return executeObject(request);
    }

    private void registerNode() throws Exception {
        PolymaiAppMeshStore.Stats stats = store.stats();
        JSONObject values = nodeValues(stats, true);
        restArray("POST", "nodes?on_conflict=id", values, "resolution=merge-duplicates,return=representation");
    }

    private JSONObject nodeValues(PolymaiAppMeshStore.Stats stats, boolean includeIdentity) throws JSONException {
        long now = System.currentTimeMillis();
        JSONObject values = new JSONObject();
        if (includeIdentity) {
            values.put("id", nodeId);
            values.put("supabase_auth_id", authUserId);
            values.put("device_public_key", identity.encodedPublicKey);
            values.put("failure_domain_id", "android-app:" + failureDomainId);
        }
        values.put("vault_id", configuration.vaultId == null || configuration.vaultId.isEmpty() ? JSONObject.NULL : configuration.vaultId);
        values.put("device_label", configuration.label);
        values.put("status", "online");
        values.put("capacity_bytes", configuration.capacityBytes);
        values.put("used_bytes", Math.min(configuration.capacityBytes, stats.shardBytes));
        values.put("last_seen_at", iso(now));
        values.put("survival_mode", true);
        values.put("lifecycle_state", "backgrounded");
        values.put("lease_expires_at", iso(now + 15L * 60L * 1000L));
        values.put("wake_lock_active", false);
        values.put("coordination_protocol_version", 3);
        values.put("anchor_protocol_version", configuration.anchorEnabled ? 3 : 0);
        values.put("anchor_control_capacity_bytes", configuration.controlCapacityBytes);
        values.put("anchor_control_used_bytes", stats.controlBytes);
        values.put("anchor_connected_nodes", peerCount());
        values.put("coordination_mode", configuration.anchorEnabled && peerCount() > 0 ? "hybrid" : "supabase-primary");
        values.put("last_anchor_report_at", configuration.anchorEnabled ? iso(now) : JSONObject.NULL);
        if (configuration.countryCode != null) values.put("country_code", configuration.countryCode);
        if (configuration.regionCode != null) values.put("region_code", configuration.regionCode);
        if (configuration.networkDomainHash != null) values.put("network_domain_hash", configuration.networkDomainHash);
        return values;
    }

    private void heartbeat() throws Exception {
        PolymaiAppMeshStore.Stats stats = store.stats();
        restArray("PATCH", "nodes?id=eq." + nodeId, nodeValues(stats, false), "return=minimal");
        lastHeartbeatAt = System.currentTimeMillis();
        lastError = null;
        reporter.update((configuration.anchorEnabled ? "Backbone" : "Mesh node") + " · " + peerCount() + " peers");
    }

    private void refreshIceServers() {
        List<org.webrtc.PeerConnection.IceServer> parsed = new ArrayList<>();
        appendIceServers(parsed, configuration.iceServers);
        if (parsed.isEmpty()) parsed.add(org.webrtc.PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
        iceServers = Collections.unmodifiableList(parsed);
    }

    private static void appendIceServers(List<org.webrtc.PeerConnection.IceServer> output, JSONArray source) {
        if (source == null) return;
        for (int index = 0; index < source.length() && output.size() < 12; index++) {
            JSONObject row = source.optJSONObject(index);
            if (row == null) continue;
            List<String> urls = new ArrayList<>();
            Object raw = row.opt("urls");
            if (raw instanceof JSONArray) {
                JSONArray array = (JSONArray) raw;
                for (int item = 0; item < array.length(); item++) if (validIceUrl(array.optString(item))) urls.add(array.optString(item));
            } else if (validIceUrl(String.valueOf(raw))) urls.add(String.valueOf(raw));
            if (urls.isEmpty()) continue;
            org.webrtc.PeerConnection.IceServer.Builder builder = org.webrtc.PeerConnection.IceServer.builder(urls);
            if (!row.optString("username", "").isEmpty()) builder.setUsername(row.optString("username"));
            if (!row.optString("credential", "").isEmpty()) builder.setPassword(row.optString("credential"));
            output.add(builder.createIceServer());
        }
    }

    private static boolean validIceUrl(String value) {
        return value != null && value.matches("(?i)^(stun|stuns|turn|turns):[^\\s]{3,512}$");
    }

    private void discoverAndConnect() throws Exception {
        Object raw = rpc("discover_bootstrap_gateways", new JSONObject()
            .put("p_node_id", nodeId)
            .put("p_device_public_keys", configuration.bootstrapAuthorityKeys)
            .put("p_limit", Math.min(3, configuration.bootstrapAuthorityKeys.length())));
        if (!(raw instanceof JSONArray)) return;
        JSONArray candidates = (JSONArray) raw;
        for (int index = 0; index < candidates.length() && peers.size() < MAX_PEERS; index++) {
            JSONObject row = candidates.optJSONObject(index);
            if (row == null) continue;
            String peerId = row.optString("id", "");
            if (peerId.isEmpty() || peerId.equals(nodeId) || row.optInt("coordination_protocol_version", 0) != 3) continue;
            peers.computeIfAbsent(peerId, id -> {
                try {
                    PolymaiAppMeshPeer peer = new PolymaiAppMeshPeer(this, id, iceServers);
                    peer.start(nodeId.compareTo(id) < 0);
                    return peer;
                } catch (Exception error) {
                    lastError = safeMessage(error);
                    return null;
                }
            });
        }
    }

    private void prunePeers() {
        for (Map.Entry<String, PolymaiAppMeshPeer> entry : new ArrayList<>(peers.entrySet())) {
            if (entry.getValue() == null || entry.getValue().isClosed()) peers.remove(entry.getKey(), entry.getValue());
        }
    }

    private void connectRealtime() throws Exception {
        Object rawTopic = rpc("get_node_signal_topic", new JSONObject().put("p_node_id", nodeId));
        if (!(rawTopic instanceof String) || !String.valueOf(rawTopic).matches("^[a-f0-9]{64}$")) throw new IllegalStateException("No recipient signaling topic was issued.");
        String token = String.valueOf(rawTopic);
        realtimeTopic = "realtime:mesh-signal:" + token;
        URI base = new URI(configuration.supabaseUrl);
        String wsScheme = "https".equalsIgnoreCase(base.getScheme()) ? "wss" : "ws";
        String url = wsScheme + "://" + base.getAuthority() + "/realtime/v1/websocket?apikey=" + configuration.publishableKey + "&vsn=1.0.0";
        CountDownLatch joined = new CountDownLatch(1);
        Request request = new Request.Builder().url(url).header("Authorization", "Bearer " + accessToken).build();
        realtime = http.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) {
                try {
                    JSONObject config = new JSONObject()
                        .put("broadcast", new JSONObject().put("ack", false).put("self", false))
                        .put("presence", new JSONObject().put("key", ""))
                        .put("postgres_changes", new JSONArray())
                        .put("private", false);
                    socket.send(phoenix(nextRef(), realtimeTopic, "phx_join", new JSONObject().put("config", config)));
                } catch (JSONException error) {
                    lastError = safeMessage(error);
                    joined.countDown();
                    socket.cancel();
                }
            }
            @Override public void onMessage(WebSocket socket, String text) {
                try {
                    JSONArray frame = new JSONArray(text);
                    if (frame.length() < 5) return;
                    String event = frame.optString(3, "");
                    JSONObject payload = frame.optJSONObject(4);
                    if ("phx_reply".equals(event) && payload != null && "ok".equals(payload.optString("status"))) joined.countDown();
                    if ("broadcast".equals(event) && payload != null && "signal".equals(payload.optString("event"))) handleSignal(payload.optJSONObject("payload"));
                } catch (Exception ignored) {}
            }
            @Override public void onFailure(WebSocket socket, Throwable error, Response response) {
                lastError = safeMessage(error);
                if (realtime == socket) realtime = null;
                joined.countDown();
            }
            @Override public void onClosed(WebSocket socket, int code, String reason) {
                if (realtime == socket) realtime = null;
            }
        });
        if (!joined.await(8, TimeUnit.SECONDS) || realtime == null) {
            WebSocket pending = realtime;
            realtime = null;
            if (pending != null) pending.cancel();
            throw new IllegalStateException("Realtime signaling did not become ready.");
        }
    }

    private void reconnectRealtime() throws Exception {
        WebSocket previous = realtime;
        realtime = null;
        if (previous != null) previous.close(1000, "Session refreshed");
        connectRealtime();
    }

    private void handleSignal(JSONObject signal) {
        if (signal == null || !nodeId.equals(signal.optString("toNodeId", ""))) return;
        String signalId = signal.optString("signalId", "");
        if (!signalId.isEmpty() && !seenSignals.add(signalId)) return;
        if (seenSignals.size() > 512) seenSignals.clear();
        String from = signal.optString("fromNodeId", "");
        String type = signal.optString("type", "");
        if (from.isEmpty() || from.equals(nodeId) || !type.matches("^(offer|answer|ice|hello)$")) return;
        PolymaiAppMeshPeer peer = peers.computeIfAbsent(from, id -> {
            try { return new PolymaiAppMeshPeer(this, id, iceServers); }
            catch (Exception error) { lastError = safeMessage(error); return null; }
        });
        if (peer != null) peer.onSignal(type, signal.optJSONObject("payload"));
    }

    private Object rpc(String name, JSONObject body) throws Exception {
        Request request = authorized(schema(new Request.Builder()
            .url(configuration.supabaseUrl + "/rest/v1/rpc/" + name)
            .post(RequestBody.create(body.toString(), JSON)), true)).build();
        try (Response response = http.newCall(request).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new IllegalStateException("Coordination RPC failed (" + response.code() + ").");
            String trimmed = text.trim();
            if (trimmed.startsWith("[")) return new JSONArray(trimmed);
            if (trimmed.startsWith("{")) return new JSONObject(trimmed);
            if ("true".equals(trimmed) || "false".equals(trimmed)) return Boolean.valueOf(trimmed);
            if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) return new JSONArray("[" + trimmed + "]").getString(0);
            return trimmed;
        }
    }

    private JSONArray restArray(String method, String resource, JSONObject body, String prefer) throws Exception {
        Request.Builder builder = schema(new Request.Builder().url(configuration.supabaseUrl + "/rest/v1/" + resource), body != null || !"GET".equals(method));
        if (prefer != null) builder.header("Prefer", prefer);
        RequestBody requestBody = body == null ? null : RequestBody.create(body.toString(), JSON);
        if ("POST".equals(method)) builder.post(requestBody);
        else if ("PATCH".equals(method)) builder.patch(requestBody);
        else if ("DELETE".equals(method)) builder.delete();
        else builder.get();
        try (Response response = http.newCall(authorized(builder).build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) throw new IllegalStateException("Coordination request failed (" + response.code() + ").");
            return text.trim().startsWith("[") ? new JSONArray(text) : new JSONArray();
        }
    }

    private Request.Builder authorized(Request.Builder builder) {
        return builder.header("apikey", configuration.publishableKey).header("Authorization", "Bearer " + accessToken);
    }

    private Request.Builder schema(Request.Builder builder, boolean writing) {
        builder.header("Accept-Profile", SCHEMA);
        if (writing) builder.header("Content-Profile", SCHEMA);
        return builder;
    }

    private JSONObject executeObject(Request request) throws Exception {
        try (Response response = http.newCall(request).execute()) {
            String text = response.body() == null ? "{}" : response.body().string();
            if (!response.isSuccessful()) throw new IllegalStateException("Request failed (" + response.code() + ").");
            return new JSONObject(text);
        }
    }

    private long nextRef() { return signalReference.getAndIncrement(); }
    private static String phoenix(long reference, String topic, String event, JSONObject payload) {
        return new JSONArray().put(String.valueOf(reference)).put(String.valueOf(reference)).put(topic).put(event).put(payload).toString();
    }

    private static boolean verifyDeletionAuthorization(JSONObject authorization, String nodeId, String shardHash) {
        try {
            if (authorization == null || authorization.optInt("protocolVersion", 0) != 3) return false;
            if (!nodeId.equals(authorization.optString("nodeId")) || !shardHash.equals(authorization.optString("shardHash"))) return false;
            if (authorization.optLong("issuedAt", 0) > System.currentTimeMillis() + 300_000L) return false;
            String owner = authorization.optString("ownerPublicKey", "");
            String vault = authorization.optString("vaultId", "");
            if (!PolymaiAppMeshCrypto.hashHex(PolymaiAppMeshCrypto.base64UrlDecode(owner)).equals(vault)) return false;
            JSONObject core = PolymaiAppMeshCrypto.without(authorization, "signature");
            return PolymaiAppMeshCrypto.verify(owner, authorization.optString("signature"), PolymaiAppMeshCrypto.canonical(core).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception ignored) { return false; }
    }

    private static String joinJsonStrings(JSONArray values) throws Exception {
        List<String> output = new ArrayList<>();
        for (int index = 0; index < values.length(); index++) output.add(values.getString(index));
        return String.join(",", output);
    }

    private static String isoNow() { return iso(System.currentTimeMillis()); }
    private static String iso(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }
    private static String safeMessage(Throwable error) {
        String value = error == null ? null : error.getMessage();
        return value == null || value.trim().isEmpty() ? "Connection unavailable" : value.trim();
    }

    private void sleepInterruptibly(long millis) throws InterruptedException {
        long end = System.currentTimeMillis() + millis;
        while (!stopRequested.get() && System.currentTimeMillis() < end) Thread.sleep(Math.min(500L, end - System.currentTimeMillis()));
    }

    @Override public void close() {
        try {
            JSONObject offline = new JSONObject().put("status", "offline").put("lifecycle_state", "stopped").put("lease_expires_at", isoNow()).put("last_seen_at", isoNow());
            if (!bootstrapComplete && accessToken != null) restArray("PATCH", "nodes?id=eq." + nodeId, offline, "return=minimal");
        } catch (Exception ignored) {}
        WebSocket socket = realtime;
        realtime = null;
        if (socket != null) socket.close(1000, "Node stopped");
        for (PolymaiAppMeshPeer peer : peers.values()) if (peer != null) peer.close();
        peers.clear();
        http.dispatcher().executorService().shutdownNow();
        http.connectionPool().evictAll();
    }
}
