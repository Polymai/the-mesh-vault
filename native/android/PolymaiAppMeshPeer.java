package __POLYMAI_PACKAGE__;

import android.content.Context;
import android.os.PowerManager;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

import org.webrtc.DataChannel;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;

/** Data-only WebRTC peer implementing the browser protocol-v3 wire format. */
final class PolymaiAppMeshPeer implements AutoCloseable {
    private static final int PACKET_BYTES = 32 * 1024;
    private static final int MAX_MESSAGE_BYTES = 64 * 1024;
    private static final int MAX_SHARD_BYTES = 32 * 1024 * 1024;
    private static final int MAX_CHUNKS = (MAX_SHARD_BYTES + PACKET_BYTES - 1) / PACKET_BYTES;
    private static final long BUFFER_LIMIT = 1024L * 1024L;
    private static final Object FACTORY_LOCK = new Object();
    private static PeerConnectionFactory factory;

    private final PolymaiAppMeshClient client;
    private final String peerId;
    private final PeerConnection connection;
    private final ExecutorService signaling = Executors.newSingleThreadExecutor();
    private final ExecutorService transfers = Executors.newFixedThreadPool(2);
    private final Map<String, IncomingBytes> shards = new HashMap<>();
    private final Map<String, IncomingText> manifests = new HashMap<>();
    private final Map<String, IncomingBytes> proofs = new HashMap<>();
    private final List<IceCandidate> pendingIce = new ArrayList<>();
    private final Object sendMonitor = new Object();
    private final AtomicBoolean closed = new AtomicBoolean(false);
    private final Set<String> cancelledRequests = ConcurrentHashMap.newKeySet();
    private volatile DataChannel channel;
    private volatile boolean remoteDescriptionSet;
    private volatile boolean makingOffer;

    PolymaiAppMeshPeer(PolymaiAppMeshClient client, String peerId, List<PeerConnection.IceServer> iceServers) {
        this.client = client;
        this.peerId = peerId;
        PeerConnection.RTCConfiguration rtc = new PeerConnection.RTCConfiguration(iceServers);
        rtc.iceCandidatePoolSize = 4;
        rtc.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        PeerConnection created = factory(client.context()).createPeerConnection(rtc, observer());
        if (created == null) throw new IllegalStateException("Android could not create a WebRTC peer connection.");
        this.connection = created;
    }

    void start(boolean initiator) throws Exception {
        if (initiator) createChannelAndOffer();
        else client.sendSignal(peerId, "hello", new JSONObject());
    }

    void onSignal(String type, JSONObject payload) {
        if (closed.get()) return;
        signaling.execute(() -> {
            try {
                if ("hello".equals(type)) {
                    if (client.nodeId().compareTo(peerId) < 0 && channel == null) createChannelAndOffer();
                    return;
                }
                if ("ice".equals(type)) {
                    if (payload == null) return;
                    IceCandidate candidate = new IceCandidate(
                        payload.optString("sdpMid", null),
                        payload.optInt("sdpMLineIndex", 0),
                        payload.optString("candidate", "")
                    );
                    if (remoteDescriptionSet) connection.addIceCandidate(candidate);
                    else pendingIce.add(candidate);
                    return;
                }
                if (payload == null || !("offer".equals(type) || "answer".equals(type))) return;
                SessionDescription description = new SessionDescription(
                    "offer".equals(type) ? SessionDescription.Type.OFFER : SessionDescription.Type.ANSWER,
                    payload.optString("sdp", "")
                );
                boolean collision = "offer".equals(type) && (makingOffer || connection.signalingState() != PeerConnection.SignalingState.STABLE);
                boolean polite = client.nodeId().compareTo(peerId) > 0;
                if (collision && !polite) return;
                setRemote(description, () -> {
                    if ("offer".equals(type)) createAnswer();
                });
            } catch (Exception ignored) {}
        });
    }

    boolean isConnected() { return channel != null && channel.state() == DataChannel.State.OPEN; }
    boolean isClosed() { return closed.get() || connection.connectionState() == PeerConnection.PeerConnectionState.CLOSED; }

