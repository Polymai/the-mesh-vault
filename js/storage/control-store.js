import {
  canonicalBytes, canonicalHashHex, bytesToBase64Url, base64UrlToBytes,
  importPublicKeyRaw, verify as verifySignature,
} from "../security/signing.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const LEGACY_DB_NAME = `${prefix}anchor-control-v1`;
const DB_NAME = `${prefix}anchor-control-v2`;
const STORE = "objects";
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 31 * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 30 * 1000;
const STATS_CACHE_MS = 10 * 1000;
const GROUP_LIMITS = Object.freeze({
  peer: 512,
  "fragment-location": 24,
  manifest: 3,
  "vault-index": 5,
  "recovery-envelope": 3,
  "anchor-handoff": 1,
  "repair-request": 512,
  "repair-lease": 32,
  "repair-complete": 512,
});

let databasePromise = null;
let legacyCleanupStarted = false;
let maintenancePromise = null;
let lastMaintenanceAt = 0;
let lastMaxBytes = 100 * 1024 * 1024;
let statsPromise = null;
let cachedStats = null;
let statsMeasuredAt = 0;

function startLegacyCleanup() {
  if (legacyCleanupStarted || LEGACY_DB_NAME === DB_NAME) return;
  legacyCleanupStarted = true;
  try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch {}
}

async function database() {
  if (databasePromise) return databasePromise;
  startLegacyCleanup();
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "objectId" });
      store.createIndex("by_lookup", ["kind", "lookupKey"]);
      store.createIndex("by_expiry", "expiresAt");
      store.createIndex("by_access", "lastAccessedAt");
      store.createIndex("by_semantic", "semanticKey");
      store.createIndex("by_group", "retentionGroup");
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error);
    };
  });
  return databasePromise;
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
  const {
    signature, objectId, storedAt, lastAccessedAt, sizeBytes, replicaNodeIds,
    semanticKey, retentionGroup, ...core
  } = object;
  return core;
}

function payloadIdentifier(payload, names) {
  for (const name of names) {
    const value = payload?.[name];
    if (value !== undefined && value !== null && String(value)) return String(value);
  }
  return null;
}

function semanticKeyFor(object) {
  const payload = object.payload || {};
  const lookupKey = String(object.lookupKey || "");
  let identity = null;
  switch (object.kind) {
    case "peer":
      identity = payloadIdentifier(payload, ["nodeId"]) || object.senderPublicKey;
      break;
    case "fragment-location":
      identity = `${lookupKey}:${payloadIdentifier(payload, ["nodeId"]) || object.senderPublicKey}`;
      break;
    case "manifest":
      identity = `${lookupKey}:${payloadIdentifier(payload, ["manifestHash", "indexHash"]) || object.payloadHash}`;
      break;
    case "vault-index":
      identity = `${lookupKey}:${payloadIdentifier(payload, ["revision"]) || "unknown"}:${payloadIdentifier(payload, ["indexHash"]) || object.payloadHash}`;
      break;
    case "oplog":
      identity = `${lookupKey}:${payloadIdentifier(payload, ["opId"]) || "unknown"}:${object.payloadHash}`;
      break;
    case "deletion-order":
      identity = `${payloadIdentifier(payload, ["orderId", "placementId"]) || object.payloadHash}:${payload?.authorization?.signature || "unsigned"}`;
      break;
    case "deletion-ack":
      identity = `${payloadIdentifier(payload, ["orderId", "placementId"]) || object.payloadHash}:${payloadIdentifier(payload, ["nodeId"]) || object.senderPublicKey}`;
      break;
    case "repair-request":
    case "repair-complete":
      identity = payloadIdentifier(payload, ["requestId"]) || object.payloadHash;
      break;
    case "repair-lease":
      identity = payloadIdentifier(payload, ["leaseId"]) || `${payloadIdentifier(payload, ["requestId"]) || lookupKey}:${payloadIdentifier(payload, ["workerNodeId"]) || object.senderPublicKey}`;
      break;
    case "recovery-envelope":
      identity = `${payloadIdentifier(payload, ["recoveryLookupId"]) || lookupKey}:${object.payloadHash}`;
      break;
    case "anchor-handoff":
      identity = payloadIdentifier(payload, ["nodeId"]) || lookupKey || object.senderPublicKey;
      break;
    default:
      identity = object.payloadHash;
  }
  return JSON.stringify([object.kind, identity]);
}

function retentionGroupFor(object) {
  return JSON.stringify([object.kind, String(object.lookupKey || "")]);
}

function summarize(rows) {
  const kinds = {};
  for (const row of rows) kinds[row.kind] = (kinds[row.kind] || 0) + 1;
  return {
    objectCount: rows.length,
    bytesUsed: rows.reduce((sum, row) => sum + Number(row.sizeBytes || 0), 0),
    replicatedObjects: rows.filter((row) => (row.replicaNodeIds || []).length > 0).length,
    kinds,
  };
}

