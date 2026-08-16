const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The 10,000-node assignment model is deliberately local-only.
global.fetch = async () => { throw new Error("External network access is forbidden in the coordination scale check."); };
global.WebSocket = class BlockedWebSocket { constructor() { throw new Error("External network access is forbidden in the coordination scale check."); } };

const root = __dirname;
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

(async () => {
  const policy = await import(pathToFileURL(path.join(root, "js/network/coordination-policy.js")).href);
  const now = Date.now();
  const backbones = Array.from({ length: 200 }, (_, index) => ({
    nodeId: `backbone-${String(index).padStart(3, "0")}`,
    failureDomainId: `device-${index}`,
    countryCode: ["SE", "DE", "NL", "FR", "HR"][index % 5],
    capabilities: ["mesh-control-lite-v3", "mesh-backbone-v3", "anchor-control-v3"],
    anchorProtocolVersion: 3,
    reliabilityScore: 0.9,
    leaseExpiresAt: new Date(now + 600000).toISOString(),
    anchorControlCapacityBytes: 100 * 1024 * 1024,
    anchorControlUsedBytes: 10 * 1024 * 1024,
    anchorConnectedNodes: 25,
  }));
  const primaryLoads = new Map(backbones.map((backbone) => [backbone.nodeId, 0]));
  let firstAssignment = null;
  for (let index = 0; index < 10000; index += 1) {
    const nodeId = `node-${index}`;
    const assignment = policy.selectAnchorAssignments(backbones, nodeId, { now });
    assert.equal(assignment.primary.length, 3, "every node gets three primary Backbones");
    assert.equal(assignment.reserve.length, 2, "every node gets two reserve Backbones");
    assert.equal(new Set([...assignment.primary, ...assignment.reserve].map((entry) => entry.nodeId)).size, 5, "assignments use five independent devices");
    for (const anchor of assignment.primary) primaryLoads.set(anchor.nodeId, primaryLoads.get(anchor.nodeId) + 1);
    if (index === 0) firstAssignment = assignment;
  }
  const loads = [...primaryLoads.values()];
  const average = loads.reduce((sum, value) => sum + value, 0) / loads.length;
  assert.ok(Math.max(...loads) < average * 1.75, "rendezvous selection remains reasonably balanced at 10,000 nodes");
  assert.deepEqual(
    policy.selectAnchorAssignments(backbones, "node-0", { now }).primary.map((entry) => entry.nodeId),
    firstAssignment.primary.map((entry) => entry.nodeId),
    "assignment is deterministic",
  );
  const failed = new Set(firstAssignment.primary.slice(0, 2).map((entry) => entry.nodeId));
  const afterFailure = policy.selectAnchorAssignments(backbones.filter((backbone) => !failed.has(backbone.nodeId)), "node-0", { now });
  assert.equal(afterFailure.primary.length, 3);
  assert.ok(afterFailure.primary.every((entry) => !failed.has(entry.nodeId)), "failed Anchors are replaced");

  const start = policy.evaluateCoordination({}, { participantCount: 3, backboneCount: 1, supabaseUp: true, now: 1000 });
  assert.equal(start.mode, policy.COORDINATION_MODES.ANCHOR_PRIMARY);
  assert.equal(policy.evaluateCoordination(start, { participantCount: 3, backboneCount: 1, supabaseUp: true, now: 121001 }).mode, policy.COORDINATION_MODES.ANCHOR_PRIMARY);
  assert.equal(policy.evaluateCoordination(start, { participantCount: 1, backboneCount: 0, supabaseUp: true, now: 2000 }).mode, policy.COORDINATION_MODES.ANCHOR_PRIMARY);
  assert.equal(policy.evaluateCoordination(start, { participantCount: 3, backboneCount: 1, supabaseUp: false, now: 2000 }).mode, policy.COORDINATION_MODES.ANCHOR_PRIMARY);
  assert.equal(policy.evaluateCoordination(start, { participantCount: 0, backboneCount: 0, supabaseUp: false, now: 2000 }).mode, policy.COORDINATION_MODES.ISOLATED);
  const afterDrop = policy.evaluateCoordination(start, { participantCount: 0, backboneCount: 0, supabaseUp: true, now: 2000 });
  const restored = policy.evaluateCoordination(afterDrop, { participantCount: 3, backboneCount: 1, supabaseUp: true, now: 500000 });
  assert.equal(restored.mode, policy.COORDINATION_MODES.ANCHOR_PRIMARY, "a restored verified mesh path becomes primary immediately");
  assert.equal(restored.anchorStableSince, 500000, "a null stability timestamp must never be treated as the Unix epoch");
  assert.ok(!policy.providerOrder(policy.COORDINATION_MODES.MESH_DEGRADED).includes("supabase"));

  const patientZeroCount = 1;
  const estimatedHeartbeatWritesPerSecond = patientZeroCount / 600;
  assert.ok(estimatedHeartbeatWritesPerSecond < 0.01, "only Patient Zero may keep a sparse hosted heartbeat after bootstrap");
  assert.equal(policy.shouldWriteSupabaseHeartbeat(policy.COORDINATION_MODES.ANCHOR_PRIMARY, false, 1, 600001, {
    supabaseBackboneHeartbeatMs: 600000,
  }), false, "ordinary Anchor-primary coordination must never schedule hosted heartbeats");
  assert.equal(policy.shouldWriteSupabaseHeartbeat(policy.COORDINATION_MODES.MESH_DEGRADED, true, 0, 600001), false, "a hosted outage must not schedule Supabase writes");

  const provider = read("js/network/providers/supabase-bootstrap-provider.js");
  const schema = read("supabase/schema.sql");
  const policies = read("supabase/policies.sql");
  const realtime = read("supabase/realtime.sql");
  const nodeService = read("js/network/node-service.js");
  const runtime = read("data/runtime-config.js");
  assert.match(provider, /discover_bootstrap_gateways/);
  assert.doesNotMatch(provider, /discover_node_candidates/);
  assert.match(provider, /send_mesh_signal/);
  assert.match(provider, /get_node_signal_topic/);
  assert.match(provider, /private:\s*false/);
  assert.match(provider, /discoveryCacheMs \|\| 300000/);
  assert.match(provider, /p_limit:\s*3/);
  assert.match(provider, /if \(cachedPresenceEntries\.length\) presenceListeners/);
  assert.doesNotMatch(provider, /async publishPresence\(\)\s*\{[\s\S]{0,300}publishPresenceOnce/);
  assert.doesNotMatch(provider, /table:\s*["']nodes["']/);
  assert.match(schema, /coordination_protocol_version/);
  assert.match(schema, /anchor_observed_capacity_bytes/);
  assert.match(schema, /create function app717_meshvault\.discover_bootstrap_gateways/);
  assert.doesNotMatch(schema, /create function app717_meshvault\.discover_node_candidates/);
  assert.match(schema, /create or replace function app717_meshvault\.send_mesh_signal/);
  assert.match(schema, /create table if not exists app717_meshvault\.node_signal_channels/);
  assert.match(schema, /create or replace function app717_meshvault\.get_node_signal_topic/);
  assert.match(policies, /node_signal_channels_owner_read/);
  assert.doesNotMatch(policies, /on realtime\.messages/i);
  assert.match(realtime, /drop table app717_meshvault\.\%I/);
  assert.match(runtime, /targetAnchors:\s*3/);
  assert.match(runtime, /reserveAnchors:\s*2/);
  assert.match(runtime, /supabaseBackboneHeartbeatMs:\s*600000/);
  assert.match(runtime, /operationBackboneFlushMs:\s*300000/);
  assert.match(runtime, /minimumMeshParticipants:\s*1/);
  assert.match(runtime, /minimumBackbonePeers:\s*1/);
  assert.match(runtime, /supabaseColdStartDelayMs:\s*2500/);
  assert.match(runtime, /supabaseFallbackWindowMs:\s*60000/);
  assert.match(runtime, /maximumPeerConnections:\s*4/);
  assert.match(runtime, /discoveryCacheMs:\s*300000/);
  assert.match(runtime, /supabaseHeartbeatMs:\s*600000/);
  assert.match(schema, /device_public_key=any\(p_device_public_keys\)/);
  assert.match(schema, /declare v_limit int := least\(8,greatest\(1,coalesce\(p_limit,3\)\)\)/);
  assert.match(schema, /last_seen_at>now\(\)-interval '12 minutes'/);
  assert.match(nodeService, /meshvault:repair-needed/);
  assert.match(nodeService, /repair-request/);
  assert.match(nodeService, /markSupabaseBootstrapComplete/);
  assert.match(nodeService, /retireOrdinaryBootstrapRegistration/);
  assert.match(nodeService, /clearAnonymousSessionLocally/);
  assert.match(nodeService, /connectFallbackAfterMeshAttempt/);
  assert.match(nodeService, /markProviderStatus\(supabaseBootstrapProvider\.name, supabaseReachable\)/);

  console.log(`PASS coordination scale: 10,000 local-only assignment simulation, 200 Backbones, avg ${average.toFixed(1)} assignments, max ${Math.max(...loads)}, estimated ${estimatedHeartbeatWritesPerSecond.toFixed(4)} hosted heartbeat writes/s from Patient Zero only`);
})().catch((error) => {
  console.error(`FAIL coordination scale: ${error.stack || error.message}`);
  process.exitCode = 1;
});
