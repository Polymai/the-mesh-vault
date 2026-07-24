(async () => {
const assert = (await import("node:assert/strict")).default;
const fs = await import("node:fs");
const vm = await import("node:vm");
const { encode, reconstruct } = await import("./js/vendor/reed-solomon.js");
const {
  nextOfflinePlacementState,
  planReplicaReconciliation,
  planShardRepairs,
  selectErasureProfile,
} = await import("./js/network/shard-lifecycle.js");

const runtime = { window: { __POLYMAI_SUPABASE_CONFIG__: {} } };
vm.runInNewContext(fs.readFileSync("data/runtime-config.js", "utf8"), runtime);
const profiles = runtime.window.__DATA__.erasureProfiles;

function exact(left, right) {
  assert.equal(left.byteLength, right.byteLength);
  assert.equal(Buffer.compare(Buffer.from(left), Buffer.from(right)), 0);
}

function erasureRoundTrip(dataShards, parityShards, survivorIndexes) {
  const bytes = Uint8Array.from({ length: 1024 * 1024 + 137 }, (_, index) => (index * 31 + 17) % 256);
  const layout = encode(bytes, dataShards, parityShards);
  const available = survivorIndexes.map((index) => ({ index, bytes: layout.shards[index] }));
  exact(reconstruct(available, bytes.byteLength, dataShards), bytes);
}

assert.deepEqual(
  (({ dataShards, parityShards, repairThreshold, totalShards }) => ({ dataShards, parityShards, repairThreshold, totalShards }))(selectErasureProfile(profiles, 10)),
  { dataShards: 7, parityShards: 3, repairThreshold: 9, totalShards: 10 },
);
assert.deepEqual(
  (({ dataShards, parityShards, repairThreshold, totalShards }) => ({ dataShards, parityShards, repairThreshold, totalShards }))(selectErasureProfile(profiles, 16)),
  { dataShards: 12, parityShards: 4, repairThreshold: 14, totalShards: 16 },
);
assert.deepEqual(
  (({ dataShards, parityShards, repairThreshold, totalShards }) => ({ dataShards, parityShards, repairThreshold, totalShards }))(selectErasureProfile(profiles, 16, "high")),
  { dataShards: 10, parityShards: 6, repairThreshold: 13, totalShards: 16 },
);
assert.deepEqual(
  (({ dataShards, parityShards, repairThreshold, totalShards }) => ({ dataShards, parityShards, repairThreshold, totalShards }))(selectErasureProfile(profiles, 10, "high")),
  { dataShards: 7, parityShards: 3, repairThreshold: 9, totalShards: 10 },
);

erasureRoundTrip(7, 3, [0, 2, 3, 5, 7, 8, 9]);
erasureRoundTrip(12, 4, [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 14, 15]);
erasureRoundTrip(10, 6, [0, 2, 4, 6, 8, 10, 11, 13, 14, 15]);
assert.throws(() => reconstruct(encode(new Uint8Array(64), 12, 4).shards.slice(0, 11).map((bytes, index) => ({ index, bytes })), 64, 12), /Need 12/);

const now = Date.parse("2026-07-23T12:00:00.000Z");
const firstMiss = nextOfflinePlacementState({ status: "verified" }, now, 30 * 60_000);
assert.equal(firstMiss.status, "suspect");
assert.equal(nextOfflinePlacementState({ status: "suspect", unavailable_since: firstMiss.unavailableSince }, now + 29 * 60_000, 30 * 60_000).status, "suspect");
assert.equal(nextOfflinePlacementState({ status: "suspect", unavailable_since: firstMiss.unavailableSince }, now + 30 * 60_000, 30 * 60_000).status, "unavailable");

const tenShardRepairGroup = {
  required_shards: 7,
  repair_threshold: 9,
  total_shards: 10,
  segment_shards: Array.from({ length: 10 }, (_, index) => ({ id: `repair-${index}`, shard_placements: [] })),
};
assert.equal(planShardRepairs(tenShardRepairGroup, new Set(tenShardRepairGroup.segment_shards.slice(0, 9).map((shard) => shard.id))).length, 0);
assert.equal(planShardRepairs(tenShardRepairGroup, new Set(tenShardRepairGroup.segment_shards.slice(0, 8).map((shard) => shard.id))).length, 2);
assert.equal(planShardRepairs(tenShardRepairGroup, new Set(tenShardRepairGroup.segment_shards.slice(0, 7).map((shard) => shard.id))).length, 3);

const shards = Array.from({ length: 16 }, (_, shardIndex) => ({
  id: `shard-${shardIndex}`,
  shard_placements: [
    { id: `original-${shardIndex}`, node_id: `node-${shardIndex}`, failure_domain_id: `domain-${shardIndex}`, status: "verified", live: true, last_proof_at: new Date(now).toISOString(), node: { reliability_score: 0.9 } },
    ...(shardIndex < 4 ? [{ id: `replacement-${shardIndex}`, node_id: `new-node-${shardIndex}`, failure_domain_id: `new-domain-${shardIndex}`, status: "verified", live: true, last_proof_at: new Date(now + 1000).toISOString(), node: { reliability_score: 0.95 } }] : []),
  ],
}));
const surplusPlan = planReplicaReconciliation(shards, { now, surplusGraceMs: 5 * 60_000 });
assert.equal(surplusPlan.filter((action) => action.type === "mark-surplus").length, 4);
for (const action of surplusPlan) {
  if (action.type !== "mark-surplus") continue;
  action.placement.status = "surplus";
  action.placement.retire_after = new Date(action.retireAt).toISOString();
}
const retirePlan = planReplicaReconciliation(shards, { now: now + 5 * 60_000, surplusGraceMs: 5 * 60_000 });
assert.equal(retirePlan.filter((action) => action.type === "retire").length, 4);
assert.equal(new Set(shards.map((shard) => shard.id)).size, 16);

console.log("PASS profiles: 7+3, 12+4, 10+6");
console.log("PASS exact recovery at each profile's maximum tolerated loss");
console.log("PASS offline grace: verified -> suspect -> unavailable");
console.log("PASS K/R/N repair threshold: 7 required, repair below 9, target 10");
console.log("PASS rejoin: 16 logical shards, 20 temporary copies, 4 deterministic retirements");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