function cacheStats(stats) {
  cachedStats = stats;
  statsMeasuredAt = Date.now();
  return { ...stats, kinds: { ...(stats.kinds || {}) } };
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

async function compactingPut(stored) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let result = stored;
    const semanticRequest = store.index("by_semantic").getAll(IDBKeyRange.only(stored.semanticKey));
    semanticRequest.onerror = () => tx.abort();
    semanticRequest.onsuccess = () => {
      const semanticRows = semanticRequest.result || [];
      const newest = [...semanticRows, stored].sort((left, right) => (
        Number(right.createdAt) - Number(left.createdAt)
        || String(right.objectId).localeCompare(String(left.objectId))
      ))[0];
      const replicaNodeIds = Array.from(new Set(semanticRows.flatMap((row) => row.replicaNodeIds || []).concat(stored.replicaNodeIds || []))).slice(0, 16);
      for (const row of semanticRows) if (row.objectId !== newest.objectId) store.delete(row.objectId);
      result = newest.objectId === stored.objectId
        ? { ...stored, replicaNodeIds, storedAt: semanticRows.reduce((earliest, row) => Math.min(earliest, Number(row.storedAt) || earliest), stored.storedAt) }
        : { ...newest, replicaNodeIds, lastAccessedAt: Date.now() };
      store.put(result);

      const groupLimit = Number(GROUP_LIMITS[stored.kind] || 0);
      if (!groupLimit) return;
      const groupRequest = store.index("by_group").getAll(IDBKeyRange.only(stored.retentionGroup));
      groupRequest.onerror = () => tx.abort();
      groupRequest.onsuccess = () => {
        const rows = (groupRequest.result || []).sort((left, right) => (
          Number(right.createdAt) - Number(left.createdAt)
          || String(right.objectId).localeCompare(String(left.objectId))
        ));
        for (const row of rows.slice(groupLimit)) store.delete(row.objectId);
      };
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Anchor control compaction was aborted."));
  });
}

async function removeExpired(now = Date.now()) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const request = tx.objectStore(STORE).index("by_expiry").openCursor(IDBKeyRange.upperBound(now));
    let removed = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      removed += 1;
      cursor.continue();
    };
    request.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Expired control-record cleanup was aborted."));
  });
}

async function deleteRows(objectIds) {
  if (!objectIds.length) return;
  const db = await database();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const objectId of objectIds) store.delete(objectId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Control-record cleanup was aborted."));
  });
}

async function runMaintenance(maxBytes = lastMaxBytes) {
  lastMaxBytes = Math.max(1024 * 1024, Number(maxBytes) || 0);
  if (maintenancePromise) return maintenancePromise;
  maintenancePromise = (async () => {
    await removeExpired().catch(() => 0);
    let rows = await transaction((store) => store.getAll()).catch(() => []);
    let total = rows.reduce((sum, row) => sum + Number(row.sizeBytes || 0), 0);
    const removeIds = [];
    for (const row of rows.sort((left, right) => Number(left.lastAccessedAt || left.storedAt) - Number(right.lastAccessedAt || right.storedAt))) {
      if (total <= lastMaxBytes) break;
      removeIds.push(row.objectId);
      total -= Number(row.sizeBytes || 0);
    }
    if (removeIds.length) {
      await deleteRows(removeIds);
      const removed = new Set(removeIds);
      rows = rows.filter((row) => !removed.has(row.objectId));
    }
    lastMaintenanceAt = Date.now();
    return cacheStats(summarize(rows));
  })().finally(() => { maintenancePromise = null; });
  return maintenancePromise;
}

async function maybeRunMaintenance(maxBytes) {
  lastMaxBytes = Math.max(1024 * 1024, Number(maxBytes) || 0);
  if (Date.now() - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return null;
  return runMaintenance(lastMaxBytes);
}

export async function putControlObject(object, { maxBytes = 100 * 1024 * 1024, replicaNodeId = null } = {}) {
  const verification = await verifyControlObject(object);
  if (!verification.valid) throw new Error(`Rejected control object: ${verification.reason}`);
  const stored = {
    ...object,
    storedAt: Date.now(),
    lastAccessedAt: Date.now(),
    sizeBytes: canonicalBytes(object).byteLength,
    replicaNodeIds: replicaNodeId ? [replicaNodeId] : [],
    semanticKey: semanticKeyFor(object),
    retentionGroup: retentionGroupFor(object),
  };
  const accepted = await compactingPut(stored);
  await maybeRunMaintenance(maxBytes);
  return accepted;
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
  for (const row of rows.sort((left, right) => right.createdAt - left.createdAt)) {
    if (valid.length >= Math.max(1, Math.min(100, Number(limit) || 20))) break;
    if ((await verifyControlObject(row)).valid) valid.push(row);
  }
  return valid;
}

export async function listPendingControlObjects(limit = 50) {
  const rows = await transaction((store) => store.getAll()).catch(() => []);
  return rows.filter((row) => row.expiresAt > Date.now() && !(row.replicaNodeIds || []).length).sort((left, right) => left.createdAt - right.createdAt).slice(0, limit);
}

export async function controlStoreStats({ fresh = false } = {}) {
  if (!fresh && cachedStats && Date.now() - statsMeasuredAt < STATS_CACHE_MS) return { ...cachedStats, kinds: { ...(cachedStats.kinds || {}) } };
  if (statsPromise) return statsPromise;
  statsPromise = (async () => {
    if (Date.now() - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) return runMaintenance(lastMaxBytes);
    const rows = await transaction((store) => store.getAll()).catch(() => []);
    return cacheStats(summarize(rows));
  })().finally(() => { statsPromise = null; });
  return statsPromise;
}
