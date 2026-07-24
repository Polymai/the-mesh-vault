import { canonicalBytes, canonicalHashHex, bytesToBase64Url, base64UrlToBytes, importPublicKeyRaw, verify as verifySignature } from "../security/signing.js";
import { isKnownOpType, validatePayload } from "./operation-types.js";
import { isActorAuthorized } from "../identity/device-registry.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}oplog-v1`;
const STORE = "operations";
const PROTOCOL_VERSION = 1;

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
  return new Promise((resolve, reject) => { const tx = db.transaction(STORE, mode); const request = action(tx.objectStore(STORE)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function vaultLog(vaultId) { return (await idb((store) => store.index("by_vault").getAll(IDBKeyRange.only(vaultId))).catch(() => [])); }

const seqCache = new Map();
async function nextSeq(vaultId) {
  if (!seqCache.has(vaultId)) { const rows = await vaultLog(vaultId); seqCache.set(vaultId, rows.reduce((max, row) => Math.max(max, row.seq), 0)); }
  const next = seqCache.get(vaultId) + 1; seqCache.set(vaultId, next); return next;
}

const syncListeners = new Set();
export function onSyncNeeded(listener) { syncListeners.add(listener); return () => syncListeners.delete(listener); }
function scheduleSync() { syncListeners.forEach((listener) => { try { listener(); } catch {} }); }
if (typeof window !== "undefined") window.addEventListener("online", scheduleSync);

export async function appendOperation(signer, vaultId, opType, payload) {
  if (!isKnownOpType(opType)) throw new Error(`Unknown operation type: ${opType}`);
  if (!validatePayload(opType, payload)) throw new Error(`Invalid payload for operation ${opType}`);
  const seq = await nextSeq(vaultId);
  const payloadHash = await canonicalHashHex(payload);
  const envelope = { opId: crypto.randomUUID(), vaultId, actorPublicKey: signer.publicKey, algorithm: signer.algorithm, opType, timestamp: Date.now(), seq, payloadHash, payload, protocolVersion: PROTOCOL_VERSION };
  const signature = await signer.sign(canonicalBytes(envelope));
  const stored = { ...envelope, signature: bytesToBase64Url(signature), synced: false };
  await idb((store) => store.put(stored), "readwrite");
  scheduleSync();
  return stored;
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
    const { signature, synced, ...signable } = envelope;
    const ok = await verifySignature(publicKey, envelope.algorithm, base64UrlToBytes(signature), canonicalBytes(signable));
    return ok ? { valid: true } : { valid: false, reason: "invalid_signature" };
  } catch { return { valid: false, reason: "invalid_signature" }; }
}

export async function ingestOperations(vaultId, incoming, { ownerPublicKey } = {}) {
  const existing = await vaultLog(vaultId);
  const knownOpIds = new Set(existing.map((row) => row.opId));
  const bySeq = new Map(existing.map((row) => [row.seq, row]));
  let maxSeq = existing.reduce((max, row) => Math.max(max, row.seq), 0);
  const pending = new Map();
  for (const envelope of incoming) if (envelope.vaultId === vaultId && !knownOpIds.has(envelope.opId)) pending.set(envelope.seq, envelope);
  const accepted = []; const rejected = [];
  let authorizedEnvelopes = existing.slice();
  let progressed = true;
  while (progressed) {
    progressed = false;
    const candidate = pending.get(maxSeq + 1);
    if (!candidate) break;
    pending.delete(maxSeq + 1);
    if (bySeq.has(candidate.seq)) { rejected.push({ envelope: candidate, reason: "stale_sequence" }); continue; }
    const result = await verifyOperation(candidate, { authorizedEnvelopes, ownerPublicKey });
    if (!result.valid) { rejected.push({ envelope: candidate, reason: result.reason }); continue; }
    const stored = { ...candidate, synced: true };
    await idb((store) => store.put(stored), "readwrite");
    bySeq.set(stored.seq, stored); knownOpIds.add(stored.opId); authorizedEnvelopes.push(stored);
    maxSeq = stored.seq; seqCache.set(vaultId, maxSeq); accepted.push(stored); progressed = true;
  }
  for (const leftover of pending.values()) rejected.push({ envelope: leftover, reason: knownOpIds.has(leftover.opId) ? "duplicate" : "out_of_order_gap" });
  return { accepted, rejected };
}

export async function getOperationLog(vaultId) { return (await vaultLog(vaultId)).sort((a, b) => a.seq - b.seq); }
export async function getUnsyncedOperations(vaultId) { return (await vaultLog(vaultId)).filter((row) => !row.synced).sort((a, b) => a.seq - b.seq); }
export async function markSynced(opId) { const row = await idb((store) => store.get(opId)); if (row) await idb((store) => store.put({ ...row, synced: true }), "readwrite"); }
