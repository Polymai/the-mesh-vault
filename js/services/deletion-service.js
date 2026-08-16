import { deleteShard, hasShard, withShardMutationLock } from "../storage/fragment-store.js";
import { verifyDeletionAuthorization } from "../security/deletion-authorization.js";
import {
  listContentSegments, removeContentSegment, transitionShardPlacement,
  refreshPhysicalStorageTotals,
} from "./segment-service.js";
import {
  finalizeLocalFileDeletion, listPendingFileDeletions, updateFileDeletionOrders,
} from "./metadata-service.js";
import { deleteLocalManifest } from "../network/manifest-discovery.js";
import { publishControlObject, queryAnchors } from "../network/anchor-service.js";
import { canonicalHashHex } from "../security/signing.js";

const ACTIVE = new Set(["pending", "stored", "verified", "suspect", "unavailable", "surplus", "retiring", "deleting"]);
const DISTRIBUTED_DELETE_TTL_MS = 30 * 86400000;

function payloads(rows) { return (rows || []).map((row) => row?.payload || row).filter(Boolean); }

async function matchingPlacements(vaultId, nodeId, shardHash) {
  const result = [];
  for (const segment of await listContentSegments(vaultId)) {
    for (const shard of segment.segment_shards || []) {
      if (shard.shard_hash !== shardHash) continue;
      for (const placement of shard.shard_placements || []) {
        if (placement.node_id === nodeId) result.push({ segment, shard, placement });
      }
    }
  }
  return result;
}

export async function publishDistributedDeletionOrders(items = []) {
  let published = 0;
  for (const item of items) {
    const authorization = item?.authorization;
    if (!item?.placementId || !authorization?.nodeId || !(await verifyDeletionAuthorization(authorization))) continue;
    const order = {
      orderId: await canonicalHashHex({ placementId: item.placementId, authorization }),
      placementId: item.placementId, vaultId: authorization.vaultId,
      nodeId: authorization.nodeId, shardHash: authorization.shardHash,
      authorization, createdAt: Date.now(),
    };
    if (await publishControlObject("deletion-order", authorization.nodeId, order, DISTRIBUTED_DELETE_TTL_MS).catch(() => null)) published += 1;
  }
  return published;
}

export async function processDistributedDeletionOrders(nodeId, limit = 100) {
  if (!nodeId) return 0;
  let deleted = 0;
  for (const order of payloads(await queryAnchors("deletion-order", nodeId, limit).catch(() => []))) {
    if (order.nodeId !== nodeId || !(await verifyDeletionAuthorization(order.authorization, { nodeId, shardHash: order.shardHash }))) continue;
    if (!(await acknowledgeShardDeletion(nodeId, order.shardHash, order.authorization).catch(() => false))) continue;
    const receipt = {
      orderId: order.orderId, placementId: order.placementId, vaultId: order.vaultId,
      nodeId, shardHash: order.shardHash, acknowledgedAt: Date.now(),
    };
    await publishControlObject("deletion-ack", order.vaultId, receipt, DISTRIBUTED_DELETE_TTL_MS).catch(() => null);
    deleted += 1;
  }
  return deleted;
}

export async function applyDistributedDeletionAcks(vaultId, limit = 200) {
  if (!vaultId) return 0;
  const receipts = payloads(await queryAnchors("deletion-ack", vaultId, limit).catch(() => []));
  let applied = 0;
  for (const receipt of receipts) {
    if (receipt.vaultId !== vaultId || !receipt.placementId) continue;
    try { await transitionShardPlacement(vaultId, receipt.placementId, "deleted"); applied += 1; } catch {}
  }
  return applied;
}

export async function hashHasPhysicalPlacementOnNode(nodeId, shardHash, excludedPlacementIds = []) {
  const excluded = new Set(excludedPlacementIds);
  for (const segment of await listContentSegments()) {
    for (const shard of segment.segment_shards || []) {
      if (shard.shard_hash !== shardHash) continue;
      if ((shard.shard_placements || []).some((placement) => placement.node_id === nodeId && ACTIVE.has(placement.status) && !excluded.has(placement.id))) return true;
    }
  }
  return false;
}

export async function deleteShardIfUnreferenced(nodeId, shardHash, excludedPlacementIds = []) {
  if (!shardHash) return false;
  if (nodeId && await hashHasPhysicalPlacementOnNode(nodeId, shardHash, excludedPlacementIds)) return false;
  return withShardMutationLock(shardHash, async () => {
    if (!(await hasShard(shardHash))) return true;
    await deleteShard(shardHash); return true;
  });
}

export async function acknowledgeShardDeletion(nodeId, shardHash, authorization) {
  if (!(await verifyDeletionAuthorization(authorization, { nodeId, shardHash }))) return false;
  const matches = await matchingPlacements(authorization.vaultId, nodeId, shardHash);
  const eligible = matches.filter(({ placement }) => placement.status === "deleting" && placement.deletion_authorization?.signature === authorization.signature);
  if (!eligible.length) return !(await hasShard(shardHash));
  const ids = eligible.map(({ placement }) => placement.id);
  if (!(await deleteShardIfUnreferenced(nodeId, shardHash, ids))) return false;
  for (const { segment, placement } of eligible) {
    await transitionShardPlacement(authorization.vaultId, placement.id, "deleted").catch(() => {});
    await refreshPhysicalStorageTotals(authorization.vaultId, segment.id).catch(() => {});
  }
  return true;
}

