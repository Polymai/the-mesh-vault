const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}shards-v3`;
const shardFilePrefix = `${prefix.replace(/[^a-z0-9]/gi, "-")}v3-`;
let limitBytes = window.__DATA__?.limits?.defaultContributionBytes || 1073741824;
let opfsRoot = null;
const shardMutationTails = new Map();

// OPFS/IndexedDB shard bytes are content-addressed and may back more than one
// metadata placement. Serialize every local write/delete for a hash so a
// reference check can cover the actual removal without a concurrent put being
// erased immediately afterwards.
export async function withShardMutationLock(id, operation) {
  const key = String(id || "");
  if (!key) throw new Error("A shard hash is required.");
  const previous = shardMutationTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  shardMutationTails.set(key, tail);
  await previous.catch(() => {});
  try {
    return await operation({
      remove: () => deleteShardUnlocked(key),
    });
  } finally {
    release();
    if (shardMutationTails.get(key) === tail) shardMutationTails.delete(key);
  }
}

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("shards", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function idb(action, mode = "readonly") {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("shards", mode);
    const request = action(tx.objectStore("shards"));
    let result;
    request.onsuccess = () => {
      result = request.result;
      if (mode === "readonly") resolve(result);
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Shard storage transaction was aborted."));
    if (mode !== "readonly") tx.oncomplete = () => resolve(result);
  });
}
async function root() {
  if (opfsRoot !== null) return opfsRoot;
  try { opfsRoot = await navigator.storage.getDirectory(); } catch { opfsRoot = false; }
  return opfsRoot;
}
export function setContributionQuota(bytes) { limitBytes = Math.max(0, Number(bytes) || 0); }
export async function storageEstimate() {
  const estimate = await navigator.storage?.estimate?.() || {}; const local = await idb((store) => store.getAll()).catch(() => []); const appUsage=local.reduce((sum,item)=>sum+Number(item.size??item.bytes?.byteLength??0),0);
  return { usage:appUsage,browserUsage:Number(estimate.usage||0),quota:Number(estimate.quota||0),contributionLimit:limitBytes,persistent:await navigator.storage?.persisted?.().catch(()=>false) };
}
export async function requestPersistence() { return navigator.storage?.persist?.() || false; }
async function putShardUnlocked(id, bytes) {
  const data = new Uint8Array(bytes); const estimate = await storageEstimate(); const existing=await idb((store)=>store.get(id)).catch(()=>null); if (estimate.usage-Number(existing?.size||0)+data.byteLength > limitBytes) throw new Error("This device's contribution limit would be exceeded.");
  const directory = await root();
  if (directory) { const handle = await directory.getFileHandle(`${shardFilePrefix}${id}.bin`, { create: true }); const writable = await handle.createWritable(); await writable.write(data); await writable.close(); await idb((store) => store.put({ id, bytes: new Uint8Array(0), opfs: true, size: data.byteLength }), "readwrite"); }
  else await idb((store) => store.put({ id, bytes: data, opfs: false, size: data.byteLength }), "readwrite");
  return data.byteLength;
}
export async function putShard(id, bytes) {
  return withShardMutationLock(id, () => putShardUnlocked(id, bytes));
}
export async function getShard(id) {
  const meta = await idb((store) => store.get(id)); if (!meta) return null;
  if (!meta.opfs) return new Uint8Array(meta.bytes);
  const directory = await root(); if (!directory) return null;
  try { const file = await (await directory.getFileHandle(`${shardFilePrefix}${id}.bin`)).getFile(); return new Uint8Array(await file.arrayBuffer()); } catch { return null; }
}
export async function hasShard(id) { return !!(await idb((store) => store.get(id))); }
async function deleteShardUnlocked(id) {
  const meta = await idb((store) => store.get(id)); if (meta?.opfs) { const directory = await root(); await directory?.removeEntry(`${shardFilePrefix}${id}.bin`).catch(() => {}); }
  await idb((store) => store.delete(id), "readwrite");
}
export async function deleteShard(id) {
  return withShardMutationLock(id, ({ remove }) => remove());
}
export async function clearShards() {
  const rows = await idb((store) => store.getAll()).catch(() => []); for (const row of rows) await deleteShard(row.id); return rows.length;
}
export async function listShardIds() { return (await idb((store) => store.getAllKeys()).catch(() => [])); }
export async function inspectLocalShards({ limit = 100 } = {}) {
  const rows = await idb((store) => store.getAll()).catch(() => []);
  const items = rows
    .map((row) => ({ id: String(row.id || ""), size: Number(row.size ?? row.bytes?.byteLength ?? 0), backend: row.opfs ? "OPFS" : "IndexedDB" }))
    .sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
  const estimate = await storageEstimate();
  return {
    totalCount: items.length,
    totalBytes: items.reduce((sum, item) => sum + item.size, 0),
    opfsCount: items.filter((item) => item.backend === "OPFS").length,
    indexedDbCount: items.filter((item) => item.backend === "IndexedDB").length,
    persistent: estimate.persistent,
    contributionLimit: estimate.contributionLimit,
    browserQuota: estimate.quota,
    items: items.slice(0, Math.max(1, Number(limit) || 100)),
  };
}
