package __POLYMAI_PACKAGE__;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.util.Iterator;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * App-owned Android node entry point. The generated foreground service owns
 * its lifecycle; this class owns only TheMeshVault protocol state.
 *
 * Deliberately forbidden here: Mesh Keys, owner seeds, file keys and segment
 * keys. The native node stores and serves opaque protocol-v3 shard bytes.
 */
public final class PolymaiAppBackgroundWorker implements PolymaiBackgroundWorker {
    static final int PROTOCOL_VERSION = 3;
    static final int BRIDGE_VERSION = 2;
    static final long MAX_CONTRIBUTION_BYTES = 250L * 1024L * 1024L * 1024L;
    static final long DEFAULT_CONTROL_BYTES = 100L * 1024L * 1024L;
    static final String PREFS = "themeshvault_native_node_public_v1";
    private static final String CONFIGURATION = "configuration";
    private static final String SNAPSHOT = "snapshot";
    private static final String NODE_ID = "node_id";
    private static final String FAILURE_DOMAIN_ID = "failure_domain_id";

    @Override
    public void configure(Context context, String configurationJson) throws Exception {
        if (configurationJson == null || configurationJson.trim().isEmpty()) {
            throw new IllegalArgumentException("Native node configuration is required.");
        }
        JSONObject raw = new JSONObject(configurationJson);
        rejectSecrets(raw, "configuration");
        Configuration configuration = Configuration.parse(raw);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(CONFIGURATION, configuration.toJson().toString())
            .apply();
    }

    @Override
    public String snapshot(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String saved = preferences.getString(SNAPSHOT, null);
        if (saved != null) return saved;
        JSONObject result = baseSnapshot(context);
        putUnchecked(result, "state", preferences.contains(CONFIGURATION) ? "stopped" : "setup-required");
        return result.toString();
    }

    @Override
    public long clearStorage(Context context) throws Exception {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String encoded = preferences.getString(CONFIGURATION, null);
        if (encoded == null) return 0;
        Configuration configuration = Configuration.parse(new JSONObject(encoded));
        try (PolymaiAppMeshStore store = new PolymaiAppMeshStore(
            context.getApplicationContext(), configuration.capacityBytes,
            configuration.anchorEnabled ? configuration.controlCapacityBytes : 25L * 1024L * 1024L
        )) {
            long removed = store.clearShards();
            preferences.edit().remove(SNAPSHOT).apply();
            return removed;
        }
    }

    @Override
    public void run(Context context, AtomicBoolean stopRequested, StatusReporter reporter) throws Exception {
        Context app = context.getApplicationContext();
        SharedPreferences preferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String encoded = preferences.getString(CONFIGURATION, null);
        if (encoded == null) throw new IllegalStateException("Open TheMeshVault and configure the native node first.");

        Configuration configuration = Configuration.parse(new JSONObject(encoded));
        PolymaiAppMeshCrypto.Identity identity = PolymaiAppMeshCrypto.loadOrCreateIdentity(app);
        String nodeId = persistentUuid(preferences, NODE_ID);
        String failureDomainId = persistentUuid(preferences, FAILURE_DOMAIN_ID);
        PolymaiAppMeshStore store = new PolymaiAppMeshStore(
            app,
            configuration.capacityBytes,
            configuration.anchorEnabled ? configuration.controlCapacityBytes : 25L * 1024L * 1024L
        );
        AtomicReference<PolymaiAppMeshClient> clientReference = new AtomicReference<>();
        PolymaiAppMeshClient client = new PolymaiAppMeshClient(
            app, configuration, nodeId, failureDomainId, identity, store,
            stopRequested,
            message -> {
                reporter.update(message);
                persistSnapshot(app, clientSnapshot(message, configuration, nodeId, identity, store, clientReference.get()));
            }
        );
        clientReference.set(client);

        reporter.update(configuration.anchorEnabled ? "Backbone starting" : "Mesh node starting");
        persistSnapshot(app, clientSnapshot("starting", configuration, nodeId, identity, store, client));
        try {
            client.run();
        } finally {
            client.close();
            persistSnapshot(app, clientSnapshot(stopRequested.get() ? "stopped" : "disconnected", configuration, nodeId, identity, store, client));
            store.close();
        }
    }

