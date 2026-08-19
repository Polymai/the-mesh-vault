import { encryptJson, decryptJson } from "../security/keyring.js";
import {
  appendCatalogOperation, loadVaultCatalog, removeCatalogRow,
  publishVaultCatalog, upsertCatalogRow,
} from "../control/control-repository.js";
import { OP_TYPES } from "../oplog/operation-types.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const CACHE_DB = `${prefix}metadata-cache-v3`;
const CACHE_STORE = "files";
const fileMetadataAad = (row) => `themeshvault/v3/file-metadata:${row.vault_id}:${row.id}`;
const folderNameAad = (row) => `themeshvault/v3/folder-name:${row.vault_id}:${row.id}`;

async function cacheDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(CACHE_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function cacheAction(action, mode = "readonly") {
  const db = await cacheDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, mode);
    const request = action(tx.objectStore(CACHE_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function cacheFile(row) { if (row?.id) await cacheAction((store) => store.put(structuredClone(row)), "readwrite").catch(() => {}); return row; }
async function cachedFile(fileId) { return cacheAction((store) => store.get(fileId)).catch(() => null); }
async function cachedFiles(vaultId) { const rows = await cacheAction((store) => store.getAll()).catch(() => []); return rows.filter((row) => row.vault_id === vaultId); }
export async function forgetCachedFile(fileId) { await cacheAction((store) => store.delete(fileId), "readwrite").catch(() => {}); }

async function catalog() { return loadVaultCatalog({ includeSupabase: false, includeAnchors: false }).catch(() => null); }
async function indexedRows(section, vaultId) {
  const opened = await catalog();
  return (opened?.payload?.[section] || []).filter((row) => row.vault_id === vaultId);
}
async function decryptFileRow(row) {
  const version = (row.file_versions || []).find((item) => item.version_number === row.current_version) || null;
  try { return { ...row, ...(await decryptJson(row.encrypted_metadata, fileMetadataAad(row))), version }; }
  catch { return { ...row, name: "Locked file", mime: "application/octet-stream", version }; }
}

export async function backfillVaultCatalog(_vaultId) {
  const current = await catalog();
  if (current) return current.envelope;
  return publishVaultCatalog({ folders: [], files: [], tombstones: [], repairState: [] });
}

export async function listFolders(vaultId, parentId = undefined) {
  const allRows = await indexedRows("folders", vaultId);
  const rows = parentId === undefined ? allRows : allRows.filter((row) => parentId ? row.parent_id === parentId : !row.parent_id);
  return Promise.all(rows.map(async (row) => ({ ...row, name: (await decryptJson(row.encrypted_name, folderNameAad(row))).name })));
}

export async function createFolder(vaultId, name, parentId = null) {
  const cleaned = name.trim().slice(0, 100);
  if (!cleaned) throw new Error("Enter a folder name.");
  if (parentId && !(await indexedRows("folders", vaultId)).some((folder) => folder.id === parentId)) throw new Error("The parent folder is not available.");
  const row = { id: crypto.randomUUID(), vault_id: vaultId, parent_id: parentId, created_at: new Date().toISOString() };
  row.encrypted_name = await encryptJson({ name: cleaned }, folderNameAad(row));
  await upsertCatalogRow("folders", row);
  await appendCatalogOperation(OP_TYPES.CREATE_FOLDER, { folderId: row.id, row }).catch(() => {});
  return { ...row, name: cleaned };
}

export async function getFolderDeletionPlan(vaultId, folderId) {
  const folders = await indexedRows("folders", vaultId);
  const root = folders.find((folder) => folder.id === folderId);
  if (!root) throw new Error("This folder no longer exists.");
  const folderIds = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) if (folder.parent_id && folderIds.has(folder.parent_id) && !folderIds.has(folder.id)) { folderIds.add(folder.id); changed = true; }
  }
  const files = (await indexedRows("files", vaultId)).filter((file) => !file.deleted_at && folderIds.has(file.folder_id));
  let name = "Folder";
  try { name = (await decryptJson(root.encrypted_name, folderNameAad(root))).name || name; } catch {}
  return { folderId, name, folderIds: [...folderIds], fileIds: files.map((file) => file.id) };
}

export async function deleteFolderRecord(_vaultId, folderIds) {
  const ids = [...new Set((Array.isArray(folderIds) ? folderIds : [folderIds]).filter(Boolean))];
  await Promise.all(ids.map((id) => removeCatalogRow("folders", id)));
}

export async function listFiles(vaultId, folderId = undefined) {
  let rows = (await indexedRows("files", vaultId)).filter((row) => !row.deleted_at);
  if (!rows.length) rows = (await cachedFiles(vaultId)).filter((row) => !row.deleted_at);
  rows = rows.filter((row) => folderId === undefined || (folderId ? row.folder_id === folderId : !row.folder_id));
  await Promise.all(rows.map(cacheFile));
  return Promise.all(rows.map(decryptFileRow));
}

export async function moveFileRecord(vaultId, fileId, folderId = null) {
  const row = (await indexedRows("files", vaultId)).find((file) => file.id === fileId) || await cachedFile(fileId);
  if (!row) throw new Error("This file is not available in the signed vault index.");
  const patch = { folder_id: folderId, updated_at: new Date().toISOString() };
  const stored = { ...row, ...patch };
  await cacheFile(stored); await upsertCatalogRow("files", stored);
  await appendCatalogOperation(OP_TYPES.UPDATE_METADATA, { fileId, patch }).catch(() => {});
  return stored;
}

export async function listPendingFileDeletions(vaultId) {
  return Promise.all((await indexedRows("files", vaultId))
    .filter((row) => row.status === "deleting" && row.deleted_at && !row.deletion_completed_at)
    .map(decryptFileRow));
}

export async function createFileRecord({ vaultId, folderId, metadata, sizeBytes }) {
  const now = new Date().toISOString();
  const row = { id: crypto.randomUUID(), vault_id: vaultId, folder_id: folderId, size_bytes: sizeBytes, status: "local_pending", current_version: 1, created_at: now, updated_at: now, file_versions: [] };
  row.encrypted_metadata = await encryptJson(metadata, fileMetadataAad(row));
  await cacheFile(row); await upsertCatalogRow("files", row);
  await appendCatalogOperation(OP_TYPES.CREATE_FILE, { fileId: row.id, row }).catch(() => {});
  return row;
}

export async function createFileVersion({ vaultId, fileId, originalSizeBytes }) {
  const file = (await indexedRows("files", vaultId)).find((row) => row.id === fileId) || await cachedFile(fileId);
  if (!file) throw new Error("The local file record is unavailable.");
  const version = { id: crypto.randomUUID(), vault_id: vaultId, file_id: fileId, version_number: 1, format_version: 3, original_size_bytes: originalSizeBytes, recovery_status: "local_pending", created_at: new Date().toISOString() };
  const stored = { ...file, file_versions: [version, ...(file.file_versions || []).filter((item) => item.id !== version.id)] };
  await cacheFile(stored); await upsertCatalogRow("files", stored);
  return version;
}

export async function finalizeFileVersion(vaultId, versionId, fileId, values) {
  const file = (await indexedRows("files", vaultId)).find((row) => row.id === fileId) || await cachedFile(fileId);
  if (!file) throw new Error("The local file record is unavailable.");
  const versions = (file.file_versions || []).map((item) => item.id === versionId ? { ...item, ...values } : item);
  const version = versions.find((item) => item.id === versionId);
  if (!version) throw new Error("The local file version is unavailable.");
  const stored = { ...file, status: values.recovery_status || file.status, file_versions: versions, updated_at: new Date().toISOString() };
  await cacheFile(stored); await upsertCatalogRow("files", stored);
  return version;
}

export async function getFileBundle(vaultId, fileId) {
  const file = (await indexedRows("files", vaultId)).find((row) => row.id === fileId) || await cachedFile(fileId);
  if (!file || file.vault_id !== vaultId) throw new Error("This file is not available in the signed vault index.");
  const version = (file.file_versions || []).find((item) => item.version_number === file.current_version);
  if (!version) throw new Error("This file version is not available locally.");
  return { file: { ...file, ...(await decryptJson(file.encrypted_metadata, fileMetadataAad(file))) }, version };
}

async function patchVersion(vaultId, versionId, patch) {
  const file = (await indexedRows("files", vaultId)).find((row) => (row.file_versions || []).some((item) => item.id === versionId));
  if (!file) return null;
  const stored = { ...file, file_versions: file.file_versions.map((item) => item.id === versionId ? { ...item, ...patch } : item) };
  await cacheFile(stored); await upsertCatalogRow("files", stored);
  return stored.file_versions.find((item) => item.id === versionId);
}

export async function markExactRecovery(vaultId, versionId) { const exact_recovery_verified_at = new Date().toISOString(); await patchVersion(vaultId, versionId, { exact_recovery_verified_at }); return exact_recovery_verified_at; }
export async function setFileStatus(vaultId, fileId, status) { const file = (await indexedRows("files", vaultId)).find((row) => row.id === fileId) || await cachedFile(fileId); if (!file) return; const stored = { ...file, status, updated_at: new Date().toISOString() }; await cacheFile(stored); await upsertCatalogRow("files", stored); }
export async function tombstoneFile(vaultId, fileId, deletionOrders = []) {
  const deleted_at = new Date().toISOString();
  const file = (await indexedRows("files", vaultId)).find((row) => row.id === fileId) || await cachedFile(fileId);
  if (!file) throw new Error("This file is not available locally.");
  const stored = {
    ...file, status: "deleting", deleted_at,
    deletion_orders: structuredClone(deletionOrders || []),
    deletion_total_placements: deletionOrders.length,
    deletion_acknowledged_placements: 0,
  };
  await cacheFile(stored);
  await upsertCatalogRow("files", stored);
  await upsertCatalogRow("tombstones", { id: fileId, vault_id: vaultId, deleted_at, deletion_completed_at: null });
  return stored;
}

export async function updateFileDeletionOrders(vaultId, fileId, deletionOrders = []) {
  const file = (await indexedRows("files", vaultId)).find((row) => row.id === fileId) || await cachedFile(fileId);
  if (!file) return null;
  const acknowledged = deletionOrders.filter((row) => row.status === "deleted").length;
  const stored = {
    ...file,
    deletion_orders: structuredClone(deletionOrders),
    deletion_total_placements: deletionOrders.length,
    deletion_acknowledged_placements: acknowledged,
    updated_at: new Date().toISOString(),
  };
  await cacheFile(stored);
  await upsertCatalogRow("files", stored);
  return stored;
}

export async function finalizeLocalFileDeletion(vaultId, fileId) {
  const completedAt = new Date().toISOString();
  await removeCatalogRow("files", fileId);
  await forgetCachedFile(fileId);
  await upsertCatalogRow("tombstones", {
    id: fileId, vault_id: vaultId,
    deletion_completed_at: completedAt,
  });
  return completedAt;
}

export function filterAndSortFiles(files, search = "", sort = "created-desc") {
  const q = search.trim().toLocaleLowerCase();
  const rows = q ? files.filter((file) => file.name?.toLocaleLowerCase().includes(q)) : [...files];
  const compare = {
    "name-asc": (a, b) => a.name.localeCompare(b.name), "name-desc": (a, b) => b.name.localeCompare(a.name),
    "size-desc": (a, b) => Number(b.size_bytes) - Number(a.size_bytes), "size-asc": (a, b) => Number(a.size_bytes) - Number(b.size_bytes),
    "created-asc": (a, b) => new Date(a.created_at) - new Date(b.created_at), "created-desc": (a, b) => new Date(b.created_at) - new Date(a.created_at),
  };
  rows.sort(compare[sort] || compare["created-desc"]);
  return rows;
}
