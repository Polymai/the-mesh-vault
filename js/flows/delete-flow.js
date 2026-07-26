import { createTask } from "../ui/task-state.js";
import { getFileBundle, tombstoneFile, forgetCachedFile } from "../services/metadata-service.js";
import { getVersionSegments } from "../services/segment-service.js";
import { appTable } from "../services/supabase.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { currentNode } from "../network/node-service.js";
import { recordAudit } from "../services/audit-service.js";
import { appendOperation } from "../oplog/oplog-engine.js";
import { OP_TYPES } from "../oplog/operation-types.js";
import { buildDeletionAuthorization } from "../security/deletion-authorization.js";
import { retryPendingVaultDeletions, refreshFileDeletionProgress } from "../services/deletion-service.js";

export async function deleteFile(fileId, { vaultIdentity } = {}) {
  const task = createTask("Starting verified mesh deletion", 90000);
  const vaultId = vaultIdentity?.vaultId || null;
  const signer = vaultIdentity ? { publicKey: vaultIdentity.ownerPublicKey, algorithm: vaultIdentity.algorithm, sign: vaultIdentity.sign } : null;
  try {
    if (!vaultId || !signer) throw new Error("Open this file from its owning vault.");
    const bundle = await getFileBundle(vaultId, fileId);
    const versions = bundle.file.file_versions || [bundle.version];
    const links = (await Promise.all(versions.map((version) => getVersionSegments(vaultId, version.id)))).flat();
    const manifestIds = versions.map((version) => version.manifest_id).filter(Boolean);
    const groups = new Map();
    for (const link of links) {
      const segment = link.content_segments; const entry = groups.get(segment.id) || { segment, links: [] };
      entry.links.push(link); groups.set(segment.id, entry);
    }

    const authorizations = [];
    for (const { segment, links: segmentLinks } of groups.values()) {
      if (Number(segment.reference_count || 1) > segmentLinks.length) continue;
      const { data: allShards, error: shardError } = await appTable("segment_shards").select("id,shard_hash,shard_placements(*)").eq("vault_id", vaultId).eq("content_segment_id", segment.id);
      if (shardError) throw shardError;
      for (const shard of allShards || []) for (const placement of shard.shard_placements || []) {
        if (placement.status === "deleted") continue;
        authorizations.push({
          placementId: placement.id,
          authorization: await buildDeletionAuthorization({
            vaultId, fileId, manifestId: manifestIds[0] || null,
            shardHash: shard.shard_hash, nodeId: placement.node_id,
          }, signer),
        });
      }
    }

    for (const manifestId of manifestIds) {
      const { error } = await appTable("capability_links").update({ revoked: true }).eq("manifest_id", manifestId);
      if (error) throw new Error("Active share links could not be revoked; deletion was not started.");
    }

    // Persist every signed deletion order before hiding the file. If the browser
    // closes after the tombstone, another owner session can safely resume.
    for (const item of authorizations) {
      const { error } = await appTable("shard_placements")
        .update({ deletion_authorization: item.authorization })
        .eq("vault_id", vaultId).eq("id", item.placementId);
      if (error) throw error;
    }
    await tombstoneFile(vaultId, fileId);

    let processed = 0;
    for (const { segment, links: segmentLinks } of groups.values()) {
      const nextReferences = Math.max(0, Number(segment.reference_count || 1) - segmentLinks.length);
      if (nextReferences > 0) {
        const linkIds = segmentLinks.map((link) => link.id);
        const { error: referenceError } = await appTable("content_segments").update({ reference_count: nextReferences }).eq("vault_id", vaultId).eq("id", segment.id);
        if (referenceError) throw referenceError;
        if (linkIds.length) {
          const { error: linkError } = await appTable("version_segments").delete().eq("vault_id", vaultId).in("id", linkIds);
          if (linkError) throw linkError;
        }
      } else {
        const { error: segmentError } = await appTable("content_segments").update({ status: "deleting", reference_count: 0 }).eq("vault_id", vaultId).eq("id", segment.id);
        if (segmentError) throw segmentError;
      }
      processed += 1; task.progress(processed / Math.max(1, groups.size), `Prepared stored object ${processed} of ${groups.size}`);
    }
    for (const item of authorizations) {
      const { error } = await appTable("shard_placements").update({ status: "deleting" }).eq("vault_id", vaultId).eq("id", item.placementId);
      if (error) throw error;
      await appTable("fragment_location_cache").delete().eq("shard_hash", item.authorization.shardHash);
    }

    const node = currentNode(); const peers = connectedProtocols();
    await retryPendingVaultDeletions(vaultId, node?.id || null, peers);
    const progress = await refreshFileDeletionProgress(vaultId, fileId).catch(() => null)
      || { fileId, total: authorizations.length, acknowledged: authorizations.length, pending: 0, complete: true };
    await forgetCachedFile(fileId);
    await appendOperation(signer, vaultId, OP_TYPES.DELETE_FILE, { fileId, manifestIds, shardHashes: [...new Set(authorizations.map((row) => row.authorization.shardHash))] }).catch(() => {});
    const pending = progress?.pending || 0;
    task.done(pending ? `File removed; waiting for ${pending} offline shard ${pending === 1 ? "copy" : "copies"}` : "File and all known shard copies deleted");
    await recordAudit(vaultId, "file.delete", "success", { fileId, segments: links.length, pendingPlacements: pending });
    return progress;
  } catch (error) {
    task.fail(error); await recordAudit(vaultId, "file.delete", "failure", { fileId }).catch(() => {}); throw error;
  }
}
