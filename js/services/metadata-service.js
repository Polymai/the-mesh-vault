import { appTable } from "./supabase.js";
import { encryptJson, decryptJson } from "../security/keyring.js";
import {
  appendCatalogOperation, loadVaultCatalog, removeCatalogRow,
  publishVaultCatalog, replaceCatalogSection, upsertCatalogRow,
} from "../control/control-repository.js";
import { OP_TYPES } from "../oplog/operation-types.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const CACHE_DB = `${prefix}metadata-cache-v3`; const CACHE_STORE = "files";
const fileMetadataAad = (row) => `themeshvault/v3/file-metadata:${row.vault_id}:${row.id}`;
const folderNameAad = (row) => `themeshvault/v3/folder-name:${row.vault_id}:${row.id}`;
async function cacheDatabase() { return new Promise((resolve, reject) => { const request = indexedDB.open(CACHE_DB, 1); request.onupgradeneeded = () => request.result.createObjectStore(CACHE_STORE, { keyPath: "id" }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function cacheAction(action, mode = "readonly") { const db = await cacheDatabase(); return new Promise((resolve, reject) => { const tx = db.transaction(CACHE_STORE, mode); const request = action(tx.objectStore(CACHE_STORE)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function cacheFile(row) { if (row?.id) await cacheAction((store) => store.put(structuredClone(row)), "readwrite").catch(() => {}); return row; }
async function cachedFile(fileId) { return cacheAction((store) => store.get(fileId)).catch(() => null); }
async function cachedFiles(vaultId) { const rows = await cacheAction((store) => store.getAll()).catch(() => []); return rows.filter((row) => row.vault_id === vaultId && !row.deleted_at); }
export async function forgetCachedFile(fileId) { await cacheAction((store) => store.delete(fileId), "readwrite").catch(() => {}); }
async function decryptFileRow(row) { const version = (row.file_versions || []).find((item) => item.version_number === row.current_version) || null; try { return { ...row, ...(await decryptJson(row.encrypted_metadata, fileMetadataAad(row))), version }; } catch { return { ...row, name: "Locked file", mime: "application/octet-stream", version }; } }
async function indexedSection(section, vaultId, { includeSupabase = false } = {}) {
  const opened = await loadVaultCatalog({ includeSupabase, includeAnchors: includeSupabase }).catch(() => null);
  return {
    available: !!opened?.envelope,
    rows: (opened?.payload?.[section] || []).filter((row) => row.vault_id === vaultId),
  };
}
async function indexedRows(section, vaultId, options) {
  return (await indexedSection(section, vaultId, options)).rows;
}
function mirrorSection(section, rows) { replaceCatalogSection(section, rows).catch(() => {}); }
function mirrorRow(section, row) { upsertCatalogRow(section, row).catch(() => {}); }

export async function backfillVaultCatalog(vaultId) {
  const [folderResult, fileResult, current] = await Promise.all([
    appTable("folders").select("*").eq("vault_id", vaultId).order("created_at"),
    appTable("files").select("*,file_versions(*)").eq("vault_id", vaultId).order("created_at", { ascending: false }),
    loadVaultCatalog().catch(() => null),
  ]);
  if (folderResult.error) throw folderResult.error;
  if (fileResult.error) throw fileResult.error;
  const files = fileResult.data || [];
  await Promise.all(files.map(cacheFile));
  return publishVaultCatalog({
    folders: folderResult.data || [],
    files,
    tombstones: [
      ...(current?.payload?.tombstones || []),
      ...files.filter((file) => !!file.deleted_at).map((file) => ({
      id: file.id,
      vault_id: file.vault_id,
      deleted_at: file.deleted_at,
      deletion_completed_at: file.deletion_completed_at || null,
      })),
    ].filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index),
    repairState: current?.payload?.repairState || [],
  });
}

export async function listFolders(vaultId, parentId = undefined, { preferLocal = true } = {}) {
  const indexed = preferLocal ? await indexedSection("folders", vaultId) : { available: false, rows: [] };
  if (indexed.available) {
    const rows = parentId === undefined ? indexed.rows : indexed.rows.filter((row) => parentId ? row.parent_id === parentId : !row.parent_id);
    return Promise.all(rows.map(async (row) => ({ ...row, name: (await decryptJson(row.encrypted_name, folderNameAad(row))).name })));
  }
  let query = appTable("folders").select("*").eq("vault_id", vaultId).order("created_at");
  if (parentId !== undefined) query = parentId ? query.eq("parent_id", parentId) : query.is("parent_id", null);
  const { data, error } = await query;
  const allRows = error ? await indexedRows("folders", vaultId) : (data || []);
  if (error && !allRows.length) throw error;
  if (!error && parentId === undefined) mirrorSection("folders", allRows);
  const rows = parentId === undefined ? allRows : allRows.filter((row) => parentId ? row.parent_id === parentId : !row.parent_id);
  return Promise.all(rows.map(async (row) => ({ ...row, name: (await decryptJson(row.encrypted_name, folderNameAad(row))).name })));
}
export async function createFolder(vaultId, name, parentId = null) {
  const cleaned = name.trim().slice(0, 100); if (!cleaned) throw new Error("Enter a folder name.");
  const row = { id: crypto.randomUUID(), vault_id: vaultId, parent_id: parentId, created_at: new Date().toISOString() };
  row.encrypted_name = await encryptJson({ name: cleaned }, folderNameAad(row));
  const { data, error } = await appTable("folders").upsert(row, { onConflict: "id", ignoreDuplicates: true }).select().single();
  const stored = data || row;
  if (error) {
    const parentExists = !parentId || (await indexedRows("folders", vaultId)).some((folder) => folder.id === parentId);
    if (!parentExists) throw error;
  }
  mirrorRow("folders", stored);
  await appendCatalogOperation(OP_TYPES.CREATE_FOLDER, { folderId: stored.id, row: stored }).catch(() => {});
  return { ...stored, name: cleaned, pendingSync: !!error };
}
export async function getFolderDeletionPlan(vaultId, folderId) {
  let { data: folders, error: folderError } = await appTable("folders")
    .select("id,parent_id,encrypted_name").eq("vault_id", vaultId);
  if (folderError) folders = await indexedRows("folders", vaultId);
  if (folderError && !folders.length) throw folderError;
  const root = (folders || []).find((folder) => folder.id === folderId);
  if (!root) throw new Error("This folder no longer exists.");
  const folderIds = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders || []) if (folder.parent_id && folderIds.has(folder.parent_id) && !folderIds.has(folder.id)) {
      folderIds.add(folder.id); changed = true;
    }
  }
  let { data: files, error: fileError } = await appTable("files")
    .select("id,folder_id").eq("vault_id", vaultId).is("deleted_at", null).in("folder_id", [...folderIds]);
  if (fileError) files = (await indexedRows("files", vaultId)).filter((file) => !file.deleted_at && folderIds.has(file.folder_id));
  let name = "Folder";
  try { name = (await decryptJson(root.encrypted_name, folderNameAad({ ...root, vault_id: vaultId }))).name || name; } catch {}
  return { folderId, name, folderIds: [...folderIds], fileIds: (files || []).map((file) => file.id) };
}
export async function deleteFolderRecord(vaultId, folderIds) {
  const ids = [...new Set((Array.isArray(folderIds) ? folderIds : [folderIds]).filter(Boolean))];
  if (!ids.length) return;
  const { error } = await appTable("folders").delete().eq("vault_id", vaultId).in("id", ids);
  await Promise.all(ids.map((id) => removeCatalogRow("folders", id).catch(() => {})));
  if (error) {
    const remaining = await indexedRows("folders", vaultId);
    if (remaining.some((folder) => ids.includes(folder.id))) throw error;
  }
}
export async function listFiles(vaultId, folderId = undefined, { preferLocal = true } = {}) {
  const indexed = preferLocal ? await indexedSection("files", vaultId) : { available: false, rows: [] };
  if (indexed.available) {
    const rows = indexed.rows.filter((row) => !row.deleted_at && (folderId === undefined || (folderId ? row.folder_id === folderId : !row.folder_id)));
    await Promise.all(rows.map(cacheFile));
    return Promise.all(rows.map(decryptFileRow));
  }
  let query = appTable("files").select("*,file_versions(*)").eq("vault_id", vaultId).is("deleted_at", null).order("created_at", { ascending: false });
  if (folderId !== undefined) query = folderId ? query.eq("folder_id", folderId) : query.is("folder_id", null);
  const { data, error } = await query;
  let rows = error ? await cachedFiles(vaultId) : (data || []);
  if (error && !rows.length) rows = (await indexedRows("files", vaultId)).filter((row) => !row.deleted_at);
  if (!error) await Promise.all(rows.map(cacheFile));
  if (!error && folderId === undefined) mirrorSection("files", rows);
  return Promise.all(rows.filter((row) => folderId === undefined || (folderId ? row.folder_id === folderId : !row.folder_id)).map(decryptFileRow));
}
export async function moveFileRecord(vaultId, fileId, folderId = null) {
  const patch = { folder_id: folderId, updated_at: new Date().toISOString() };
  const { data, error } = await appTable("files").update(patch).eq("vault_id", vaultId).eq("id", fileId).select().single();
  const file = await cachedFile(fileId);
  const indexed = (await indexedRows("files", vaultId)).find((row) => row.id === fileId);
  if (error && !file && !indexed) throw error;
  const stored = { ...(data || file || indexed), ...patch };
  await cacheFile(stored);
  mirrorRow("files", stored);
  await appendCatalogOperation(OP_TYPES.UPDATE_METADATA, { fileId, patch }).catch(() => {});
  return { ...stored, pendingSync: !!error };
}
export async function listPendingFileDeletions(vaultId, { preferLocal = true } = {}) {
  const indexed = preferLocal ? await indexedSection("files", vaultId) : { available: false, rows: [] };
  if (indexed.available) {
    return Promise.all(indexed.rows
      .filter((row) => row.status === "deleting" && row.deleted_at && !row.deletion_completed_at)
      .map(decryptFileRow));
  }
  const { data, error } = await appTable("files").select("*,file_versions(*)").eq("vault_id", vaultId).eq("status", "deleting").not("deleted_at", "is", null).is("deletion_completed_at", null).order("deleted_at", { ascending: false });
  const rows = error
    ? (await indexedRows("files", vaultId)).filter((row) => row.status === "deleting" && row.deleted_at && !row.deletion_completed_at)
    : (data || []);
  if (error && !rows.length) return [];
  return Promise.all(rows.map(decryptFileRow));
}
export async function createFileRecord({ vaultId, folderId, metadata, sizeBytes }) {
  const now = new Date().toISOString();
  const row = { id: crypto.randomUUID(), vault_id: vaultId, folder_id: folderId, size_bytes: sizeBytes, status: "local_pending", current_version: 1, created_at: now, updated_at: now };
  row.encrypted_metadata = await encryptJson(metadata, fileMetadataAad(row));
  const { data, error } = await appTable("files").upsert(row, { onConflict: "id", ignoreDuplicates: true }).select().single();
  if (error) throw error;
  const stored = { ...data, file_versions: [] };
  await cacheFile(stored); mirrorRow("files", stored);
  await appendCatalogOperation(OP_TYPES.CREATE_FILE, { fileId: data.id, row: data }).catch(() => {});
  return data;
}
export async function createFileVersion({ vaultId, fileId, originalSizeBytes }) {
  const { data, error } = await appTable("file_versions").insert({ vault_id: vaultId, file_id: fileId, version_number: 1, format_version: 3, original_size_bytes: originalSizeBytes, recovery_status: "local_pending" }).select().single();
  if (error) throw error; const file = await cachedFile(fileId); if (file) { const stored = { ...file, file_versions: [data, ...(file.file_versions || []).filter((item) => item.id !== data.id)] }; await cacheFile(stored); mirrorRow("files", stored); } return data;
}
export async function finalizeFileVersion(vaultId, versionId, fileId, values) {
  let { data, error } = await appTable("file_versions").update(values).eq("vault_id", vaultId).eq("id", versionId).select().single();
  if (error && /country_count|region_count|network_domain_count|repair_threshold_shards|physical_shard_copies|surplus_placements/i.test(`${error.message || ""} ${error.details || ""}`)) { const compatible = { ...values }; delete compatible.country_count; delete compatible.region_count; delete compatible.network_domain_count; delete compatible.repair_threshold_shards; delete compatible.physical_shard_copies; delete compatible.surplus_placements; ({ data, error } = await appTable("file_versions").update(compatible).eq("vault_id", vaultId).eq("id", versionId).select().single()); }
  if (error) throw error;
  const { error: fileError } = await appTable("files").update({ status: values.recovery_status }).eq("vault_id", vaultId).eq("id", fileId); if (fileError) throw fileError; const file = await cachedFile(fileId); if (file) { const stored = { ...file, status: values.recovery_status, file_versions: (file.file_versions || []).map((item) => item.id === versionId ? { ...item, ...data } : item) }; await cacheFile(stored); mirrorRow("files", stored); } return data;
}
export async function getFileBundle(vaultId, fileId) {
  const { data: remoteFile, error } = await appTable("files").select("*,file_versions(*)").eq("vault_id", vaultId).eq("id", fileId).maybeSingle();
  const indexed = error || !remoteFile ? (await indexedRows("files", vaultId)).find((row) => row.id === fileId) : null;
  const file = error || !remoteFile ? (await cachedFile(fileId) || indexed) : await cacheFile(remoteFile); if (!file || file.vault_id !== vaultId) throw error || new Error("This file is not available in the signed vault index.");
  const version = (file.file_versions || []).find((item) => item.version_number === file.current_version); if (!version) throw new Error("This file version is not available locally.");
  return { file: { ...file, ...(await decryptJson(file.encrypted_metadata, fileMetadataAad(file))) }, version };
}
export async function markExactRecovery(vaultId, versionId) {
  const verifiedAt = new Date().toISOString(); const rows = await cachedFiles(vaultId); const file = rows.find((row) => (row.file_versions || []).some((item) => item.id === versionId)); if (file) { const stored = { ...file, file_versions: file.file_versions.map((item) => item.id === versionId ? { ...item, exact_recovery_verified_at: verifiedAt } : item) }; await cacheFile(stored); mirrorRow("files", stored); } try { await appTable("file_versions").update({ exact_recovery_verified_at: verifiedAt }).eq("vault_id", vaultId).eq("id", versionId); } catch {} return verifiedAt;
}
export async function setFileStatus(vaultId, fileId, status) { const { error } = await appTable("files").update({ status }).eq("vault_id", vaultId).eq("id", fileId); if (error) throw error; const file = await cachedFile(fileId); if (file) { const stored = { ...file, status }; await cacheFile(stored); mirrorRow("files", stored); } }
export async function tombstoneFile(vaultId, fileId) {
  const deletedAt = new Date().toISOString();
  const { error } = await appTable("files").update({ status: "deleting", deleted_at: deletedAt }).eq("vault_id", vaultId).eq("id", fileId);
  if (error) throw error;
  const file = await cachedFile(fileId);
  if (file) {
    const stored = { ...file, status: "deleting", deleted_at: deletedAt };
    await cacheFile(stored);
    mirrorRow("files", stored);
  }
  mirrorRow("tombstones", {
    id: fileId,
    vault_id: vaultId,
    deleted_at: deletedAt,
    deletion_completed_at: null,
  });
}
export function filterAndSortFiles(files, search = "", sort = "created-desc") {
  const q = search.trim().toLocaleLowerCase(); const rows = q ? files.filter((file) => file.name?.toLocaleLowerCase().includes(q)) : [...files];
  const compare = {
    "name-asc": (a, b) => a.name.localeCompare(b.name),
    "name-desc": (a, b) => b.name.localeCompare(a.name),
    "size-desc": (a, b) => Number(b.size_bytes) - Number(a.size_bytes),
    "size-asc": (a, b) => Number(a.size_bytes) - Number(b.size_bytes),
    "created-asc": (a, b) => new Date(a.created_at) - new Date(b.created_at),
    "created-desc": (a, b) => new Date(b.created_at) - new Date(a.created_at),
  };
  rows.sort(compare[sort] || compare["created-desc"]);
  return rows;
}
