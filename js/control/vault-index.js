import {
  base64UrlToBytes, bytesToBase64Url, canonicalBytes, canonicalHashHex,
  hashHex, importPublicKeyRaw, verify as verifySignature,
} from "../security/signing.js";
import { decryptJson, encryptJson } from "../security/keyring.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}vault-index-v1`;
const STORE = "indexes";
const FORMAT = "themeshvault-vault-index";
const PROTOCOL_VERSION = 1;
const MAX_ENVELOPE_BYTES = 3 * 1024 * 1024;

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "vaultId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
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
    tx.onabort = () => reject(tx.error || new Error("Vault index storage was interrupted."));
    if (mode !== "readonly") tx.oncomplete = () => resolve(result);
  });
}

function cleanRows(rows) {
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object").map((row) => structuredClone(row)) : [];
}

export function normalizeVaultIndexPayload(payload = {}) {
  return {
    folders: cleanRows(payload.folders),
    files: cleanRows(payload.files),
    tombstones: cleanRows(payload.tombstones),
    repairState: cleanRows(payload.repairState),
  };
}

function signable(envelope) {
  return {
    format: envelope.format,
    protocolVersion: envelope.protocolVersion,
    vaultId: envelope.vaultId,
    ownerPublicKey: envelope.ownerPublicKey,
    algorithm: envelope.algorithm,
    revision: envelope.revision,
    previousIndexHash: envelope.previousIndexHash || null,
    payloadHash: envelope.payloadHash,
    encryptedPayload: envelope.encryptedPayload,
    createdAt: envelope.createdAt,
  };
}

export async function buildVaultIndexEnvelope(identity, payload, { revision, previousIndexHash = null } = {}) {
  if (!identity?.vaultId || !identity?.ownerPublicKey || !identity?.algorithm || typeof identity.sign !== "function") {
    throw new Error("The vault owner identity is required to publish its private index.");
  }
  const normalized = normalizeVaultIndexPayload(payload);
  const nextRevision = Math.max(1, Math.floor(Number(revision) || Date.now()));
  const payloadHash = await canonicalHashHex(normalized);
  const encryptedPayload = await encryptJson(normalized, `vault-index-v1:${identity.vaultId}:${nextRevision}`);
  const core = {
    format: FORMAT,
    protocolVersion: PROTOCOL_VERSION,
    vaultId: identity.vaultId,
    ownerPublicKey: identity.ownerPublicKey,
    algorithm: identity.algorithm,
    revision: nextRevision,
    previousIndexHash: previousIndexHash || null,
    payloadHash,
    encryptedPayload,
    createdAt: Date.now(),
  };
  const signature = bytesToBase64Url(await identity.sign(canonicalBytes(core)));
  const indexHash = await canonicalHashHex({ ...core, signature });
  const envelope = { ...core, signature, indexHash };
  if (canonicalBytes(envelope).byteLength > MAX_ENVELOPE_BYTES) {
    throw new Error("This vault index is too large for one control record. Split-vault indexes are required before adding more entries.");
  }
  return envelope;
}

export async function verifyVaultIndexEnvelope(envelope, { vaultId = null } = {}) {
  if (!envelope || envelope.format !== FORMAT || envelope.protocolVersion !== PROTOCOL_VERSION) {
    return { valid: false, reason: "malformed" };
  }
  if (vaultId && envelope.vaultId !== vaultId) return { valid: false, reason: "wrong_vault" };
  if (!Number.isFinite(envelope.revision) || envelope.revision < 1 || !Number.isFinite(envelope.createdAt)) {
    return { valid: false, reason: "invalid_revision" };
  }
  if (canonicalBytes(envelope).byteLength > MAX_ENVELOPE_BYTES) return { valid: false, reason: "too_large" };
  try {
    if ((await hashHex(base64UrlToBytes(envelope.ownerPublicKey))) !== envelope.vaultId) {
      return { valid: false, reason: "not_self_certifying" };
    }
    if ((await canonicalHashHex({ ...signable(envelope), signature: envelope.signature })) !== envelope.indexHash) {
      return { valid: false, reason: "index_hash_mismatch" };
    }
    const publicKey = await importPublicKeyRaw(base64UrlToBytes(envelope.ownerPublicKey), envelope.algorithm);
    const valid = await verifySignature(
      publicKey,
      envelope.algorithm,
      base64UrlToBytes(envelope.signature),
      canonicalBytes(signable(envelope)),
    );
    return valid ? { valid: true } : { valid: false, reason: "invalid_signature" };
  } catch {
    return { valid: false, reason: "invalid_signature" };
  }
}

export async function openVaultIndexEnvelope(envelope, identity) {
  const verification = await verifyVaultIndexEnvelope(envelope, { vaultId: identity?.vaultId });
  if (!verification.valid || envelope.ownerPublicKey !== identity?.ownerPublicKey || envelope.algorithm !== identity?.algorithm) {
    return null;
  }
  try {
    const payload = normalizeVaultIndexPayload(await decryptJson(envelope.encryptedPayload));
    if ((await canonicalHashHex(payload)) !== envelope.payloadHash) return null;
    return { envelope, payload };
  } catch {
    return null;
  }
}

export async function saveLocalVaultIndex(envelope) {
  const verification = await verifyVaultIndexEnvelope(envelope);
  if (!verification.valid) throw new Error(`Rejected vault index: ${verification.reason}`);
  const current = await idb((store) => store.get(envelope.vaultId)).catch(() => null);
  if (current && Number(current.revision) > Number(envelope.revision)) return current;
  if (current && Number(current.revision) === Number(envelope.revision) && current.indexHash >= envelope.indexHash) return current;
  await idb((store) => store.put(structuredClone(envelope)), "readwrite");
  return envelope;
}

export async function getLocalVaultIndex(vaultId) {
  const row = await idb((store) => store.get(vaultId)).catch(() => null);
  if (!row || !(await verifyVaultIndexEnvelope(row, { vaultId })).valid) return null;
  return row;
}

export function newestVaultIndex(envelopes = []) {
  return [...envelopes].filter(Boolean).sort((left, right) => (
    Number(right.revision) - Number(left.revision)
    || Number(right.createdAt) - Number(left.createdAt)
    || String(right.indexHash).localeCompare(String(left.indexHash))
  ))[0] || null;
}
