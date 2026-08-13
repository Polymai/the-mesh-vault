const fs = require("fs");
const path = require("path");

const root = __dirname;
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const contract = JSON.parse(read("native/android/background-worker.json"));
const worker = read("native/android/PolymaiAppBackgroundWorker.java");
const client = read("native/android/PolymaiAppMeshClient.java");
const peer = read("native/android/PolymaiAppMeshPeer.java");
const store = read("native/android/PolymaiAppMeshStore.java");
const crypto = read("native/android/PolymaiAppMeshCrypto.java");
const bridge = read("js/platform/native-node.js");
const bootstrap = read("js/bootstrap.js");
const settings = read("js/views/settings-view.js");
const security = read("js/content/public-documents.js");
const nativeDoc = read("ANDROID_BACKGROUND_NODE.md");

const errors = [];
function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}
function has(source, pattern) {
  return pattern instanceof RegExp ? pattern.test(source) : source.includes(pattern);
}

requireCondition(contract.version === 2 && contract.bridgeApiVersion === 2, "background-worker contract must use v2/bridge API 2");
requireCondition(contract.workerSource === "native/android/PolymaiAppBackgroundWorker.java", "primary worker source is not bound");
requireCondition(Array.isArray(contract.workerSources) && contract.workerSources.length === 4, "all four native helper sources must be bound");
requireCondition(contract.workerSources.every((file) => fs.existsSync(path.join(root, file))), "a reviewed native helper source is missing");
requireCondition(Array.isArray(contract.trustedOrigins) && contract.trustedOrigins.length === 1 && contract.trustedOrigins[0] === "https://themeshvault.com", "native bridge must trust only the production origin");
requireCondition(contract.restartOnBoot === true, "explicitly enabled nodes must support boot restart");

const dependencies = contract.gradleDependencies || [];
requireCondition(dependencies.includes("com.squareup.okhttp3:okhttp:4.12.0"), "OkHttp dependency must be pinned");
requireCondition(dependencies.includes("io.github.webrtc-sdk:android:144.7559.09"), "native WebRTC dependency must be pinned");
requireCondition(dependencies.includes("net.i2p.crypto:eddsa:0.3.0"), "Ed25519 dependency must be pinned");
requireCondition(dependencies.every((entry) => !/[+]|SNAPSHOT|latest/i.test(entry)), "native dependencies must not use floating versions");

for (const permission of [
  "android.permission.INTERNET",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.WAKE_LOCK",
  "android.permission.RECEIVE_BOOT_COMPLETED",
]) requireCondition(contract.androidPermissions.includes(permission), `missing required native permission ${permission}`);

for (const rejected of ["meshkey", "mnemonic", "rootseed", "privatekey", "segmentkey", "metadatakey", "deduplicationkey", "recoveryphrase", "recoverysecret"]) {
  requireCondition(worker.toLowerCase().includes(rejected), `native worker does not explicitly reject ${rejected}`);
}
requireCondition(has(worker, 'result.put("keysAccepted", false)'), "native status must prove that vault keys are not accepted");
requireCondition(!has(bridge, /meshKey|mnemonic|rootSeed|ownerPrivateKey|segmentKey|metadataKey|deduplicationKey/), "WebView bridge config appears to contain a vault secret");
requireCondition(has(bridge, "publishableKey: appConfig.anonKey") && has(bridge, "vaultId:"), "bridge is missing required public runtime configuration");
requireCondition(has(bridge, /PolymaiNativeBridge\\\/2/) && has(bridge, "const BRIDGE_VERSION = 2") && has(bridge, "snapshot.bridgeVersion"), "bridge API v2 detection/status is missing");

requireCondition(has(crypto, "AndroidKeyStore") && has(crypto, "AES/GCM/NoPadding"), "native operational secrets must be protected by Android Keystore AES-GCM");
requireCondition(has(crypto, "EdDSAPrivateKeySpec") && has(crypto, "EdDSAPublicKeySpec"), "native device Ed25519 identity is missing");
requireCondition(has(client, 'secrets.put("supabase_refresh_token"') && has(client, 'secrets.get("supabase_refresh_token"'), "native anonymous refresh token persistence is missing");

requireCondition(has(store, 'new File(context.getFilesDir(), "themeshvault-shards-v3")'), "native shards must use private app files");
requireCondition(has(store, 'hash + ".pending"') && has(store, "pending.renameTo(target)"), "native shard commit must use a pending file and final rename");
requireCondition(has(store, "hashHex(bytes).equals(hash)"), "native shard commit must verify SHA-256");
requireCondition(has(store, "controlLimitBytes") && has(store, "shardLimitBytes"), "native stores must be quota bounded");
requireCondition(has(store, "clearShards()"), "native shard removal path is missing");

requireCondition(has(peer, "private static final int PACKET_BYTES = 32 * 1024"), "native transport packet size must remain 32 KiB");
requireCondition(has(peer, "private static final int MAX_SHARD_BYTES = 32 * 1024 * 1024"), "native shard receive bound is missing");
requireCondition(has(peer, "BUFFER_LIMIT") && has(peer, "bufferedAmount()") && has(peer, "sendMonitor.wait"), "native WebRTC backpressure is missing");
for (const message of ["shard-start", "shard-request", "shard-request-cancel", "proof-request", "manifest-request", "control-put", "control-query"]) {
  requireCondition(peer.includes(`\"${message}\"`), `native WebRTC handler is missing ${message}`);
}
requireCondition(has(peer, "PowerManager.PARTIAL_WAKE_LOCK") && has(peer, "lock.acquire(120_000L)"), "Wake Lock must be partial and time bounded");
requireCondition(!has(worker + client + peer + store + crypto, /WebView|evaluateJavascript|addJavascriptInterface/), "native worker must not keep or drive the WebView");

requireCondition(has(client, "/auth/v1/signup") && has(client, "/auth/v1/token?grant_type=refresh_token"), "native anonymous Supabase lifecycle is incomplete");
requireCondition(has(client, "/realtime/v1/websocket") && has(client, "discover_node_candidates"), "native signaling/discovery client is incomplete");
requireCondition(has(client, "app717-meshvault-api") && has(client, "turn-credentials"), "native TURN configuration path is missing");

requireCondition(has(bootstrap, "nativeNodeStatus") && has(bootstrap, "configureNativeNode") && has(bootstrap, "nativeActive ? { transient: true"), "browser/native lifecycle integration is incomplete");
requireCondition(has(bootstrap, "const browserCapacity = nativeActive ? 0") && has(bootstrap, "await updateNodeCapacity(0)"), "WebView storage role must not double-count native capacity");
requireCondition(has(settings, "Android background node") && has(settings, "Run with screen off") && has(settings, "Remove Android pieces"), "native Settings controls are incomplete");

for (const claim of ["does not receive those secrets", "persistent notification", "separate private database", "Android Doze", "normal hosted web release"]) {
  requireCondition(security.includes(claim) || nativeDoc.includes(claim), `documentation is missing the native boundary: ${claim}`);
}

if (errors.length) {
  console.error("REPAIR NEEDED: Android native node contract");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("PASS: Android native node contract is secret-free, bounded, bridge-gated and documented.");
console.log("NOTE: Static checks do not replace APK/AAB compilation or physical screen-off testing.");
