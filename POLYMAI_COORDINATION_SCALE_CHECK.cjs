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
  assert.equal(start.mode, policy.COORDINATION_MODES.HYBRID);
  assert.equal(policy.evaluateCoordination(start, { participantCount: 3, backboneCount: 1, supabaseUp: true, now: 121001 }).mode, policy.COORDINATION_MODES.ANCHOR_PRIMARY);
  assert.equal(policy.evaluateCoordination(start, { participantCount: 1, backboneCount: 0, supabaseUp: true, now: 2000 }).mode, policy.COORDINATION_MODES.HYBRID);
  assert.equal(policy.evaluateCoordination(start, { participantCount: 3, backboneCount: 1, supabaseUp: false, now: 2000 }).mode, policy.COORDINATION_MODES.MESH_DEGRADED);
  assert.equal(policy.evaluateCoordination(start, { participantCount: 0, backboneCount: 0, supabaseUp: false, now: 2000 }).mode, policy.COORDINATION_MODES.ISOLATED);
  const afterDrop = policy.evaluateCoordination(start, { participantCount: 0, backboneCount: 0, supabaseUp: true, now: 2000 });
  const restored = policy.evaluateCoordination(afterDrop, { participantCount: 3, backboneCount: 1, supabaseUp: true, now: 500000 });
  assert.equal(restored.mode, policy.COORDINATION_MODES.HYBRID, "a restored Anchor set must earn a fresh stability window");
  assert.equal(restored.anchorStableSince, 500000, "a null stability timestamp must never be treated as the Unix epoch");
  assert.ok(!policy.providerOrder(policy.COORDINATION_MODES.MESH_DEGRADED).includes("supabase"));

  const estimatedHeartbeatWritesPerSecond = 200 / 600 + 9800 / 600;
  assert.ok(estimatedHeartbeatWritesPerSecond < 20, "10,000-node Anchor-primary heartbeat target stays below 20 Supabase writes/s");
  assert.equal(policy.shouldWriteSupabaseHeartbeat(policy.COORDINATION_MODES.ANCHOR_PRIMARY, false, 1, 600000, {
    supabaseBackboneHeartbeatMs: 600000,
  }), false, "ordinary Anchor-primary clients must not report early");
  assert.equal(policy.shouldWriteSupabaseHeartbeat(policy.COORDINATION_MODES.ANCHOR_PRIMARY, false, 1, 600001, {
    supabaseBackboneHeartbeatMs: 600000,
  }), true, "ordinary Anchor-primary clients report after ten minutes");
  assert.equal(policy.shouldWriteSupabaseHeartbeat(policy.COORDINATION_MODES.MESH_DEGRADED, true, 0, 600001), false, "a hosted outage must not schedule Supabase writes");

  const provider = read("js/network/providers/supabase-bootstrap-provider.js");
  const schema = read("supabase/schema.sql");
  const policies = read("supabase/policies.sql");
  const realtime = read("supabase/realtime.sql");
  const nodeService = read("js/network/node-service.js");
  const runtime = read("data/runtime-config.js");
  assert.match(provider, /discover_node_candidates/);
  assert.match(provider, /send_mesh_signal/);
  assert.match(provider, /get_node_signal_topic/);
  assert.match(provider, /private:\s*false/);
  assert.match(provider, /discoveryCacheMs \|\| 300000/);
  assert.match(provider, /p_limit:\s*8/);
  assert.match(provider, /if \(cachedPresenceEntries\.length\) presenceListeners/);
  assert.doesNotMatch(provider, /async publishPresence\(\)\s*\{[\s\S]{0,300}publishPresenceOnce/);
  assert.doesNotMatch(provider, /table:\s*["']nodes["']/);
  assert.match(schema, /coordination_protocol_version/);
  assert.match(schema, /anchor_observed_capacity_bytes/);
  assert.match(schema, /create function app717_meshvault\.discover_node_candidates/);
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
  assert.match(runtime, /minimumMeshParticipants:\s*2/);
  assert.match(runtime, /minimumBackbonePeers:\s*1/);
  assert.match(runtime, /supabaseColdStartDelayMs:\s*5000/);
  assert.match(runtime, /maximumPeerConnections:\s*4/);
  assert.match(runtime, /discoveryCacheMs:\s*300000/);
  assert.match(runtime, /supabaseHeartbeatMs:\s*600000/);
  assert.match(schema, /limit least\(3,v_limit\)/);
  assert.match(schema, /limit greatest\(0,v_limit-least\(3,v_limit\)\)/);
  assert.match(schema, /last_seen_at>now\(\)-interval '12 minutes'/);
  assert.match(nodeService, /meshvault:repair-needed/);
  assert.match(nodeService, /repair-request/);
  assert.match(nodeService, /excludeProviders:\s*supabaseFallbackOpened/);
  assert.match(nodeService, /connectFallbackAfterMeshAttempt/);
  assert.match(nodeService, /markProviderStatus\(supabaseBootstrapProvider\.name, supabaseReachable\)/);

  console.log(`PASS coordination scale: 10,000 automatic control participants, 200 Backbones, avg ${average.toFixed(1)} assignments, max ${Math.max(...loads)}, estimated ${estimatedHeartbeatWritesPerSecond.toFixed(1)} sparse Supabase heartbeat writes/s`);
})().catch((error) => {
  console.error(`FAIL coordination scale: ${error.stack || error.message}`);
  process.exitCode = 1;
});
