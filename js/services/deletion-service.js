import { appTable } from "./supabase.js";
import { withShardMutationLock } from "../storage/fragment-store.js";
import { verifyDeletionAuthorization } from "../security/deletion-authorization.js";
import { refreshPhysicalStorageTotals } from "./segment-service.js";
import { deleteLocalManifest } from "../network/manifest-discovery.js";
import { publishControlObject, queryAnchors } from "../network/anchor-service.js";
import { canonicalHashHex } from "../security/signing.js";

const NOT_PHYSICAL = new Set(["deleted", "deleting", "retiring"]);
const DISTRIBUTED_DELETE_TTL_MS = 30 * 86400000;

export async function publishDistributedDeletionOrders(items = []) {
  let published = 0;
  for (const item of items) {
    const authorization = item?.authorization;
    if (!item?.placementId || !authorization?.nodeId || !(await verifyDeletionAuthorization(authorization))) continue;
    const order = {
      orderId: await canonicalHashHex({ placementId: item.placementId, authorization }),
      placementId: item.placementId,
      vaultId: authorization.vaultId,
      nodeId: authorization.nodeId,
      shardHash: authorization.shardHash,
      authorization,
      createdAt: Date.now(),
    };
    const stored = await publishControlObject("deletion-order", authorization.nodeId, order, DISTRIBUTED_DELETE_TTL_MS).catch(() => null);
    if (stored) published += 1;
  }
  return published;
}

export async function processDistributedDeletionOrders(nodeId, limit = 100) {
  if (!nodeId) return 0;
  const rows = await queryAnchors("deletion-order", nodeId, limit).catch(() => []);
  let deleted = 0;
  const seen = new Set();
  for (const row of rows) {
    const order = row?.payload;
    if (!order?.orderId || seen.has(order.orderId) || order.nodeId !== nodeId || order.authorization?.nodeId !== nodeId) continue;
    seen.add(order.orderId);
    if (!(await verifyDeletionAuthorization(order.authorization, { nodeId, shardHash: order.shardHash }))) continue;
    const removed = await acknowledgeShardDeletion(nodeId, order.shardHash, order.authorization).catch(() => false);
    if (!removed) continue;
    const receipt = {
      orderId: order.orderId,
      placementId: order.placementId,
      vaultId: order.vaultId,
      nodeId,
      shardHash: order.shardHash,
      authorizationSignature: order.authorization.signature,
      deletedAt: Date.now(),
    };
    const acknowledged = await publishControlObject("deletion-ack", order.vaultId, receipt, DISTRIBUTED_DELETE_TTL_MS).catch(() => null);
    if (acknowledged) deleted += 1;
  }
  return deleted;
}

export async function applyDistributedDeletionAcks(vaultId, limit = 200) {
  if (!vaultId) return 0;
  const rows = await queryAnchors("deletion-ack", vaultId, limit).catch(() => []);
  let applied = 0;
  for (const wrapper of rows) {
    const receipt = wrapper?.payload;
    if (!receipt?.placementId || receipt.vaultId !== vaultId || !receipt.nodeId || !receipt.shardHash || !receipt.authorizationSignature) continue;
    let node = null;
    try {
      const result = await appTable("nodes").select("device_public_key").eq("id", receipt.nodeId).maybeSingle();
      if (!result.error) node = result.data;
    } catch {}
    if (!node || node.device_public_key !== wrapper.senderPublicKey) continue;
    const { data: placement, error } = await appTable("shard_placements")
      .select("id,vault_id,node_id,status,deletion_authorization,segment_shards(content_segment_id,shard_hash)")
      .eq("id", receipt.placementId).eq("vault_id", vaultId).maybeSingle();
    if (error || !placement || placement.node_id !== receipt.nodeId || placement.segment_shards?.shard_hash !== receipt.shardHash) continue;
    if (placement.deletion_authorization?.signature !== receipt.authorizationSignature) continue;
    if (!(await verifyDeletionAuthorization(placement.deletion_authorization, { nodeId: receipt.nodeId, shardHash: receipt.shardHash }))) continue;
    if (placement.status !== "deleted") {
      const { error: updateError } = await appTable("shard_placements")
        .update({ status: "deleted", deleted_at: new Date(receipt.deletedAt).toISOString() })
        .eq("id", placement.id).eq("vault_id", vaultId);
      if (updateError) continue;
      // A hash can back another active coding generation on this same node.
      // Preserve its locator whenever any physical placement still needs the
      // shared bytes; lookup failures also fail closed and retain the locator.
      if (!(await hashHasPhysicalPlacementOnNode(receipt.nodeId, receipt.shardHash))) {
        try {
          await appTable("fragment_location_cache").delete().eq("shard_hash", receipt.shardHash).eq("node_id", receipt.nodeId);
        } catch {}
      }
      if (placement.segment_shards?.content_segment_id) {
        await refreshPhysicalStorageTotals(vaultId, placement.segment_shards.content_segment_id).catch(() => {});
      }
    }
    applied += 1;
  }
  return applied;
}

