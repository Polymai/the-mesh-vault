import { getFolderDeletionPlan, deleteFolderRecord } from "../services/metadata-service.js";
import { deleteFile } from "./delete-flow.js";
import { appendOperation } from "../oplog/oplog-engine.js";
import { OP_TYPES } from "../oplog/operation-types.js";
import { recordAudit } from "../services/audit-service.js";

function identityContext(vaultIdentity) {
  if (!vaultIdentity?.vaultId || !vaultIdentity?.ownerPublicKey || typeof vaultIdentity.sign !== "function") {
    throw new Error("Open this folder from its owning vault.");
  }
  return {
    vaultId: vaultIdentity.vaultId,
    signer: { publicKey: vaultIdentity.ownerPublicKey, algorithm: vaultIdentity.algorithm, sign: vaultIdentity.sign },
  };
}

export async function previewFolderDeletion(folderId, { vaultIdentity } = {}) {
  const { vaultId } = identityContext(vaultIdentity);
  const plan = await getFolderDeletionPlan(vaultId, folderId);
  return { folderId, name: plan.name, fileCount: plan.fileIds.length, folderCount: plan.folderIds.length };
}

export async function deleteFolder(folderId, { vaultIdentity } = {}) {
  const { vaultId, signer } = identityContext(vaultIdentity);
  const plan = await getFolderDeletionPlan(vaultId, folderId);
  const results = [];
  try {
    for (const fileId of plan.fileIds) results.push(await deleteFile(fileId, { vaultIdentity }));
    await deleteFolderRecord(vaultId, plan.folderIds);
    await appendOperation(signer, vaultId, OP_TYPES.DELETE_FOLDER, {
      folderId, descendantFolderIds: plan.folderIds, deletedFileIds: plan.fileIds,
    }).catch(() => {});
    const pending = results.reduce((sum, result) => sum + Number(result?.pending || 0), 0);
    const total = results.reduce((sum, result) => sum + Number(result?.total || 0), 0);
    const acknowledged = results.reduce((sum, result) => sum + Number(result?.acknowledged || 0), 0);
    await recordAudit(vaultId, "folder.delete", "success", {
      folderId, folders: plan.folderIds.length, files: plan.fileIds.length, pendingPlacements: pending,
    });
    return {
      kind: "folder", name: plan.name, folderCount: plan.folderIds.length,
      fileCount: plan.fileIds.length, fileIds: plan.fileIds,
      pending, total, acknowledged, complete: pending === 0,
    };
  } catch (error) {
    await recordAudit(vaultId, "folder.delete", "failure", { folderId }).catch(() => {});
    throw error;
  }
}
