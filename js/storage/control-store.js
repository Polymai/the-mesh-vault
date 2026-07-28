import {
  canonicalBytes, canonicalHashHex, bytesToBase64Url, base64UrlToBytes,
  importPublicKeyRaw, verify as verifySignature,
} from "../security/signing.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}anchor-control-v1`;
const STORE = "objects";
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 31 * 24 * 60 * 60 * 1000;

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "objectId" });
      store.createIndex("by_lookup", ["kind", "lookupKey"]);
      store.createIndex("by_expiry", "expiresAt");
      store.createIndex("by_access", "lastAccessedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(action, mode = "readonly") {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    let result;
    request.onsuccess = () => {
      result = request.result;
      if (mode === "readonly") resolve(result);
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Anchor control storage transaction was aborted."));
    if (mode !== "readonly") tx.oncomplete = () => resolve(result);
  });
}

function signable(object) {
  const { signature, objectId, storedAt, lastAccessedAt, sizeBytes, replicaNodeIds, ...core } = object;
  return core;
}

export async function buildControlObject(signer, kind, lookupKey, payload, { ttlMs = 5 * 60 * 1000 } = {}) {
  if (!signer?.publicKey || !signer?.algorithm || typeof signer.sign !== "function") throw new Error("A device signer is required for control replication.");
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(String(kind || ""))) throw new Error("Invalid control-object kind.");
  const key = String(lookupKey || "").slice(0, 512);
  if (!key) throw new Error("A control-object lookup key is required.");
  const boundedTtl = Math.max(10_000, Math.min(MAX_TTL_MS, Number(ttlMs) || 0));
  const payloadHash = await canonicalHashHex(payload);
  const core = {
    kind, lookupKey: key, payload, payloadHash,
    senderPublicKey: signer.publicKey, algorithm: signer.algorithm,
    createdAt: Date.now(), expiresAt: Date.now() + boundedTtl, protocolVersion: 1,
  };
  const signature = bytesToBase64Url(await signer.sign(canonicalBytes(core)));
  const objectId = await canonicalHashHex({ ...core, signature });
  const object = { objectId, ...core, signature };
  if (canonicalBytes(object).byteLength > MAX_OBJECT_BYTES) throw new Error("Control object exceeds the local cache limit.");
  return object;
}

export async function verifyControlObject(object, { now = Date.now() } = {}) {
  if (!object || typeof object !== "object" || object.protocolVersion !== 1) return { valid: false, reason: "malformed" };
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(String(object.kind || "")) || !String(object.lookupKey || "")) return { valid: false, reason: "malformed" };
  if (!Number.isFinite(object.createdAt) || !Number.isFinite(object.expiresAt) || object.createdAt > now + MAX_CLOCK_SKEW_MS || object.expiresAt <= now || object.expiresAt - object.createdAt > MAX_TTL_MS) return { valid: false, reason: "expired_or_invalid_time" };
  if (canonicalBytes(object).byteLength > MAX_OBJECT_BYTES) return { valid: false, reason: "too_large" };
  if ((await canonicalHashHex(object.payload)) !== object.payloadHash) return { valid: false, reason: "payload_hash_mismatch" };
  const core = signable(object);
  if ((await canonicalHashHex({ ...core, signature: object.signature })) !== object.objectId) return { valid: false, reason: "object_id_mismatch" };
  try {
    const publicKey = await importPublicKeyRaw(base64UrlToBytes(object.senderPublicKey), object.algorithm);
    const valid = await verifySignature(publicKey, object.algorithm, base64UrlToBytes(object.signature), canonicalBytes(core));
    return valid ? { valid: true } : { valid: false, reason: "invalid_signature" };
  } catch { return { valid: false, reason: "invalid_signature" }; }
}

async function removeExpired(now = Date.now()) {
  const rows = await transaction((store) => store.getAll()).catch(() => []);
  await Promise.all(rows.filter((row) => row.expiresAt <= now).map((row) => transaction((store) => store.delete(row.objectId), "readwrite")));
}

async function enforceQuota(maxBytes) {
  await removeExpired();
  const rows = await transaction((store) => store.getAll()).catch(() => []);
  let total = rows.reduce((sum, row) => sum + Number(row.sizeBytes || 0), 0);
  const limit = Math.max(1024 * 1024, Number(maxBytes) || 0);
  for (const row of rows.sort((a, b) => Number(a.lastAccessedAt || a.storedAt) - Number(b.lastAccessedAt || b.storedAt))) {
    if (total <= limit) break;
    await transaction((store) => store.delete(row.objectId), "readwrite");
    total -= Number(row.sizeBytes || 0);
  }
}

export async function putControlObject(object, { maxBytes = 100 * 1024 * 1024, replicaNodeId = null } = {}) {
  const verification = await verifyControlObject(object);
  if (!verification.valid) throw new Error(`Rejected control object: ${verification.reason}`);
  const existing = await transaction((store) => store.get(object.objectId)).catch(() => null);
  const replicaNodeIds = Array.from(new Set([...(existing?.replicaNodeIds || []), ...(replicaNodeId ? [replicaNodeId] : [])])).slice(0, 16);
  const stored = {
    ...object, storedAt: existing?.storedAt || Date.now(), lastAccessedAt: Date.now(),
    sizeBytes: canonicalBytes(object).byteLength, replicaNodeIds,
  };
  await transaction((store) => store.put(stored), "readwrite");
  await enforceQuota(maxBytes);
  return stored;
}

export async function markControlReplica(objectId, nodeId) {
  const row = await transaction((store) => store.get(objectId)).catch(() => null);
  if (!row || !nodeId) return false;
  row.replicaNodeIds = Array.from(new Set([...(row.replicaNodeIds || []), nodeId])).slice(0, 16);
  row.lastAccessedAt = Date.now();
  await transaction((store) => store.put(row), "readwrite");
  return true;
}

export async function getControlObject(objectId) {
  const row = await transaction((store) => store.get(objectId)).catch(() => null);
  if (!row || row.expiresAt <= Date.now() || !(await verifyControlObject(row)).valid) return null;
  return row;
}

export async function findControlObjects(kind, lookupKey, limit = 20) {
  const rows = await transaction((store) => store.index("by_lookup").getAll(IDBKeyRange.only([kind, String(lookupKey)]))).catch(() => []);
  const valid = [];
  for (const row of rows.sort((a, b) => b.createdAt - a.createdAt)) {
    if (valid.length >= Math.max(1, Math.min(50, Number(limit) || 20))) break;
    if ((await verifyControlObject(row)).valid) valid.push(row);
  }
  return valid;
}

export async function listPendingControlObjects(limit = 50) {
  const rows = await transaction((store) => store.getAll()).catch(() => []);
  return rows.filter((row) => row.expiresAt > Date.now() && !(row.replicaNodeIds || []).length).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
}

export async function controlStoreStats() {
  await removeExpired();
  const rows = await transaction((store) => store.getAll()).catch(() => []);
  const kinds = {};
  for (const row of rows) kinds[row.kind] = (kinds[row.kind] || 0) + 1;
  return {
    objectCount: rows.length,
    bytesUsed: rows.reduce((sum, row) => sum + Number(row.sizeBytes || 0), 0),
    replicatedObjects: rows.filter((row) => (row.replicaNodeIds || []).length > 0).length,
    kinds,
  };
}