async function placementRowsForHash(nodeId, shardHash, status = null) {
  const { data: shards, error: shardError } = await appTable("segment_shards").select("id,content_segment_id,shard_hash").eq("shard_hash", shardHash);
  if (shardError) throw shardError;
  const byId = new Map((shards || []).map((row) => [row.id, row])); if (!byId.size) return [];
  let query = appTable("shard_placements")
    .select("id,vault_id,shard_id,node_id,status,deletion_authorization")
    .eq("node_id", nodeId).in("shard_id", [...byId.keys()]);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((row) => ({ ...row, segment_shards: byId.get(row.shard_id) })).filter((row) => row.segment_shards);
}

export async function hashHasPhysicalPlacementOnNode(nodeId, shardHash, excludedPlacementIds = []) {
  // Shard bytes are keyed only by hash and can back several coding generations.
  // A metadata lookup failure must preserve bytes rather than guess they are temporary.
  if (!nodeId || !shardHash) return true;
  try {
    const excluded = new Set((excludedPlacementIds || []).filter(Boolean));
    const rows = await placementRowsForHash(nodeId, shardHash);
    return rows.some((row) => !excluded.has(row.id) && !NOT_PHYSICAL.has(row.status));
  } catch {
    return true;
  }
}

export async function deleteShardIfUnreferenced(nodeId, shardHash, excludedPlacementIds = []) {
  return withShardMutationLock(shardHash, async ({ remove }) => {
    if (await hashHasPhysicalPlacementOnNode(nodeId, shardHash, excludedPlacementIds)) return false;
    await remove();
    const { error } = await appTable("fragment_location_cache").delete().eq("shard_hash", shardHash).eq("node_id", nodeId);
    if (error) throw error;
    return true;
  });
}

export async function acknowledgeShardDeletion(nodeId, shardHash, authorization) {
  if (!nodeId || !shardHash || !(await verifyDeletionAuthorization(authorization, { nodeId, shardHash }))) return false;
  const deleting = (await placementRowsForHash(nodeId, shardHash, "deleting"))
    .filter((row) => row.vault_id === authorization.vaultId && row.deletion_authorization?.signature === authorization.signature);
  if (!deleting.length) {
    const rows = await placementRowsForHash(nodeId, shardHash);
    return rows.some((row) => row.vault_id === authorization.vaultId && row.status === "deleted" && row.deletion_authorization?.signature === authorization.signature);
  }
  const deletingIds = new Set(deleting.map((row) => row.id));
  await deleteShardIfUnreferenced(nodeId, shardHash, [...deletingIds]);
  const { error } = await appTable("shard_placements").update({ status: "deleted", deleted_at: new Date().toISOString() }).in("id", [...deletingIds]);
  if (error) throw error;
  const groups = new Map(deleting.map((row) => [row.segment_shards?.content_segment_id, row.vault_id]));
  for (const [segmentId, vaultId] of groups) if (segmentId) await refreshPhysicalStorageTotals(vaultId, segmentId).catch(() => {});
  return true;
}

