const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}capabilities-v3`;
const STORE = "capabilities";

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "capability_id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idb(action, mode = "readonly") {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    let value;
    request.onsuccess = () => { value = request.result; if (mode === "readonly") resolve(value); };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    if (mode !== "readonly") tx.oncomplete = () => resolve(value);
  });
}

export async function publishCapability(capabilityId, manifestId, encryptedCapabilityMetadata, signature, expiresAt, singleUse, downloadLimit) {
  const row = {
    capability_id: capabilityId,
    manifest_id: manifestId,
    encrypted_capability_metadata: structuredClone(encryptedCapabilityMetadata),
    signature,
    expires_at: new Date(expiresAt).toISOString(),
    single_use: !!singleUse,
    download_limit: downloadLimit || null,
    downloads: 0,
    revoked: false,
  };
  await idb((store) => store.put(row), "readwrite");
  return row;
}

export async function fetchCapability(capabilityId) {
  const row = await idb((store) => store.get(capabilityId)).catch(() => null);
  if (!row || row.revoked || Date.parse(row.expires_at || 0) <= Date.now()) return null;
  return row;
}

export async function redeemCapability(capabilityId) {
  const row = await fetchCapability(capabilityId);
  if (!row) return true;
  row.downloads = Number(row.downloads || 0) + 1;
  await idb((store) => store.put(row), "readwrite");
  return true;
}

export async function revokeCapability(capabilityId) {
  const row = await idb((store) => store.get(capabilityId)).catch(() => null);
  if (!row) return false;
  row.revoked = true;
  await idb((store) => store.put(row), "readwrite");
  return true;
}

export async function hasActiveCapabilityForManifests(manifestIds = []) {
  const wanted = new Set(manifestIds.filter(Boolean));
  if (!wanted.size) return false;
  const rows = await idb((store) => store.getAll()).catch(() => []);
  const now = Date.now();
  return rows.some((row) => wanted.has(row.manifest_id) && !row.revoked && Date.parse(row.expires_at || 0) > now);
}
