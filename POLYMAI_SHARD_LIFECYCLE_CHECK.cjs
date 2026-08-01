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
const {
  createFilePlacementContext,
  createPlacementContext,
  rankPlacementCandidates,
  recordFilePlacementChoice,
  recordPlacementChoice,
  stablePlacementScore,
} = await import("./js/network/placement-engine.js");
const { calculateFileHealth } = await import("./js/network/resilience.js");

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

const profileShape = (profile) => (({ dataShards, parityShards, repairThreshold, totalShards }) => ({ dataShards, parityShards, repairThreshold, totalShards }))(profile);
assert.deepEqual(profileShape(selectErasureProfile(profiles, 5)), { dataShards: 3, parityShards: 2, repairThreshold: 4, totalShards: 5 });
assert.deepEqual(profileShape(selectErasureProfile(profiles, 6)), { dataShards: 4, parityShards: 2, repairThreshold: 5, totalShards: 6 });
assert.deepEqual(profileShape(selectErasureProfile(profiles, 8)), { dataShards: 6, parityShards: 2, repairThreshold: 7, totalShards: 8 });
assert.deepEqual(
  profileShape(selectErasureProfile(profiles, 10)),
  { dataShards: 7, parityShards: 3, repairThreshold: 9, totalShards: 10 },
);
assert.deepEqual(
  profileShape(selectErasureProfile(profiles, 12)),
  { dataShards: 8, parityShards: 4, repairThreshold: 10, totalShards: 12 },
);
assert.deepEqual(
  profileShape(selectErasureProfile(profiles, 16)),
  { dataShards: 10, parityShards: 6, repairThreshold: 13, totalShards: 16 },
);
assert.deepEqual(
  profileShape(selectErasureProfile(profiles, 16, "standard")),
  { dataShards: 12, parityShards: 4, repairThreshold: 14, totalShards: 16 },
);
assert.deepEqual(
  profileShape(selectErasureProfile(profiles, 16, "high")),
  { dataShards: 10, parityShards: 6, repairThreshold: 13, totalShards: 16 },
);
assert.deepEqual(
  profileShape(selectErasureProfile(profiles, 10, "high")),
  { dataShards: 7, parityShards: 3, repairThreshold: 9, totalShards: 10 },
);

erasureRoundTrip(4, 2, [0, 2, 4, 5]);
erasureRoundTrip(6, 2, [0, 1, 3, 4, 6, 7]);
erasureRoundTrip(7, 3, [0, 2, 3, 5, 7, 8, 9]);
erasureRoundTrip(8, 4, [0, 2, 3, 5, 7, 8, 10, 11]);
erasureRoundTrip(12, 4, [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 14, 15]);
erasureRoundTrip(10, 6, [0, 2, 4, 6, 8, 10, 11, 13, 14, 15]);
assert.throws(() => reconstruct(encode(new Uint8Array(64), 8, 4).shards.slice(0, 7).map((bytes, index) => ({ index, bytes })), 64, 8), /Need 8/);
assert.throws(() => reconstruct(encode(new Uint8Array(64), 12, 4).shards.slice(0, 11).map((bytes, index) => ({ index, bytes })), 64, 12), /Need 12/);

assert.equal(calculateFileHealth({ requiredShards: 8, totalShards: 12 }, [0, 1, 2, 3, 4, 5, 6]).status, "unavailable");
assert.equal(calculateFileHealth({ requiredShards: 8, totalShards: 12 }, [0, 1, 2, 3, 4, 5, 6, 7]).status, "critical");
assert.equal(calculateFileHealth({ requiredShards: 8, totalShards: 12 }, [0, 1, 2, 3, 4, 5, 6, 7, 8]).status, "degraded");
assert.equal(calculateFileHealth({ requiredShards: 8, totalShards: 12 }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).status, "healthy");

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

function placeSyntheticFile(candidateCount, segmentCount, shardsPerSegment) {
  const nodes = Array.from({ length: candidateCount }, (_, index) => ({
    id: `spread-node-${index}`,
    failure_domain_id: `spread-domain-${index}`,
    country_code: `C${index % 20}`,
    region_code: `C${index % 20}-${index % 4}`,
    network_domain_hash: `network-${index % 240}`,
    capacity_bytes: 1024 * 1024 * 1024,
    used_bytes: 64 * 1024 * 1024,
    reliability_score: 0.65 + (index % 30) / 100,
  }));
  const fileContext = createFilePlacementContext([], {
    expectedPlacements: segmentCount * shardsPerSegment,
    candidateCount,
  });
  const groups = [];
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const groupContext = createPlacementContext();
    const holders = [];
    for (let shardIndex = 0; shardIndex < shardsPerSegment; shardIndex += 1) {
      const placementKey = `file-v1:${segmentIndex}:${shardIndex}`;
      const target = rankPlacementCandidates(nodes, {
        context: groupContext,
        fileContext,
        placementKey,
        shardBytes: 1024 * 1024,
      })[0];
      assert(target);
      holders.push(target.id);
      recordPlacementChoice(groupContext, target);
      recordFilePlacementChoice(fileContext, target, 1024 * 1024, placementKey);
    }
    assert.equal(new Set(holders).size, shardsPerSegment);
    groups.push(holders);
  }
  return { fileContext, groups };
}

const widePlacement = placeSyntheticFile(1000, 3, 16);
assert.equal(new Set(widePlacement.groups.flat()).size, 48);
assert.equal(Math.max(...widePlacement.fileContext.nodeCounts.values()), 1);
assert.equal(widePlacement.groups[0].filter((nodeId) => widePlacement.groups[1].includes(nodeId)).length, 0);

const constrainedPlacement = placeSyntheticFile(20, 13, 16);
const constrainedLoads = [...constrainedPlacement.fileContext.nodeCounts.values()];
assert.equal(new Set(constrainedPlacement.groups.flat()).size, 20);
assert(Math.max(...constrainedLoads) - Math.min(...constrainedLoads) <= 1);
assert.equal(stablePlacementScore("same-key", { id: "same-node" }), stablePlacementScore("same-key", { id: "same-node" }));
assert.notEqual(stablePlacementScore("key-a", { id: "same-node" }), stablePlacementScore("key-b", { id: "same-node" }));

console.log("PASS automatic profile ladder: 3+2, 4+2, 6+2, 7+3, 8+4, 10+6");
console.log("PASS manual profiles: balanced 12+4 and extra 10+6");
console.log("PASS exact recovery at each profile's maximum tolerated loss");
console.log("PASS health states: healthy, degraded, critical, unavailable");
console.log("PASS offline grace: verified -> suspect -> unavailable");
console.log("PASS K/R/N repair threshold: 7 required, repair below 9, target 10");
console.log("PASS rejoin: 16 logical shards, 20 temporary copies, 4 deterministic retirements");
console.log("PASS file-wide spread: 48 placements use 48 of 1000 eligible devices");
console.log("PASS constrained spread: 208 placements remain balanced across 20 devices");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