export async function acknowledgeLifecycleShardDeletion(nodeId, shardHash) {
  const rows = await placementRowsForHash(nodeId, shardHash);
  const eligible = rows.filter((row) => ["retiring", "deleting"].includes(row.status) && !row.deletion_authorization);
  if (!eligible.length) return false;
  const eligibleIds = new Set(eligible.map((row) => row.id));
  await deleteShardIfUnreferenced(nodeId, shardHash, [...eligibleIds]);
  const { error } = await appTable("shard_placements").update({ status: "deleted", deleted_at: new Date().toISOString() }).in("id", [...eligibleIds]);
  if (error) throw error;
  const groups = new Map(eligible.map((row) => [row.segment_shards?.content_segment_id, row.vault_id]));
  for (const [segmentId, vaultId] of groups) if (segmentId) await refreshPhysicalStorageTotals(vaultId, segmentId).catch(() => {});
  return true;
}

export async function processPendingLocalDeletions(nodeId, limit = 100) {
  if (!nodeId) return 0;
  const { data, error } = await appTable("shard_placements")
    .select("deletion_authorization,segment_shards(shard_hash)")
    .eq("node_id", nodeId).eq("status", "deleting").limit(limit);
  if (error) throw error;
  let acknowledged = 0; const seen = new Set();
  for (const row of data || []) {
    const hash = row.segment_shards?.shard_hash; const auth = row.deletion_authorization;
    const key = `${hash}:${auth?.signature || ""}`; if (!hash || !auth || seen.has(key)) continue; seen.add(key);
    if (await acknowledgeShardDeletion(nodeId, hash, auth).catch(() => false)) acknowledged += 1;
  }
  return acknowledged;
}

export async function processPendingLifecycleDeletions(nodeId, limit = 100) {
  if (!nodeId) return 0;
  const { data, error } = await appTable("shard_placements")
    .select("segment_shards(shard_hash)")
    .eq("node_id", nodeId).eq("status", "deleting")
    .is("deletion_authorization", null).limit(limit);
  if (error) throw error;
  let acknowledged = 0; const seen = new Set();
  for (const row of data || []) {
    const hash = row.segment_shards?.shard_hash;
    if (!hash || seen.has(hash)) continue; seen.add(hash);
    if (await acknowledgeLifecycleShardDeletion(nodeId, hash).catch(() => false)) acknowledged += 1;
  }
  return acknowledged;
}

async function deletionBundle(vaultId, fileId) {
  const { data: file, error } = await appTable("files")
    .select("id,vault_id,deletion_total_placements,deletion_acknowledged_placements,file_versions(id,manifest_id)")
    .eq("vault_id", vaultId).eq("id", fileId).eq("status", "deleting").not("deleted_at", "is", null).maybeSingle();
  if (error || !file) return null;
  const versionIds = (file.file_versions || []).map((row) => row.id);
  let links = [];
  if (versionIds.length) {
    const result = await appTable("version_segments")
      .select("content_segment_id,content_segments(id,status,segment_shards(id,shard_hash,shard_placements(id,node_id,status,deletion_authorization)))")
      .eq("vault_id", vaultId).in("file_version_id", versionIds);
    if (result.error) throw result.error; links = result.data || [];
  }
  return { file, links, versionIds, manifestIds: (file.file_versions || []).map((row) => row.manifest_id).filter(Boolean) };
}

export async function refreshFileDeletionProgress(vaultId, fileId, { finalize = true } = {}) {
  const bundle = await deletionBundle(vaultId, fileId); if (!bundle) return null;
  const placements = bundle.links.flatMap((link) => link.content_segments?.segment_shards || []).flatMap((shard) => shard.shard_placements || []).filter((row) => !!row.deletion_authorization);
  const unique = new Map(placements.map((row) => [row.id, row]));
  const total = unique.size; const acknowledged = [...unique.values()].filter((row) => row.status === "deleted").length;
  const { error } = await appTable("files").update({ deletion_total_placements: total, deletion_acknowledged_placements: acknowledged }).eq("vault_id", vaultId).eq("id", fileId);
  if (error) throw error;
  if (finalize && acknowledged === total) await finalizeFileDeletion(bundle);
  return { fileId, total, acknowledged, pending: Math.max(0, total - acknowledged), complete: acknowledged === total };
}