export async function acknowledgeLifecycleShardDeletion(nodeId, shardHash) {
  const eligible = [];
  for (const segment of await listContentSegments()) for (const shard of segment.segment_shards || []) {
    if (shard.shard_hash !== shardHash) continue;
    for (const placement of shard.shard_placements || []) if (placement.node_id === nodeId && ["retiring", "deleting"].includes(placement.status)) eligible.push({ segment, placement });
  }
  if (!eligible.length) return !(await hasShard(shardHash));
  const ids = eligible.map(({ placement }) => placement.id);
  if (!(await deleteShardIfUnreferenced(nodeId, shardHash, ids))) return false;
  for (const { segment, placement } of eligible) {
    await transitionShardPlacement(segment.vault_id, placement.id, "deleted").catch(() => {});
    await refreshPhysicalStorageTotals(segment.vault_id, segment.id).catch(() => {});
  }
  return true;
}

export async function processPendingLocalDeletions(nodeId, limit = 100) {
  let acknowledged = 0;
  for (const segment of await listContentSegments()) for (const shard of segment.segment_shards || []) {
    for (const placement of shard.shard_placements || []) {
      if (acknowledged >= limit || placement.node_id !== nodeId || placement.status !== "deleting" || !placement.deletion_authorization) continue;
      if (await acknowledgeShardDeletion(nodeId, shard.shard_hash, placement.deletion_authorization).catch(() => false)) acknowledged += 1;
    }
  }
  return acknowledged;
}

export async function processPendingLifecycleDeletions(nodeId, limit = 100) {
  let acknowledged = 0;
  for (const segment of await listContentSegments()) for (const shard of segment.segment_shards || []) {
    for (const placement of shard.shard_placements || []) {
      if (acknowledged >= limit || placement.node_id !== nodeId || !["retiring", "deleting"].includes(placement.status) || placement.deletion_authorization) continue;
      if (await acknowledgeLifecycleShardDeletion(nodeId, shard.shard_hash).catch(() => false)) acknowledged += 1;
    }
  }
  return acknowledged;
}

export async function refreshFileDeletionProgress(vaultId, fileId, { finalize = true } = {}) {
  await applyDistributedDeletionAcks(vaultId).catch(() => 0);
  const file = (await listPendingFileDeletions(vaultId)).find((row) => row.id === fileId);
  if (!file) return { fileId, total: 0, acknowledged: 0, pending: 0, complete: true };
  const orders = file.deletion_orders || [];
  const segments = await listContentSegments(vaultId);
  const placementStatus = new Map();
  for (const segment of segments) for (const shard of segment.segment_shards || []) for (const placement of shard.shard_placements || []) placementStatus.set(placement.id, placement.status);
  const updated = orders.map((order) => ({ ...order, status: placementStatus.get(order.placementId) === "deleted" ? "deleted" : order.status || "deleting" }));
  await updateFileDeletionOrders(vaultId, fileId, updated);
  const acknowledged = updated.filter((row) => row.status === "deleted").length;
  const pending = Math.max(0, updated.length - acknowledged);
  if (finalize && pending === 0) {
    for (const segment of segments.filter((row) => row.status === "deleting")) await removeContentSegment(vaultId, segment.id).catch(() => {});
    for (const version of file.file_versions || []) if (version.manifest_id) await deleteLocalManifest(version.manifest_id).catch(() => {});
    await finalizeLocalFileDeletion(vaultId, fileId);
  }
  return { fileId, total: updated.length, acknowledged, pending, complete: pending === 0 };
}

export async function retryPendingVaultDeletions(vaultId, nodeId, peers = []) {
  if (!vaultId) return 0;
  await processDistributedDeletionOrders(nodeId).catch(() => 0);
  await processPendingLocalDeletions(nodeId).catch(() => 0);
  await processPendingLifecycleDeletions(nodeId).catch(() => 0);
  await applyDistributedDeletionAcks(vaultId).catch(() => 0);
  let changed = 0;
  for (const file of await listPendingFileDeletions(vaultId)) {
    for (const order of file.deletion_orders || []) {
      if (order.status === "deleted") continue;
      const authorization = order.authorization;
      if (!authorization) continue;
      if (authorization.nodeId === nodeId) {
        if (await acknowledgeShardDeletion(nodeId, authorization.shardHash, authorization).catch(() => false)) changed += 1;
        continue;
      }
      const peer = peers.find((entry) => entry.nodeId === authorization.nodeId);
      if (peer && await peer.protocol.requestDelete(authorization.shardHash, authorization).catch(() => false)) {
        await transitionShardPlacement(vaultId, order.placementId, "deleted").catch(() => {}); changed += 1;
      }
    }
    await refreshFileDeletionProgress(vaultId, file.id).catch(() => {});
  }
  return changed;
}
