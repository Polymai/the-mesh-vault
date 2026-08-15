import { createTask } from "../ui/task-state.js";
import { getFileBundle, forgetCachedFile } from "../services/metadata-service.js";
import { beginAtomicFileDeletion, getVersionSegments } from "../services/segment-service.js";
import { appTable } from "../services/supabase.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { currentNode } from "../network/node-service.js";
import { recordAudit } from "../services/audit-service.js";
import { appendOperation } from "../oplog/oplog-engine.js";
import { OP_TYPES } from "../oplog/operation-types.js";
import { buildDeletionAuthorization } from "../security/deletion-authorization.js";
import {
  publishDistributedDeletionOrders, retryPendingVaultDeletions,
  refreshFileDeletionProgress,
} from "../services/deletion-service.js";

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

    // Signed authorizations are harmless while a placement is active: receiving
    // nodes accept them only after the atomic transaction moves that exact
    // placement to deleting. Prepare every touched placement so a concurrent
    // unlink cannot turn a formerly shared segment into an unsigned orphan.
    let deletion = null;
    for (let attempt = 0; attempt < 3 && !deletion; attempt += 1) {
      const prepared = [];
      for (const { segment } of groups.values()) {
        const { data: allShards, error: shardError } = await appTable("segment_shards").select("id,shard_hash,shard_placements(*)").eq("vault_id", vaultId).eq("content_segment_id", segment.id);
        if (shardError) throw shardError;
        for (const shard of allShards || []) for (const placement of shard.shard_placements || []) {
          if (placement.status === "deleted") continue;
          prepared.push({
            placementId: placement.id,
            authorization: await buildDeletionAuthorization({
              vaultId, fileId, manifestId: manifestIds[0] || null,
              shardHash: shard.shard_hash, nodeId: placement.node_id,
            }, signer),
          });
        }
      }
      for (const item of prepared) {
        const { error } = await appTable("shard_placements")
          .update({ deletion_authorization: item.authorization })
          .eq("vault_id", vaultId).eq("id", item.placementId);
        if (error) throw error;
      }
      try {
        deletion = await beginAtomicFileDeletion(vaultId, fileId);
      } catch (error) {
        if (attempt >= 2 || !/authorizations incomplete/i.test(error?.message || "")) throw error;
      }
    }
    if (!deletion) throw new Error("The atomic file deletion could not be started.");
    const authorizations = deletion.deletionOrders;
    task.progress(.75, `Prepared ${deletion.deletingSegmentIds.length} stored object${deletion.deletingSegmentIds.length === 1 ? "" : "s"}`);

    // Only the transaction's zero-reference placements are now published.
    // Shared segments had their provisional authorizations cleared atomically.
    await publishDistributedDeletionOrders(authorizations).catch(() => {});

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