async function finalizeFileDeletion(bundle) {
  const { file, links, versionIds, manifestIds } = bundle;
  const segmentIds = [...new Set(links.map((row) => row.content_segment_id).filter(Boolean))];
  if (versionIds.length) { const { error } = await appTable("version_segments").delete().eq("vault_id", file.vault_id).in("file_version_id", versionIds); if (error) throw error; }
  if (segmentIds.length) { const { error } = await appTable("content_segments").delete().eq("vault_id", file.vault_id).in("id", segmentIds).eq("status", "deleting"); if (error) throw error; }
  for (const manifestId of manifestIds) {
    const { error } = await appTable("capability_links").update({ revoked: true }).eq("manifest_id", manifestId); if (error) throw error;
    await deleteLocalManifest(manifestId).catch(() => {});
  }
  let result = await appTable("files").update({ deletion_completed_at: new Date().toISOString() }).eq("vault_id", file.vault_id).eq("id", file.id); if (result.error) throw result.error;
  result = await appTable("files").delete().eq("vault_id", file.vault_id).eq("id", file.id); if (result.error) throw result.error;
}

export async function retryPendingVaultDeletions(vaultId, nodeId, peers = []) {
  if (!vaultId) return 0;
  await applyDistributedDeletionAcks(vaultId).catch(() => {});
  if (nodeId) await processPendingLocalDeletions(nodeId).catch(() => {});
  const { data: files, error } = await appTable("files").select("id").eq("vault_id", vaultId).eq("status", "deleting").not("deleted_at", "is", null).is("deletion_completed_at", null).limit(20);
  if (error) throw error;
  const peerById = new Map(peers.map((peer) => [peer.nodeId, peer])); let changed = 0;
  for (const file of files || []) {
    const bundle = await deletionBundle(vaultId, file.id); if (!bundle) continue;
    const shards = bundle.links.flatMap((link) => link.content_segments?.segment_shards || []);
    const placements = shards.flatMap((shard) => shard.shard_placements || []);
    const authorizedSegmentIds = [...new Set(bundle.links
      .filter((link) => (link.content_segments?.segment_shards || []).some((shard) => (shard.shard_placements || []).some((placement) => !!placement.deletion_authorization)))
      .map((link) => link.content_segment_id)
      .filter(Boolean))];
    if (authorizedSegmentIds.length) {
      const { error: segmentError } = await appTable("content_segments")
        .update({ status: "deleting", reference_count: 0 })
        .eq("vault_id", vaultId).in("id", authorizedSegmentIds);
      if (segmentError) throw segmentError;
    }
    const resumableIds = placements
      .filter((placement) => placement.deletion_authorization && !["deleting", "deleted"].includes(placement.status))
      .map((placement) => placement.id);
    if (resumableIds.length) {
      const { error: placementError } = await appTable("shard_placements")
        .update({ status: "deleting" }).eq("vault_id", vaultId).in("id", resumableIds);
      if (placementError) throw placementError;
      for (const placement of placements) if (resumableIds.includes(placement.id)) placement.status = "deleting";
    }
    for (const placement of placements) {
      if (placement.status !== "deleting" || !placement.deletion_authorization) continue;
      const shard = shards.find((row) => (row.shard_placements || []).some((candidate) => candidate.id === placement.id));
      const peer = peerById.get(placement.node_id); if (!shard?.shard_hash || !peer) continue;
      if (await peer.protocol.requestDelete(shard.shard_hash, placement.deletion_authorization).catch(() => false)) changed += 1;
    }
    await refreshFileDeletionProgress(vaultId, file.id).catch(() => {});
  }
  return changed;
}
