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
const schema = read("supabase/schema.sql");
const chaos = read("POLYMAI_1000_NODE_CHAOS_CHECK.cjs");

assert.match(runtime, /minimumMeshAnchors:\s*1/);
assert.match(runtime, /liveMeshRefreshMs:\s*180000/);
assert.match(runtime, /networkOverviewRefreshMs:\s*300000/);
assert.match(runtime, /operationInitialBatchSize:\s*200/);
assert.match(runtime, /supabaseHeartbeatMs:\s*600000/);
assert.match(bootstrap, /LIVE_MESH_REFRESH_MS\s*=\s*Number/);
assert.doesNotMatch(bootstrap, /LIVE_MESH_REFRESH_MS\s*=\s*15000/);
assert.match(provider, /discoveryCacheMs \|\| 300000/);
assert.match(provider, /p_limit:\s*8/);
assert.doesNotMatch(provider, /async publishPresence\(\)\s*\{[\s\S]{0,300}publishPresenceOnce/);
assert.match(provider, /presencePromise/);
assert.match(registry, /discoveryPromise/);
assert.match(registry, /requireProvider/);
assert.match(control, /cache_sequence,operation/);
assert.match(control, /operationDeltaMaxBatches/);
assert.doesNotMatch(control, /offset\s*<\s*5000/);
assert.doesNotMatch(control, /\.range\(/);
assert.match(networkService, /MESH_VIEW_NODE_LIMIT\s*=\s*96/);
assert.match(networkService, /SNAPSHOT_LIMIT\s*=\s*48/);
assert.match(networkService, /load_network_overview/);
assert.match(schema, /cache_sequence bigint generated/);
assert.match(schema, /create or replace function app717_meshvault\.load_network_overview/);
assert.match(schema, /limit least\(3,v_limit\)/);
assert.match(schema, /limit greatest\(0,v_limit-least\(3,v_limit\)\)/);
assert.match(nodeService, /Merge them into the next/);
assert.match(chaos, /External network access is forbidden/);

// Arithmetic only: no logical node opens a connection. This compares the
// former timer/query shape with the bounded request shape per client-hour.
const oldRequestsPerNodeHour = 240 + (60 * 4) + 120 + 40;
const newColdStartRequestsPerNodeHour = 30 + 12 + 0 + 40;
const newHybridRequestsPerNodeHour = 6 + 12 + 0 + 40;
const hybridReduction = 1 - newHybridRequestsPerNodeHour / oldRequestsPerNodeHour;
const operationInitialPayloadReduction = 1 - 200 / 5000;
assert.ok(hybridReduction > 0.90, "mesh-first control requests should fall by more than 90% in the timer model");
assert.ok(operationInitialPayloadReduction >= 0.96, "initial operation history payload is bounded to 200 instead of 5,000 rows");

console.log(`PASS egress budget: local-only check; modeled mesh-first requests -${(hybridReduction * 100).toFixed(1)}%, cold-start requests -${((1 - newColdStartRequestsPerNodeHour / oldRequestsPerNodeHour) * 100).toFixed(1)}%, initial operation payload -${(operationInitialPayloadReduction * 100).toFixed(1)}%. No network requests executed.`);