    private static PeerConnectionFactory factory(Context context) {
        synchronized (FACTORY_LOCK) {
            if (factory == null) factory = PeerConnectionFactory.builder().createPeerConnectionFactory();
            return factory;
        }
    }

    private PeerConnection.Observer observer() {
        return new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {}
            @Override public void onIceConnectionReceivingChange(boolean receiving) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
            @Override public void onIceCandidate(IceCandidate candidate) {
                try {
                    client.sendSignal(peerId, "ice", new JSONObject()
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex));
                } catch (Exception ignored) {}
            }
            @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
            @Override public void onAddStream(MediaStream stream) {}
            @Override public void onRemoveStream(MediaStream stream) {}
            @Override public void onDataChannel(DataChannel dataChannel) { bind(dataChannel); }
            @Override public void onRenegotiationNeeded() {}
            @Override public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {}
            @Override public void onConnectionChange(PeerConnection.PeerConnectionState state) {
                if (state == PeerConnection.PeerConnectionState.FAILED || state == PeerConnection.PeerConnectionState.CLOSED) close();
            }
        };
    }

    private synchronized void createChannelAndOffer() {
        if (closed.get()) return;
        if (channel == null) bind(connection.createDataChannel("meshvault", new DataChannel.Init()));
        makingOffer = true;
        connection.createOffer(new SimpleSdpObserver() {
            @Override public void onCreateSuccess(SessionDescription description) {
                connection.setLocalDescription(new SimpleSdpObserver() {
                    @Override public void onSetSuccess() {
                        makingOffer = false;
                        try { client.sendSignal(peerId, "offer", sdpJson(description)); } catch (Exception ignored) {}
                    }
                    @Override public void onSetFailure(String error) { makingOffer = false; }
                }, description);
            }
            @Override public void onCreateFailure(String error) { makingOffer = false; }
        }, new MediaConstraints());
    }

    private void createAnswer() {
        connection.createAnswer(new SimpleSdpObserver() {
            @Override public void onCreateSuccess(SessionDescription description) {
                connection.setLocalDescription(new SimpleSdpObserver() {
                    @Override public void onSetSuccess() {
                        try { client.sendSignal(peerId, "answer", sdpJson(description)); } catch (Exception ignored) {}
                    }
                }, description);
            }
        }, new MediaConstraints());
    }

    private void setRemote(SessionDescription description, Runnable after) {
        connection.setRemoteDescription(new SimpleSdpObserver() {
            @Override public void onSetSuccess() {
                remoteDescriptionSet = true;
                for (IceCandidate candidate : new ArrayList<>(pendingIce)) connection.addIceCandidate(candidate);
                pendingIce.clear();
                after.run();
            }
        }, description);
    }

    private synchronized void bind(DataChannel next) {
        if (next == null) return;
        if (channel != null && channel != next && channel.state() != DataChannel.State.CLOSED) {
            next.close();
            next.dispose();
            return;
        }
        channel = next;
        next.registerObserver(new DataChannel.Observer() {
            @Override public void onBufferedAmountChange(long previousAmount) { synchronized (sendMonitor) { sendMonitor.notifyAll(); } }
            @Override public void onStateChange() {
                if (next.state() == DataChannel.State.CLOSED) client.peerClosed(peerId);
            }
            @Override public void onMessage(DataChannel.Buffer buffer) {
                if (buffer.binary || buffer.data.remaining() > MAX_MESSAGE_BYTES) return;
                byte[] bytes = new byte[buffer.data.remaining()];
                buffer.data.get(bytes);
                handleMessage(new String(bytes, StandardCharsets.UTF_8));
            }
        });
    }

    private void handleMessage(String encoded) {
        signaling.execute(() -> {
            try {
                if (encoded.getBytes(StandardCharsets.UTF_8).length > MAX_MESSAGE_BYTES) return;
                JSONObject message = new JSONObject(encoded);
                String type = message.optString("type", "");
                if ("ping".equals(type)) send(new JSONObject().put("type", "pong").put("pingId", message.optString("pingId")));
                else if ("shard-start".equals(type)) beginBytes(shards, message, "shardId", false);
                else if ("shard-chunk".equals(type)) acceptChunk(shards, message);
                else if ("shard-abort".equals(type)) shards.remove(message.optString("transferId"));
                else if ("shard-end".equals(type)) completeShard(message.optString("transferId"));
                else if ("shard-request".equals(type)) {
                    String shardId = message.optString("shardId");
                    String requestId = message.optString("requestId");
                    transfers.execute(() -> {
                        try { sendStoredShard(shardId, requestId); }
                        catch (Exception ignored) {}
                    });
                }
                else if ("shard-request-cancel".equals(type) && !message.optString("requestId").isEmpty()) cancelledRequests.add(message.optString("requestId"));
                else if ("shard-delete".equals(type)) {
                    boolean ok = client.authorizeAndDelete(message.optString("shardId"), message.optJSONObject("authorization"));
                    send(new JSONObject().put("type", "shard-deleted").put("requestId", message.optString("requestId")).put("ok", ok));
                }
                else if ("proof-request".equals(type)) sendProof(message.optString("shardId"), message.optString("requestId"));
                else if ("manifest-request".equals(type)) sendManifest(message.optString("manifestId"));
                else if ("manifest-start".equals(type)) beginText(manifests, message, "manifestId");
                else if ("manifest-chunk".equals(type)) acceptTextChunk(manifests, message);
                else if ("manifest-end".equals(type)) completeManifest(message.optString("transferId"));
                else if ("control-put".equals(type)) {
                    boolean ok = client.isControlParticipant() && client.store().putControl(message.optJSONObject("object"));
                    send(new JSONObject().put("type", "control-stored").put("requestId", message.optString("requestId")).put("ok", ok));
                }
                else if ("control-query".equals(type)) {
                    JSONArray objects = client.isControlParticipant() ? client.store().queryControls(message.optString("kind"), message.optString("lookupKey"), Math.min(20, message.optInt("limit", 20))) : new JSONArray();
                    sendBoundedControlResponse(message.optString("requestId"), objects);
                }
                else if ("relay-signal".equals(type)) client.routeRelayedSignal(message.optJSONObject("signal"), peerId);
            } catch (Exception ignored) {}
        });
    }

    private void beginBytes(Map<String, IncomingBytes> target, JSONObject message, String idField, boolean proof) {
        String transferId = proof ? message.optString("requestId") : message.optString("transferId");
        int count = message.optInt("chunks", 0);
        if (transferId.isEmpty() || count < 1 || count > MAX_CHUNKS) return;
        target.put(transferId, new IncomingBytes(message.optString(idField), message.optString("hash"), count, message.optInt("size", -1)));
    }

    private void acceptChunk(Map<String, IncomingBytes> target, JSONObject message) {
        String transferId = message.optString("transferId");
        IncomingBytes incoming = target.get(transferId);
        int index = message.optInt("index", -1);
        if (incoming == null || index < 0 || index >= incoming.chunks.length || incoming.chunks[index] != null) return;
        byte[] chunk = Base64.decode(message.optString("data", ""), Base64.DEFAULT);
        if (chunk.length > PACKET_BYTES) { target.remove(transferId); return; }
        incoming.chunks[index] = chunk;
    }

    private void completeShard(String transferId) throws Exception {
        IncomingBytes incoming = shards.remove(transferId);
        boolean ok = false;
        String error = null;
        if (incoming != null) {
            try (WakeLease ignored = WakeLease.acquire(client.context())) {
                byte[] bytes = incoming.combine();
                if (!PolymaiAppMeshCrypto.hashHex(bytes).equals(incoming.hash)) throw new SecurityException("Shard integrity verification failed.");
                client.store().putShard(incoming.id, bytes);
                client.announceFragment(incoming.id);
                ok = true;
            } catch (Exception failure) { error = failure.getMessage(); }
        }
        JSONObject response = new JSONObject().put("type", "shard-stored").put("transferId", transferId).put("ok", ok);
        if (error != null) response.put("error", error);
        send(response);
    }

    private void sendStoredShard(String shardId, String requestId) throws Exception {
        byte[] bytes = client.store().getShard(shardId);
        if (bytes == null) return;
        try (WakeLease ignored = WakeLease.acquire(client.context())) {
            sendBytes("shard", UUID.randomUUID().toString(), requestId, shardId, bytes);
        } finally {
            cancelledRequests.remove(requestId);
        }
    }

    private void sendProof(String shardId, String requestId) throws Exception {
        byte[] bytes = client.store().getShard(shardId);
        if (bytes == null) {
            send(new JSONObject().put("type", "proof-none").put("requestId", requestId));
            return;
        }
        try (WakeLease ignored = WakeLease.acquire(client.context())) { sendBytes("proof", null, requestId, shardId, bytes); }
    }

    private void sendBytes(String kind, String transferId, String requestId, String shardId, byte[] bytes) throws Exception {
        String hash = PolymaiAppMeshCrypto.hashHex(bytes);
        int count = Math.max(1, (bytes.length + PACKET_BYTES - 1) / PACKET_BYTES);
        JSONObject start = new JSONObject().put("type", kind + "-start").put("shardId", shardId).put("hash", hash).put("chunks", count);
        if ("shard".equals(kind)) start.put("transferId", transferId); else start.put("requestId", requestId).put("size", bytes.length);
        send(start);
        for (int index = 0; index < count; index++) {
            if ("shard".equals(kind) && cancelledRequests.remove(requestId)) {
                send(new JSONObject().put("type", "shard-abort").put("transferId", transferId));
                return;
            }
            int offset = index * PACKET_BYTES;
            int size = Math.min(PACKET_BYTES, bytes.length - offset);
            byte[] packet = new byte[size];
            System.arraycopy(bytes, offset, packet, 0, size);
            JSONObject chunk = new JSONObject().put("type", kind + "-chunk").put("index", index).put("data", Base64.encodeToString(packet, Base64.NO_WRAP));
            if ("shard".equals(kind)) chunk.put("transferId", transferId); else chunk.put("requestId", requestId);
            sendWithBackpressure(chunk);
        }
        JSONObject end = new JSONObject().put("type", kind + "-end");
        if ("shard".equals(kind)) end.put("transferId", transferId); else end.put("requestId", requestId);
        send(end);
    }

    private void beginText(Map<String, IncomingText> target, JSONObject message, String idField) {
        String transferId = message.optString("transferId");
        int count = message.optInt("chunks", 0);
        if (transferId.isEmpty() || count < 1 || count > 256) return;
        target.put(transferId, new IncomingText(message.optString(idField), count));
    }

    private void acceptTextChunk(Map<String, IncomingText> target, JSONObject message) {
        IncomingText incoming = target.get(message.optString("transferId"));
        int index = message.optInt("index", -1);
        String data = message.optString("data", "");
        if (incoming == null || index < 0 || index >= incoming.chunks.length || data.length() > PACKET_BYTES) return;
        incoming.chunks[index] = data;
    }

    private void completeManifest(String transferId) throws Exception {
        IncomingText incoming = manifests.remove(transferId);
        boolean ok = false;
        if (incoming != null) {
            try {
                JSONObject envelope = new JSONObject(new String(Base64.decode(incoming.combine(), Base64.DEFAULT), StandardCharsets.UTF_8));
                ok = client.store().putManifest(incoming.id, envelope);
            } catch (Exception ignored) {}
        }
        send(new JSONObject().put("type", "manifest-stored").put("transferId", transferId).put("ok", ok));
    }

    private void sendManifest(String manifestId) throws Exception {
        JSONObject envelope = client.store().getManifest(manifestId);
        if (envelope == null) {
            send(new JSONObject().put("type", "manifest-none").put("manifestId", manifestId));
            return;
        }
        String transferId = UUID.randomUUID().toString();
        String base64 = Base64.encodeToString(envelope.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        int count = Math.max(1, (base64.length() + PACKET_BYTES - 1) / PACKET_BYTES);
        send(new JSONObject().put("type", "manifest-start").put("transferId", transferId).put("manifestId", manifestId).put("chunks", count));
        for (int index = 0; index < count; index++) {
            sendWithBackpressure(new JSONObject().put("type", "manifest-chunk").put("transferId", transferId).put("index", index).put("data", base64.substring(index * PACKET_BYTES, Math.min(base64.length(), (index + 1) * PACKET_BYTES))));
        }
        send(new JSONObject().put("type", "manifest-end").put("transferId", transferId));
    }

    void sendRelaySignal(JSONObject signal) {
        try { send(new JSONObject().put("type", "relay-signal").put("signal", signal)); } catch (Exception ignored) {}
    }

    private void sendBoundedControlResponse(String requestId, JSONArray source) throws Exception {
        JSONArray bounded = new JSONArray();
        for (int index = 0; index < source.length() && bounded.length() < 20; index++) {
            bounded.put(source.get(index));
            if (new JSONObject().put("type", "control-response").put("requestId", requestId).put("objects", bounded).toString().length() > 48 * 1024) bounded.remove(bounded.length() - 1);
        }
        send(new JSONObject().put("type", "control-response").put("requestId", requestId).put("objects", bounded));
    }

    private void sendWithBackpressure(JSONObject message) throws Exception {
        DataChannel current = channel;
        long deadline = System.currentTimeMillis() + 45_000L;
        synchronized (sendMonitor) {
            while (current != null && current.bufferedAmount() > BUFFER_LIMIT && System.currentTimeMillis() < deadline) sendMonitor.wait(50L);
        }
        send(message);
    }

    private void send(JSONObject message) {
        DataChannel current = channel;
        if (current == null || current.state() != DataChannel.State.OPEN) return;
        byte[] bytes = message.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_MESSAGE_BYTES) throw new IllegalArgumentException("Peer message exceeds the protocol limit.");
        current.send(new DataChannel.Buffer(ByteBuffer.wrap(bytes), false));
    }

    private static JSONObject sdpJson(SessionDescription description) throws JSONException {
        return new JSONObject().put("type", description.type.canonicalForm()).put("sdp", description.description);
    }

    @Override public void close() {
        if (!closed.compareAndSet(false, true)) return;
        DataChannel current = channel;
        channel = null;
        if (current != null) { current.close(); current.dispose(); }
        connection.close();
        connection.dispose();
        signaling.shutdownNow();
        transfers.shutdownNow();
        try { signaling.awaitTermination(250, TimeUnit.MILLISECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        client.peerClosed(peerId);
    }

    private static class SimpleSdpObserver implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription description) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String error) {}
        @Override public void onSetFailure(String error) {}
    }

    private static final class IncomingBytes {
        final String id;
        final String hash;
        final byte[][] chunks;
        final int expectedSize;
        IncomingBytes(String id, String hash, int count, int expectedSize) {
            this.id = id; this.hash = hash; this.chunks = new byte[count][]; this.expectedSize = expectedSize;
        }
        byte[] combine() throws Exception {
            int size = 0;
            for (byte[] chunk : chunks) { if (chunk == null) throw new IllegalStateException("Incomplete transfer."); size += chunk.length; }
            if (size > MAX_SHARD_BYTES || (expectedSize >= 0 && size != expectedSize)) throw new IllegalStateException("Transfer size mismatch.");
            ByteArrayOutputStream output = new ByteArrayOutputStream(size);
            for (byte[] chunk : chunks) output.write(chunk);
            return output.toByteArray();
        }
    }

    private static final class IncomingText {
        final String id;
        final String[] chunks;
        IncomingText(String id, int count) { this.id = id; this.chunks = new String[count]; }
        String combine() {
            StringBuilder output = new StringBuilder();
            for (String chunk : chunks) { if (chunk == null) throw new IllegalStateException("Incomplete transfer."); output.append(chunk); }
            return output.toString();
        }
    }

    private static final class WakeLease implements AutoCloseable {
        private final PowerManager.WakeLock wakeLock;
        private WakeLease(PowerManager.WakeLock wakeLock) { this.wakeLock = wakeLock; }
        static WakeLease acquire(Context context) {
            PowerManager manager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            PowerManager.WakeLock lock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TheMeshVault:active-transfer");
            lock.setReferenceCounted(false);
            lock.acquire(120_000L);
            return new WakeLease(lock);
        }
        @Override public void close() { if (wakeLock.isHeld()) wakeLock.release(); }
    }
}
