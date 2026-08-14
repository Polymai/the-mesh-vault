import { canonicalBytes, canonicalHashHex, bytesToBase64Url, base64UrlToBytes, importPublicKeyRaw, verify as verifySignature } from "../security/signing.js";
import { isKnownOpType, validatePayload } from "./operation-types.js";
import { isActorAuthorized } from "../identity/device-registry.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}oplog-v3`;
const STORE = "operations";
const PROTOCOL_VERSION = 3;
const appendChains = new Map();

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "opId" });
      store.createIndex("by_vault", "vaultId");
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function idb(action, mode = "readonly") {
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
    tx.onabort = () => reject(tx.error || new Error("The signed operation queue was interrupted."));
    if (mode !== "readonly") tx.oncomplete = () => resolve(result);
  });
}
async function vaultLog(vaultId) { return (await idb((store) => store.index("by_vault").getAll(IDBKeyRange.only(vaultId))).catch(() => [])); }

const seqCache = new Map();
async function nextSeq(vaultId) {
  if (!seqCache.has(vaultId)) { const rows = await vaultLog(vaultId); seqCache.set(vaultId, rows.reduce((max, row) => Math.max(max, row.seq), 0)); }
  const next = seqCache.get(vaultId) + 1; seqCache.set(vaultId, next); return next;
}

function compareOperations(left, right) {
  return Number(left.timestamp) - Number(right.timestamp)
    || Number(left.seq) - Number(right.seq)
    || String(left.opId).localeCompare(String(right.opId));
}

function portableEnvelope(operation) {
  const {
    synced, syncReceipts, syncAttempts, nextSyncAt, lastSyncError,
    ...envelope
  } = operation || {};
  return envelope;
}

const syncListeners = new Set();
export function onSyncNeeded(listener) { syncListeners.add(listener); return () => syncListeners.delete(listener); }
function scheduleSync() { syncListeners.forEach((listener) => { try { listener(); } catch {} }); }
if (typeof window !== "undefined") window.addEventListener("online", scheduleSync);

async function appendOperationNow(signer, vaultId, opType, payload) {
  if (!isKnownOpType(opType)) throw new Error(`Unknown operation type: ${opType}`);
  if (!validatePayload(opType, payload)) throw new Error(`Invalid payload for operation ${opType}`);
  const seq = await nextSeq(vaultId);
  const payloadHash = await canonicalHashHex(payload);
  const envelope = { opId: crypto.randomUUID(), vaultId, actorPublicKey: signer.publicKey, algorithm: signer.algorithm, opType, timestamp: Date.now(), seq, payloadHash, payload, protocolVersion: PROTOCOL_VERSION };
  const signature = await signer.sign(canonicalBytes(envelope));
  const stored = {
    ...envelope,
    signature: bytesToBase64Url(signature),
    synced: false,
    syncReceipts: {},
    syncAttempts: 0,
    nextSyncAt: 0,
    lastSyncError: null,
  };
  await idb((store) => store.put(stored), "readwrite");
  scheduleSync();
  return stored;
}

export function appendOperation(signer, vaultId, opType, payload) {
  const previous = appendChains.get(vaultId) || Promise.resolve();
  const current = previous.then(
    () => appendOperationNow(signer, vaultId, opType, payload),
    () => appendOperationNow(signer, vaultId, opType, payload),
  );
  appendChains.set(vaultId, current);
  current.finally(() => {
    if (appendChains.get(vaultId) === current) appendChains.delete(vaultId);
  }).catch(() => {});
  return current;
}