    private static JSONObject clientSnapshot(
        String state,
        Configuration configuration,
        String nodeId,
        PolymaiAppMeshCrypto.Identity identity,
        PolymaiAppMeshStore store,
        PolymaiAppMeshClient client
    ) {
        JSONObject result = new JSONObject();
        try {
            PolymaiAppMeshStore.Stats stats = store.stats();
            result.put("supported", true);
            result.put("bridgeVersion", BRIDGE_VERSION);
            result.put("protocolVersion", PROTOCOL_VERSION);
            result.put("state", state == null ? "running" : state);
            result.put("nodeId", nodeId);
            result.put("devicePublicKey", identity.encodedPublicKey);
            result.put("label", configuration.label);
            result.put("vaultId", configuration.vaultId == null || configuration.vaultId.isEmpty() ? JSONObject.NULL : configuration.vaultId);
            result.put("anchor", configuration.anchorEnabled);
            result.put("capacityBytes", configuration.capacityBytes);
            result.put("usedBytes", stats.shardBytes);
            result.put("shardCount", stats.shardCount);
            result.put("controlCount", stats.controlCount);
            result.put("controlBytes", stats.controlBytes);
            result.put("manifestCount", stats.manifestCount);
            result.put("peerCount", client == null ? 0 : client.peerCount());
            result.put("lastHeartbeatAt", client == null ? 0 : client.lastHeartbeatAt());
            result.put("lastError", client == null ? JSONObject.NULL : nullable(client.lastError()));
            result.put("updatedAt", System.currentTimeMillis());
            result.put("keysAccepted", false);
        } catch (Exception error) {
            putUnchecked(result, "state", "status-unavailable");
            putUnchecked(result, "lastError", error.getMessage());
        }
        return result;
    }

    private static JSONObject baseSnapshot(Context context) {
        JSONObject result = new JSONObject();
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        putUnchecked(result, "supported", true);
        putUnchecked(result, "bridgeVersion", BRIDGE_VERSION);
        putUnchecked(result, "protocolVersion", PROTOCOL_VERSION);
        putUnchecked(result, "nodeId", preferences.getString(NODE_ID, null));
        putUnchecked(result, "anchor", false);
        putUnchecked(result, "peerCount", 0);
        putUnchecked(result, "keysAccepted", false);
        return result;
    }

    private static void putUnchecked(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (JSONException error) {
            throw new IllegalStateException("Could not encode native node status field: " + key, error);
        }
    }

    private static Object nullable(String value) {
        return value == null || value.isEmpty() ? JSONObject.NULL : value;
    }

