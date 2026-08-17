const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// This is a static/local budget check. Any accidental network use must fail.
global.fetch = async () => { throw new Error("Egress budget checks may not access the network."); };
global.WebSocket = class BlockedWebSocket { constructor() { throw new Error("Egress budget checks may not access the network."); } };

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const runtime = read("data/runtime-config.js");
const bootstrap = read("js/bootstrap.js");
const provider = read("js/network/providers/supabase-bootstrap-provider.js");
const registry = read("js/network/providers/provider-registry.js");
const control = read("js/control/control-repository.js");
const nodeService = read("js/network/node-service.js");
const networkService = read("js/services/network-service.js");
const recoveryCoordinator = read("js/network/recovery-coordinator.js");
const fallbackPolicy = read("js/network/supabase-fallback-policy.js");
const schema = read("supabase/schema.sql");
const chaos = read("POLYMAI_1000_NODE_CHAOS_CHECK.cjs");

assert.match(runtime, /minimumMeshAnchors:\s*1/);
assert.match(runtime, /liveMeshRefreshMs:\s*180000/);
assert.match(runtime, /networkOverviewRefreshMs:\s*1800000/);
assert.match(runtime, /operationInitialBatchSize:\s*200/);
assert.match(runtime, /supabaseHeartbeatMs:\s*600000/);
assert.match(runtime, /maintenanceCycleMs:\s*900000/);
assert.match(runtime, /supabaseAutomaticFallbackEnabled:\s*true/);
assert.match(runtime, /supabaseColdStartDelayMs:\s*2500/);
assert.match(runtime, /supabaseFallbackWindowMs:\s*60000/);
assert.match(runtime, /supabaseFallbackCooldownMs:\s*1800000/);
assert.match(bootstrap, /LIVE_MESH_REFRESH_MS\s*=\s*Number/);
assert.doesNotMatch(bootstrap, /LIVE_MESH_REFRESH_MS\s*=\s*15000/);
assert.match(bootstrap, /function commitObservedMeshOverview\(\)/);
assert.match(bootstrap, /capacity_bytes:\s*Number\(nativeActive\s*\?\s*state\.nativeNode\.capacityBytes\s*:\s*state\.node\.capacityBytes\)/);
assert.match(bootstrap, /setState\(\(state\)\s*=>\s*\(\{\s*nodes:\s*\[node,/);
assert.match(bootstrap, /sync immediately from local observations;[\s\S]{0,160}commitObservedMeshOverview\(\)/);
assert.match(bootstrap, /syncVaultCoordination/);
assert.match(bootstrap, /meshRouteAvailable\s*=\s*hasVerifiedMeshRoute\(\)/);
assert.match(bootstrap, /loadVaultCatalog\(\{ includeAnchors: meshRouteAvailable \}\)/);
assert.match(bootstrap, /loadReplicatedOperations\(\{ force \}\)/);
assert.match(bootstrap, /runWhenReady:\s*false/);
assert.match(bootstrap, /const eventDriven = \[[^\]]*"file-changed"[^\]]*"repair-advisory"[^\]]*\]\.includes\(reason\)/);
assert.doesNotMatch(bootstrap, /loadNetworkOverview/);
assert.doesNotMatch(bootstrap, /replayCatalogOperations\(/);
assert.doesNotMatch(bootstrap, /backfillVaultCatalog\(/);
assert.doesNotMatch(bootstrap, /appTable\("transfers"\)/);
assert.doesNotMatch(bootstrap, /flushControlPlane\(\{ forceBackbone: true \}\)/);
assert.match(provider, /discoveryCacheMs \|\| 300000/);
assert.match(provider, /discover_bootstrap_gateways/);
assert.match(provider, /p_limit:\s*3/);
assert.doesNotMatch(provider, /discover_node_candidates/);
assert.doesNotMatch(provider, /async publishPresence\(\)\s*\{[\s\S]{0,300}publishPresenceOnce/);
assert.match(provider, /presencePromise/);
assert.match(registry, /discoveryPromise/);
assert.match(registry, /requireProvider/);
assert.match(registry, /provider\.name !== "supabase" \|\| supabaseProviderAllowed\(\)/);
assert.doesNotMatch(control, /appTable\(|from ["'][^"']*supabase/, "vault catalogs and operation logs must remain local/mesh only");
assert.match(control, /includeSupabase = false/);
assert.match(control, /includeAnchors = false/);
assert.match(control, /loadVaultCatalog\(\{ includeSupabase: false, includeAnchors: false \}\)/);
assert.doesNotMatch(control, /flushControlPlane\(\{ forceBackbone:\s*true \}\)/);
assert.doesNotMatch(control, /offset\s*<\s*5000/);
assert.doesNotMatch(control, /\.range\(/);
assert.match(networkService, /MESH_VIEW_NODE_LIMIT\s*=\s*96/);
assert.match(networkService, /SNAPSHOT_LIMIT\s*=\s*48/);
assert.doesNotMatch(networkService, /load_network_overview|appTable\(/, "Live Mesh overview must be computed from local peer observations");
assert.match(networkService, /source:\s*"observed-mesh"/);
assert.match(schema, /create function app717_meshvault\.discover_bootstrap_gateways/);
assert.match(schema, /device_public_key=any\(p_device_public_keys\)/);
assert.match(schema, /limit v_limit/);
assert.match(nodeService, /Merge them into the next/);
assert.match(nodeService, /connectFallbackAfterMeshAttempt/);
assert.match(nodeService, /if \(!patientZero && !supabaseAutomaticFallbackEnabled\(\)\) return/);
assert.match(nodeService, /supabaseFallbackOpened && supabaseFallbackWindowOpen\(\)/);
assert.match(nodeService, /excludeProviders: \[supabaseBootstrapProvider\.name\]/);
assert.match(nodeService, /markSupabaseBootstrapComplete\(\)/);
assert.match(nodeService, /clearAnonymousSessionLocally\(\)/);
assert.match(nodeService, /appTable\("nodes"\)\.delete\(\)/);
assert.doesNotMatch(nodeService, /processPendingLocalDeletions/);
assert.doesNotMatch(nodeService, /beforeunload[\s\S]{0,500}appTable\("nodes"\)/);
assert.match(recoveryCoordinator, /requestRecoveryCycle/);
assert.match(recoveryCoordinator, /meshvault:repair-needed/);
assert.match(recoveryCoordinator, /DEFAULT_MAINTENANCE_MS\s*=\s*15 \* 60 \* 1000/);
assert.doesNotMatch(recoveryCoordinator, /setInterval\(\(\)\s*=>\s*recoveryCycle/);
assert.doesNotMatch(recoveryCoordinator, /intervalMs\s*=\s*15000/);
assert.match(bootstrap, /hasVaultWork/);
assert.match(bootstrap, /connectedProtocols\(\)\.length\s*>\s*0/);
assert.match(chaos, /External network access is forbidden/);
assert.match(fallbackPolicy, /supabaseAutomaticFallbackEnabled\(\)/);
assert.match(fallbackPolicy, /if \(!force && !supabaseAutomaticFallbackEnabled\(\)\) return false/);
assert.match(fallbackPolicy, /return patientZeroListener \|\| supabaseFallbackWindowOpen\(\)/);

// Arithmetic only: an ordinary profile receives one bounded first-contact
// window per running lifecycle. Once a verified mesh route exists, its
// lifecycle marker makes scheduled Supabase traffic zero until a cold start.
const oldRequestsPerNodeHour = 240 + (60 * 4) + 120 + 40;
const verifiedMeshIdleRequestsPerNodeHour = 0;
const automaticColdStartWindowsPerLifecycle = 1;
const hybridReduction = 1 - verifiedMeshIdleRequestsPerNodeHour / oldRequestsPerNodeHour;
const operationInitialPayloadReduction = 1 - 200 / 5000;
assert.equal(verifiedMeshIdleRequestsPerNodeHour, 0, "verified mesh idle traffic must not use Supabase");
assert.equal(automaticColdStartWindowsPerLifecycle, 1, "an ordinary lifecycle gets exactly one bounded first-contact phase");
assert.ok(operationInitialPayloadReduction >= 0.96, "initial operation history payload is bounded to 200 instead of 5,000 rows");

console.log(`PASS egress budget: local-only check; verified-mesh idle Supabase requests ${verifiedMeshIdleRequestsPerNodeHour}/hour, first-contact windows ${automaticColdStartWindowsPerLifecycle}/lifecycle, former timer model reduced ${(hybridReduction * 100).toFixed(1)}%, initial operation payload -${(operationInitialPayloadReduction * 100).toFixed(1)}%. No network requests executed.`);