export async function verifyOperation(envelope, { authorizedEnvelopes, ownerPublicKey, supportedProtocolVersions = [PROTOCOL_VERSION] } = {}) {
  if (!envelope || typeof envelope !== "object") return { valid: false, reason: "malformed" };
  if (!isKnownOpType(envelope.opType)) return { valid: false, reason: "unknown_op_type" };
  if (!supportedProtocolVersions.includes(envelope.protocolVersion)) return { valid: false, reason: "unsupported_protocol_version" };
  if (!validatePayload(envelope.opType, envelope.payload)) return { valid: false, reason: "malformed_payload" };
  if ((await canonicalHashHex(envelope.payload)) !== envelope.payloadHash) return { valid: false, reason: "payload_hash_mismatch" };
  if (ownerPublicKey && authorizedEnvelopes && !isActorAuthorized(authorizedEnvelopes, ownerPublicKey, envelope.actorPublicKey)) return { valid: false, reason: "unauthorized_actor" };
  try {
    const publicKey = await importPublicKeyRaw(base64UrlToBytes(envelope.actorPublicKey), envelope.algorithm);
    const {
      signature, synced, syncReceipts, syncAttempts, nextSyncAt, lastSyncError,
      ...signable
    } = envelope;
    const ok = await verifySignature(publicKey, envelope.algorithm, base64UrlToBytes(signature), canonicalBytes(signable));
    return ok ? { valid: true } : { valid: false, reason: "invalid_signature" };
  } catch { return { valid: false, reason: "invalid_signature" }; }
}

export async function ingestOperations(vaultId, incoming, { ownerPublicKey } = {}) {
  const existing = await vaultLog(vaultId);
  const knownOpIds = new Set(existing.map((row) => row.opId));
  let maxSeq = existing.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0);
  const pending = [];
  const duplicateInputIds = new Set();
  for (const raw of incoming || []) {
    const envelope = portableEnvelope(raw);
    if (envelope.vaultId !== vaultId) continue;
    if (knownOpIds.has(envelope.opId) || duplicateInputIds.has(envelope.opId)) continue;
    duplicateInputIds.add(envelope.opId);
    pending.push(envelope);
  }
  pending.sort(compareOperations);
  const accepted = [];
  const rejected = [];
  let authorizedEnvelopes = existing.slice();
  for (const candidate of pending) {
    const result = await verifyOperation(candidate, { authorizedEnvelopes, ownerPublicKey });
    if (!result.valid) { rejected.push({ envelope: candidate, reason: result.reason }); continue; }
    const stored = {
      ...candidate,
      synced: true,
      syncReceipts: { remote: { acknowledgedAt: Date.now() } },
      syncAttempts: 0,
      nextSyncAt: 0,
      lastSyncError: null,
    };
    await idb((store) => store.put(stored), "readwrite");
    knownOpIds.add(stored.opId);
    authorizedEnvelopes.push(stored);
    maxSeq = Math.max(maxSeq, Number(stored.seq) || 0);
    accepted.push(stored);
  }
  seqCache.set(vaultId, maxSeq);
  return { accepted, rejected };
}

export async function getOperationLog(vaultId) { return (await vaultLog(vaultId)).sort(compareOperations); }
export async function getUnsyncedOperations(vaultId) {
  const now = Date.now();
  return (await vaultLog(vaultId))
    .filter((row) => !row.synced && Number(row.nextSyncAt || 0) <= now)
    .sort(compareOperations);
}
export async function getBackbonePendingOperations(vaultId) {
  return (await vaultLog(vaultId))
    .filter((row) => !row.syncReceipts?.supabase)
    .sort(compareOperations);
}
export async function markSyncReceipt(opId, target, detail = true) {
  const row = await idb((store) => store.get(opId));
  if (!row || !["anchor", "supabase"].includes(target)) return false;
  const syncReceipts = { ...(row.syncReceipts || {}), [target]: { detail, acknowledgedAt: Date.now() } };
  await idb((store) => store.put({
    ...row,
    syncReceipts,
    synced: !!(syncReceipts.anchor || syncReceipts.supabase),
    syncAttempts: Number(row.syncAttempts || 0) + 1,
    nextSyncAt: 0,
    lastSyncError: null,
  }), "readwrite");
  return true;
}
export async function markSyncFailure(opId, error, retryDelayMs = 5000) {
  const row = await idb((store) => store.get(opId));
  if (!row) return false;
  await idb((store) => store.put({
    ...row,
    syncAttempts: Number(row.syncAttempts || 0) + 1,
    nextSyncAt: Date.now() + Math.max(1000, Number(retryDelayMs) || 5000),
    lastSyncError: String(error?.message || error || "sync_failed").slice(0, 240),
  }), "readwrite");
  return true;
}
export async function markSynced(opId) { const row = await idb((store) => store.get(opId)); if (row) await idb((store) => store.put({ ...row, synced: true }), "readwrite"); }