    private static void persistSnapshot(Context context, JSONObject snapshot) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(SNAPSHOT, snapshot.toString()).apply();
    }

    private static String persistentUuid(SharedPreferences preferences, String key) {
        String existing = preferences.getString(key, null);
        if (existing != null) {
            try { return UUID.fromString(existing).toString(); } catch (Exception ignored) {}
        }
        String created = UUID.randomUUID().toString();
        preferences.edit().putString(key, created).apply();
        return created;
    }

    private static void rejectSecrets(Object value, String path) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String normalized = key.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
                if (normalized.contains("meshkey") || normalized.contains("mnemonic")
                    || normalized.contains("rootseed") || normalized.contains("rootkey")
                    || normalized.contains("ownerseed") || normalized.contains("ownerprivate")
                    || normalized.contains("privatekey") || normalized.contains("filekey")
                    || normalized.contains("segmentkey") || normalized.contains("metadatakey")
                    || normalized.contains("deduplicationkey") || normalized.contains("dedupkey")
                    || normalized.contains("recoveryphrase") || normalized.contains("recoverysecret")) {
                    throw new SecurityException("Vault secrets are not accepted by the native node (" + path + "." + key + ").");
                }
                rejectSecrets(object.opt(key), path + "." + key);
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) rejectSecrets(array.opt(index), path + "[" + index + "]");
        }
    }

    static final class Configuration {
        final String supabaseUrl;
        final String publishableKey;
        final String functionsUrl;
        final String label;
        final String vaultId;
        final String countryCode;
        final String regionCode;
        final String networkDomainHash;
        final long capacityBytes;
        final long controlCapacityBytes;
        final boolean anchorEnabled;
        final boolean restartAfterBoot;
        final JSONArray iceServers;

        Configuration(
            String supabaseUrl, String publishableKey, String functionsUrl,
            String label, String vaultId, String countryCode, String regionCode,
            String networkDomainHash, long capacityBytes, long controlCapacityBytes,
            boolean anchorEnabled, boolean restartAfterBoot, JSONArray iceServers
        ) {
            this.supabaseUrl = supabaseUrl;
            this.publishableKey = publishableKey;
            this.functionsUrl = functionsUrl;
            this.label = label;
            this.vaultId = vaultId;
            this.countryCode = countryCode;
            this.regionCode = regionCode;
            this.networkDomainHash = networkDomainHash;
            this.capacityBytes = capacityBytes;
            this.controlCapacityBytes = controlCapacityBytes;
            this.anchorEnabled = anchorEnabled;
            this.restartAfterBoot = restartAfterBoot;
            this.iceServers = iceServers;
        }

        static Configuration parse(JSONObject input) throws Exception {
            if (input.optInt("protocolVersion", 0) != PROTOCOL_VERSION) {
                throw new IllegalArgumentException("The native node requires TheMeshVault protocol v3.");
            }
            String supabaseUrl = httpsOrigin(input.optString("supabaseUrl", ""), "Supabase URL");
            String functionsUrl = httpsOrigin(input.optString("functionsUrl", supabaseUrl + "/functions/v1"), "Functions URL");
            String publishableKey = input.optString("publishableKey", "").trim();
            if (publishableKey.length() < 20 || publishableKey.length() > 4096) throw new IllegalArgumentException("A public Supabase publishable key is required.");
            String label = bounded(input.optString("label", "Android node"), 1, 80, "Node label");
            String vaultId = input.optString("vaultId", "").trim();
            if (!vaultId.isEmpty() && !vaultId.matches("^[a-f0-9]{64}$")) throw new IllegalArgumentException("Vault ID must be a protocol-v3 hash.");
            String country = optionalCode(input.optString("countryCode", ""), "^[A-Z]{2}$", 2);
            String region = optionalCode(input.optString("regionCode", ""), "^[A-Za-z0-9_-]{2,16}$", 16);
            String network = input.optString("networkDomainHash", "").trim();
            if (!network.isEmpty() && (network.length() < 16 || network.length() > 96 || !network.matches("^[A-Za-z0-9_-]+$"))) throw new IllegalArgumentException("Network-domain hint is malformed.");
            long capacity = Math.max(0, input.optLong("capacityBytes", 0));
            if (capacity > MAX_CONTRIBUTION_BYTES) throw new IllegalArgumentException("Native storage is limited to 250 GB.");
            long controls = Math.max(25L * 1024L * 1024L, input.optLong("controlCapacityBytes", DEFAULT_CONTROL_BYTES));
            if (controls > 1024L * 1024L * 1024L) throw new IllegalArgumentException("Anchor control cache is too large.");
            JSONArray iceServers = input.optJSONArray("iceServers");
            if (iceServers == null) iceServers = new JSONArray();
            return new Configuration(
                supabaseUrl, publishableKey, functionsUrl, label, vaultId,
                emptyToNull(country), emptyToNull(region), emptyToNull(network),
                capacity, controls, input.optBoolean("anchorEnabled", false),
                input.optBoolean("restartAfterBoot", false), new JSONArray(iceServers.toString())
            );
        }

        JSONObject toJson() {
            JSONObject result = new JSONObject();
            putUnchecked(result, "protocolVersion", PROTOCOL_VERSION);
            putUnchecked(result, "supabaseUrl", supabaseUrl);
            putUnchecked(result, "publishableKey", publishableKey);
            putUnchecked(result, "functionsUrl", functionsUrl);
            putUnchecked(result, "label", label);
            putUnchecked(result, "vaultId", vaultId);
            putUnchecked(result, "countryCode", countryCode);
            putUnchecked(result, "regionCode", regionCode);
            putUnchecked(result, "networkDomainHash", networkDomainHash);
            putUnchecked(result, "capacityBytes", capacityBytes);
            putUnchecked(result, "controlCapacityBytes", controlCapacityBytes);
            putUnchecked(result, "anchorEnabled", anchorEnabled);
            putUnchecked(result, "restartAfterBoot", restartAfterBoot);
            putUnchecked(result, "iceServers", iceServers);
            return result;
        }

        private static String httpsOrigin(String value, String label) throws Exception {
            URI uri = new URI(value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null) {
                throw new IllegalArgumentException(label + " must be a credential-free HTTPS URL.");
            }
            return uri.toString().replaceAll("/+$", "");
        }

        private static String bounded(String value, int min, int max, String label) {
            String normalized = value == null ? "" : value.trim();
            if (normalized.length() < min || normalized.length() > max) throw new IllegalArgumentException(label + " is invalid.");
            return normalized;
        }

        private static String optionalCode(String value, String pattern, int max) {
            String normalized = value == null ? "" : value.trim();
            if (!normalized.isEmpty() && (normalized.length() > max || !normalized.matches(pattern))) throw new IllegalArgumentException("Location hint is malformed.");
            return normalized;
        }

        private static String emptyToNull(String value) { return value == null || value.isEmpty() ? null : value; }
    }
}
