import { appTable } from "./supabase.js";
import { encryptJson, decryptJson } from "../security/keyring.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const CACHE_DB = `${prefix}metadata-cache-v1`; const CACHE_STORE = "files";
async function cacheDatabase() { return new Promise((resolve, reject) => { const request = indexedDB.open(CACHE_DB, 1); request.onupgradeneeded = () => request.result.createObjectStore(CACHE_STORE, { keyPath: "id" }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function cacheAction(action, mode = "readonly") { const db = await cacheDatabase(); return new Promise((resolve, reject) => { const tx = db.transaction(CACHE_STORE, mode); const request = action(tx.objectStore(CACHE_STORE)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function cacheFile(row) { if (row?.id) await cacheAction((store) => store.put(structuredClone(row)), "readwrite").catch(() => {}); return row; }
async function cachedFile(fileId) { return cacheAction((store) => store.get(fileId)).catch(() => null); }
async function cachedFiles(vaultId) { const rows = await cacheAction((store) => store.getAll()).catch(() => []); return rows.filter((row) => row.vault_id === vaultId && !row.deleted_at); }
export async function forgetCachedFile(fileId) { await cacheAction((store) => store.delete(fileId), "readwrite").catch(() => {}); }
async function decryptFileRow(row) { const version = (row.file_versions || []).find((item) => item.version_number === row.current_version) || null; try { return { ...row, ...(await decryptJson(row.encrypted_metadata)), version }; } catch { return { ...row, name: "Locked file", mime: "application/octet-stream", version }; } }

export async function listFolders(vaultId, parentId = null) {
  let query = appTable("folders").select("*").eq("vault_id", vaultId).order("created_at");
  query = parentId ? query.eq("parent_id", parentId) : query.is("parent_id", null);
  const { data, error } = await query; if (error) throw error;
  return Promise.all((data || []).map(async (row) => ({ ...row, name: (await decryptJson(row.encrypted_name)).name })));
}
export async function createFolder(vaultId, name, parentId = null) {
  const cleaned = name.trim().slice(0, 100); if (!cleaned) throw new Error("Enter a folder name.");
  const encrypted_name = await encryptJson({ name: cleaned }, "folder-name");
  const { data, error } = await appTable("folders").insert({ vault_id: vaultId, parent_id: parentId, encrypted_name }).select().single();
  if (error) throw error; return { ...data, name: cleaned };
}
export async function getFolderDeletionPlan(vaultId, folderId) {
  const { data: folders, error: folderError } = await appTable("folders")
    .select("id,parent_id,encrypted_name").eq("vault_id", vaultId);
  if (folderError) throw folderError;
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
  const { data: files, error: fileError } = await appTable("files")
    .select("id,folder_id").eq("vault_id", vaultId).is("deleted_at", null).in("folder_id", [...folderIds]);
  if (fileError) throw fileError;
  let name = "Folder";
  try { name = (await decryptJson(root.encrypted_name)).name || name; } catch {}
  return { folderId, name, folderIds: [...folderIds], fileIds: (files || []).map((file) => file.id) };
}
export async function deleteFolderRecord(vaultId, folderId) {
  const { error } = await appTable("folders").delete().eq("vault_id", vaultId).eq("id", folderId);
  if (error) throw error;
}
export async function listFiles(vaultId, folderId = null) {
  let query = appTable("files").select("*,file_versions(*)").eq("vault_id", vaultId).is("deleted_at", null).order("created_at", { ascending: false });
  query = folderId ? query.eq("folder_id", folderId) : query.is("folder_id", null);
  const { data, error } = await query; const rows = error ? await cachedFiles(vaultId) : (data || []);
  if (!error) await Promise.all(rows.map(cacheFile));
  return Promise.all(rows.filter((row) => folderId ? row.folder_id === folderId : !row.folder_id).map(decryptFileRow));
}
export async function listPendingFileDeletions(vaultId) {
  const { data, error } = await appTable("files").select("*,file_versions(*)").eq("vault_id", vaultId).eq("status", "deleting").not("deleted_at", "is", null).is("deletion_completed_at", null).order("deleted_at", { ascending: false });
  if (error) throw error;
  return Promise.all((data || []).map(decryptFileRow));
}
export async function createFileRecord({ vaultId, folderId, metadata, sizeBytes }) {
  const encrypted_metadata = await encryptJson(metadata, "file-metadata");
  const { data, error } = await appTable("files").insert({ vault_id: vaultId, folder_id: folderId, encrypted_metadata, size_bytes: sizeBytes, status: "local_pending" }).select().single();
  if (error) throw error; await cacheFile({ ...data, file_versions: [] }); return data;
}
export async function createFileVersion({ vaultId, fileId, originalSizeBytes }) {
  const { data, error } = await appTable("file_versions").insert({ vault_id: vaultId, file_id: fileId, version_number: 1, format_version: 1, original_size_bytes: originalSizeBytes, recovery_status: "local_pending" }).select().single();
  if (error) throw error; const file = await cachedFile(fileId); if (file) await cacheFile({ ...file, file_versions: [data, ...(file.file_versions || []).filter((item) => item.id !== data.id)] }); return data;
}
export async function finalizeFileVersion(vaultId, versionId, fileId, values) {
  let { data, error } = await appTable("file_versions").update(values).eq("vault_id", vaultId).eq("id", versionId).select().single();
  if (error && /country_count|region_count|network_domain_count|repair_threshold_shards|physical_shard_copies|surplus_placements/i.test(`${error.message || ""} ${error.details || ""}`)) { const compatible = { ...values }; delete compatible.country_count; delete compatible.region_count; delete compatible.network_domain_count; delete compatible.repair_threshold_shards; delete compatible.physical_shard_copies; delete compatible.surplus_placements; ({ data, error } = await appTable("file_versions").update(compatible).eq("vault_id", vaultId).eq("id", versionId).select().single()); }
  if (error) throw error;
  const { error: fileError } = await appTable("files").update({ status: values.recovery_status }).eq("vault_id", vaultId).eq("id", fileId); if (fileError) throw fileError; const file = await cachedFile(fileId); if (file) await cacheFile({ ...file, status: values.recovery_status, file_versions: (file.file_versions || []).map((item) => item.id === versionId ? { ...item, ...data } : item) }); return data;
}
export async function getFileBundle(vaultId, fileId) {
  const { data: remoteFile, error } = await appTable("files").select("*,file_versions(*)").eq("vault_id", vaultId).eq("id", fileId).maybeSingle();
  const file = error || !remoteFile ? await cachedFile(fileId) : await cacheFile(remoteFile); if (!file || file.vault_id !== vaultId) throw error || new Error("This file is not available in the local metadata cache.");
  const version = (file.file_versions || []).find((item) => item.version_number === file.current_version); if (!version) throw new Error("This file version is not available locally.");
  return { file: { ...file, ...(await decryptJson(file.encrypted_metadata)) }, version };
}
export async function markExactRecovery(vaultId, versionId) {
  const verifiedAt = new Date().toISOString(); const rows = await cachedFiles(vaultId); const file = rows.find((row) => (row.file_versions || []).some((item) => item.id === versionId)); if (file) await cacheFile({ ...file, file_versions: file.file_versions.map((item) => item.id === versionId ? { ...item, exact_recovery_verified_at: verifiedAt } : item) }); try { await appTable("file_versions").update({ exact_recovery_verified_at: verifiedAt }).eq("vault_id", vaultId).eq("id", versionId); } catch {} return verifiedAt;
}
export async function setFileStatus(vaultId, fileId, status) { const { error } = await appTable("files").update({ status }).eq("vault_id", vaultId).eq("id", fileId); if (error) throw error; }
export async function tombstoneFile(vaultId, fileId) { const deletedAt = new Date().toISOString(); const { error } = await appTable("files").update({ status: "deleting", deleted_at: deletedAt }).eq("vault_id", vaultId).eq("id", fileId); if (error) throw error; const file = await cachedFile(fileId); if (file) await cacheFile({ ...file, status: "deleting", deleted_at: deletedAt }); }
export function filterAndSortFiles(files, search = "", sort = "newest") {
  const q = search.trim().toLocaleLowerCase(); const rows = q ? files.filter((file) => file.name?.toLocaleLowerCase().includes(q)) : [...files];
  rows.sort(sort === "name" ? (a, b) => a.name.localeCompare(b.name) : sort === "size" ? (a, b) => b.size_bytes - a.size_bytes : (a, b) => new Date(b.created_at) - new Date(a.created_at)); return rows;
}
