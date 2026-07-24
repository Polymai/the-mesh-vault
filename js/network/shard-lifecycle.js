export const ACTIVE_PLACEMENT_STATUSES = Object.freeze(["stored", "verified", "surplus"]);
export const PHYSICAL_PLACEMENT_STATUSES = Object.freeze(["pending", "stored", "verified", "suspect", "unavailable", "surplus", "retiring", "deleting"]);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function normalizeErasureProfile(profile = {}) {
  const dataShards = Math.max(2, Math.trunc(finite(profile.dataShards, 3)));
  const parityShards = Math.max(1, Math.trunc(finite(profile.parityShards, 2)));
  const totalShards = dataShards + parityShards;
  const repairThreshold = Math.min(
    totalShards,
    Math.max(dataShards, Math.trunc(finite(profile.repairThreshold, dataShards + Math.ceil(parityShards / 2)))),
  );
  return {
    ...profile,
    dataShards,
    parityShards,
    requiredShards: dataShards,
    totalShards,
    repairThreshold,
  };
}

export function selectErasureProfile(profiles = [], independentNodes = 0, resilienceClass = "standard") {
  const count = Math.max(0, Math.trunc(finite(independentNodes)));
  const compatible = profiles
    .filter((profile) => (profile.resilienceClass || "standard") === resilienceClass)
    .map(normalizeErasureProfile)
    .sort((left, right) => Number(right.minimumIndependentNodes || 0) - Number(left.minimumIndependentNodes || 0));
  const eligible = compatible.find((profile) => count >= Number(profile.minimumIndependentNodes || 0));
  if (!eligible && resilienceClass !== "standard") return { ...selectErasureProfile(profiles, count, "standard"), requestedResilienceClass: resilienceClass };
  const selected = eligible
    || compatible.at(-1)
    || normalizeErasureProfile({ minimumIndependentNodes: 5, dataShards: 3, parityShards: 2, repairThreshold: 4 });
  return {
    ...selected,
    resilienceClass: selected.resilienceClass || resilienceClass,
    placementReady: count >= Number(selected.minimumIndependentNodes || 0),
  };
}

export function nextOfflinePlacementState(placement, now = Date.now(), repairGraceMs = 30 * 60_000) {
  if (!placement || ["deleted", "deleting", "retiring"].includes(placement.status)) return null;
  if (placement.status === "unavailable") return { status: "unavailable", unavailableSince: placement.unavailable_since || null };
  const unavailableSince = placement.unavailable_since || new Date(now).toISOString();
  const elapsed = now - new Date(unavailableSince).getTime();
  return {
    status: elapsed >= Math.max(0, repairGraceMs) ? "unavailable" : "suspect",
    unavailableSince,
  };
}

export function chooseReplicaKeeper(placements = [], occupiedDomains = new Set()) {
  return [...placements].sort((left, right) => {
    const leftNovel = occupiedDomains.has(left.failure_domain_id) ? 0 : 1;
    const rightNovel = occupiedDomains.has(right.failure_domain_id) ? 0 : 1;
    if (leftNovel !== rightNovel) return rightNovel - leftNovel;
    const reliability = finite(right.node?.reliability_score, 0) - finite(left.node?.reliability_score, 0);
    if (reliability) return reliability;
    const proofAge = new Date(right.last_proof_at || 0).getTime() - new Date(left.last_proof_at || 0).getTime();
    if (proofAge) return proofAge;
    if (left.status !== right.status) return left.status === "surplus" ? 1 : -1;
    return String(left.node_id).localeCompare(String(right.node_id));
  })[0] || null;
}

export function planReplicaReconciliation(shards = [], { now = Date.now(), surplusGraceMs = 5 * 60_000 } = {}) {
  const activeByShard = new Map();
  for (const shard of shards) {
    activeByShard.set(shard.id, (shard.shard_placements || []).filter((placement) => ACTIVE_PLACEMENT_STATUSES.includes(placement.status) && placement.live !== false));
  }
  const actions = [];
  for (const shard of shards) {
    const active = activeByShard.get(shard.id) || [];
    if (active.length < 2) {
      if (active.length === 1 && active[0].status === "surplus") actions.push({ type: "promote", shardId: shard.id, placement: active[0] });
      continue;
    }
    const occupiedDomains = new Set();
    for (const [otherShardId, placements] of activeByShard) {
      if (otherShardId === shard.id) continue;
      for (const placement of placements) occupiedDomains.add(placement.failure_domain_id);
    }
    const keeper = chooseReplicaKeeper(active, occupiedDomains);
    for (const placement of active) {
      if (placement.id === keeper?.id) {
        if (placement.status === "surplus") actions.push({ type: "promote", shardId: shard.id, placement });
        continue;
      }
      const retireAt = placement.retire_after ? new Date(placement.retire_after).getTime() : now + Math.max(0, surplusGraceMs);
      actions.push({
        type: retireAt <= now ? "retire" : "mark-surplus",
        shardId: shard.id,
        placement,
        keeper,
        retireAt,
      });
    }
  }
  return actions;
}

export function planShardRepairs(segment, activeShardIds = new Set()) {
  const shards = segment?.segment_shards || [];
  const required = Math.max(0, Math.trunc(finite(segment?.required_shards)));
  const total = Math.max(required, Math.trunc(finite(segment?.total_shards, shards.length)));
  const repairThreshold = Math.min(total, Math.max(required, Math.trunc(finite(segment?.repair_threshold, required))));
  if (activeShardIds.size >= repairThreshold) return [];
  return shards.filter((shard) => {
    if (activeShardIds.has(shard.id)) return false;
    return !(shard.shard_placements || []).some((placement) => placement.role === "durable" && placement.status === "suspect");
  }).map((shard) => shard.id);
}
