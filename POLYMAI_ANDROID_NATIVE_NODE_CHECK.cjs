const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");

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
const backboneView = read("js/views/anchor-view.js");
const router = read("js/router.js");
const security = read("js/content/public-documents.js");
const nativeDoc = read("ANDROID_BACKGROUND_NODE.md");
const service = read("mobile/android-wrapper/native/android/PolymaiBackgroundService.java");
const plugin = read("mobile/android-wrapper/native/android/PolymaiBackgroundPlugin.java");
const manifest = read("mobile/android-wrapper/android/app/src/main/AndroidManifest.xml");
const androidBuild = read("mobile/android-wrapper/android/build.gradle");

const errors = [];
function requireCondition(condition, message) {
  if (!condition) errors.push(message);
}
function has(source, pattern) {
  return pattern instanceof RegExp ? pattern.test(source) : source.includes(pattern);
}
function digest(relative) {
  return nodeCrypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
}

requireCondition(contract.version === 2 && contract.bridgeApiVersion === 2, "background-worker contract must use v2/bridge API 2");
requireCondition(contract.workerSource === "native/android/PolymaiAppBackgroundWorker.java", "primary worker source is not bound");
requireCondition(Array.isArray(contract.workerSources) && contract.workerSources.length === 4, "all four native helper sources must be bound");
requireCondition(contract.workerSources.every((file) => fs.existsSync(path.join(root, file))), "a reviewed native helper source is missing");
const profile = JSON.parse(read("mobile/android-wrapper/android-profile.json"));
const boundSources = profile.backgroundWorker?.sourceFiles || [];
requireCondition(boundSources.length === 5 && boundSources.every((entry) => digest(entry.path) === entry.digest), "generated Android profile source digests must match the reviewed native sources");
requireCondition(profile.backgroundWorker?.workerSourceDigest === digest(contract.workerSource), "generated Android worker digest is stale");
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
requireCondition(has(client, "while (!stopRequested.get()") && has(client, "retryDelay = Math.min(60_000L") && has(client, "Waiting for network"), "native client must retry transient network/startup failures without exiting the service");
requireCondition(has(service, "catch (RuntimeException error)") && has(service, "while (!stopRequested.get()") && has(service, "Restarting background node"), "foreground service must contain blocked-start handling and a persistent worker restart loop");
requireCondition(has(plugin, "Android blocked the background node start") && has(plugin, "The Android background node could not be stopped"), "native bridge must report service lifecycle failures instead of crashing the app");
requireCondition((manifest.match(/android\.permission\.INTERNET/g) || []).length === 1, "Android manifest must declare INTERNET exactly once");
requireCondition(has(manifest, '<uses-feature android:name="android.hardware.camera" android:required="false" />'), "camera hardware must remain optional for non-camera Android devices");
requireCondition(has(androidBuild, "JavaLanguageVersion.of(21)") && has(androidBuild, "tasks.withType(JavaCompile)") && has(androidBuild, "tasks.withType(Test)"), "Android compilation and unit tests must select the required Java 21 toolchain");

requireCondition(has(bootstrap, "nativeNodeStatus") && has(bootstrap, "configureNativeNode") && has(bootstrap, "nativeActive ? { transient: true"), "browser/native lifecycle integration is incomplete");
requireCondition(has(bootstrap, "const browserCapacity = nativeActive ? 0") && has(bootstrap, "await updateNodeCapacity(0)"), "WebView storage role must not double-count native capacity");
requireCondition(has(settings, "Android background node") && has(settings, "Run with screen off") && has(settings, "Remove Android pieces"), "native Settings controls are incomplete");
requireCondition(has(backboneView, 'return "android-app"') && has(backboneView, 'return "mobile-web"') && has(backboneView, "Dedicated Windows server"), "Backbone page must select Android-native, mobile-browser and Windows-server flows explicitly");
requireCondition(has(backboneView, "data-anchor-native-toggle") && has(backboneView, "Install the Android app for screen-off operation"), "Android app and mobile browser must receive honest platform-specific controls");
requireCondition(has(router, "nativeNodeRenderKey") && has(router, "nativeNode: nativeNodeRenderKey(state.nativeNode)"), "native service status changes must trigger Settings and Backbone view updates");

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
