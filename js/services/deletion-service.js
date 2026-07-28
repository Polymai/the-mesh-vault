import { appTable } from "./supabase.js";
import { deleteShard } from "../storage/fragment-store.js";
import { verifyDeletionAuthorization } from "../security/deletion-authorization.js";
import { refreshPhysicalStorageTotals } from "./segment-service.js";
import { deleteLocalManifest } from "../network/manifest-discovery.js";

const NOT_PHYSICAL = new Set(["deleted", "deleting", "retiring"]);

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

export async function acknowledgeShardDeletion(nodeId, shardHash, authorization) {
  if (!nodeId || !shardHash || !(await verifyDeletionAuthorization(authorization, { nodeId, shardHash }))) return false;
  const deleting = (await placementRowsForHash(nodeId, shardHash, "deleting"))
    .filter((row) => row.vault_id === authorization.vaultId && row.deletion_authorization?.signature === authorization.signature);
  if (!deleting.length) {
    const rows = await placementRowsForHash(nodeId, shardHash);
    return rows.some((row) => row.vault_id === authorization.vaultId && row.status === "deleted" && row.deletion_authorization?.signature === authorization.signature);
  }
  const all = await placementRowsForHash(nodeId, shardHash);
  const deletingIds = new Set(deleting.map((row) => row.id));
  const stillReferencedOnNode = all.some((row) => !deletingIds.has(row.id) && !NOT_PHYSICAL.has(row.status));
  if (!stillReferencedOnNode) await deleteShard(shardHash).catch(() => {});
  const { error: locationError } = await appTable("fragment_location_cache").delete().eq("shard_hash", shardHash).eq("node_id", nodeId);
  if (locationError) throw locationError;
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
  const stillReferencedOnNode = rows.some((row) => !eligibleIds.has(row.id) && !NOT_PHYSICAL.has(row.status));
  if (!stillReferencedOnNode) await deleteShard(shardHash).catch(() => {});
  const { error: locationError } = await appTable("fragment_location_cache").delete().eq("shard_hash", shardHash).eq("node_id", nodeId);
  if (locationError) throw locationError;
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
