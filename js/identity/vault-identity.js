import {
  generateKeyPair, exportPublicKeyRaw, exportPrivateKeyJwk, exportPublicKeyJwk,
  importPrivateKeyJwk, importPublicKeyJwk, sign as signBytes, hashHex,
  bytesToBase64Url, base64UrlToBytes, deriveHkdfKey, sealAesGcm, openAesGcm,
} from "../security/signing.js";
import { setMasterKeyRaw } from "../security/keyring.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}vault-identity-v1`;
const STORE = "identity";
const PROTOCOL_VERSION = 1;
const RECOVERY_KIT_FORMAT = "themeshvault-recovery-kit";
const RECOVERY_KIT_VERSION = 2;
const RECOVERY_WORDS = 6;
const RECOVERY_WORD_LENGTH = 7;
const RECOVERY_COMPACT_LENGTH = RECOVERY_WORDS * RECOVERY_WORD_LENGTH;
const enc = new TextEncoder();
const dec = new TextDecoder();

let cached = null;
let loadingPromise = null;
let replicateRecoveryEnvelope = async () => {};

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
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
    tx.onabort = () => reject(tx.error || new Error("Vault identity storage transaction was aborted."));
    if (mode !== "readonly") tx.oncomplete = () => resolve(result);
  });
}
function randomWords(count) { return Array.from(crypto.getRandomValues(new Uint32Array(count)), (n) => n.toString(36).padStart(RECOVERY_WORD_LENGTH, "0")).join("-"); }

export function normalizeRecoveryPhrase(phrase) {
  let input = String(phrase || "").trim();
  if ((input.startsWith('"') && input.endsWith('"')) || (input.startsWith("'") && input.endsWith("'"))) input = input.slice(1, -1).trim();
  input = input.replace(/^meshvault:recovery:v\d+:/i, "");
  const compact = input.toLowerCase().replace(/[\s-]+/g, "");
  if (!new RegExp(`^[a-z0-9]{${RECOVERY_COMPACT_LENGTH}}$`).test(compact)) {
    throw new Error(`A Mesh Key must contain ${RECOVERY_WORDS} groups of ${RECOVERY_WORD_LENGTH} letters or numbers.`);
  }
  return Array.from({ length: RECOVERY_WORDS }, (_, index) => compact.slice(index * RECOVERY_WORD_LENGTH, (index + 1) * RECOVERY_WORD_LENGTH)).join("-");
}

async function recoveryLookupIdFor(phrase) {
  const normalized = normalizeRecoveryPhrase(phrase);
  return hashHex(enc.encode(`meshvault-recovery-lookup-v1:${normalized}`));
}
async function buildRecoveryEnvelope({ phrase, vaultId, algorithm, ownerPrivateKeyJwk, ownerPublicKeyJwk, masterKeyRaw }) {
  const normalized = normalizeRecoveryPhrase(phrase);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await deriveHkdfKey(enc.encode(normalized), salt, "meshvault-mesh-key-v1");
  const payload = enc.encode(JSON.stringify({ vaultId, algorithm, ownerPrivateKeyJwk, ownerPublicKeyJwk, masterKeyRaw: bytesToBase64Url(masterKeyRaw) }));
  const sealed = await sealAesGcm(wrappingKey, payload, "meshvault-recovery-envelope-v1");
  const recoveryLookupId = await recoveryLookupIdFor(normalized);
  return { v: PROTOCOL_VERSION, vaultId, recoveryLookupId, salt: bytesToBase64Url(salt), iv: sealed.iv, cipher: sealed.cipher };
}
async function openRecoveryEnvelope(phrase, envelope) {
  const normalized = normalizeRecoveryPhrase(phrase);
  const wrappingKey = await deriveHkdfKey(enc.encode(normalized), base64UrlToBytes(envelope.salt), "meshvault-mesh-key-v1");
  const bytes = await openAesGcm(wrappingKey, envelope, "meshvault-recovery-envelope-v1");
  return JSON.parse(dec.decode(bytes));
}

async function createRecord() {
  const { algorithm, publicKey, privateKey } = await generateKeyPair();
  const ownerPublicKeyRaw = await exportPublicKeyRaw(publicKey);
  const vaultId = await hashHex(ownerPublicKeyRaw);
  const ownerPrivateKeyJwk = await exportPrivateKeyJwk(privateKey);
  const ownerPublicKeyJwk = await exportPublicKeyJwk(publicKey);
  const masterKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const phrase = randomWords(RECOVERY_WORDS);
  const recoveryEnvelope = await buildRecoveryEnvelope({ phrase, vaultId, algorithm, ownerPrivateKeyJwk, ownerPublicKeyJwk, masterKeyRaw });
  return {
    id: "primary", protocolVersion: PROTOCOL_VERSION, vaultId, algorithm,
    ownerPublicKeyJwk, ownerPrivateKeyJwk, ownerPublicKeyRaw: bytesToBase64Url(ownerPublicKeyRaw),
    masterKeyRaw: bytesToBase64Url(masterKeyRaw), phrase, recoveryEnvelope, recoveryLookupId: recoveryEnvelope.recoveryLookupId,
    meshKeySaved: false, createdAt: Date.now(),
  };
}
async function hydrate(record) {
  const privateKey = await importPrivateKeyJwk(record.ownerPrivateKeyJwk, record.algorithm);
  const publicKey = await importPublicKeyJwk(record.ownerPublicKeyJwk, record.algorithm);
  await setMasterKeyRaw(base64UrlToBytes(record.masterKeyRaw));
  return {
    protocolVersion: record.protocolVersion, vaultId: record.vaultId, algorithm: record.algorithm,
    ownerPublicKey: record.ownerPublicKeyRaw, ownerPublicKeyJwk: record.ownerPublicKeyJwk,
    meshKeySaved: !!record.meshKeySaved, recoveryLookupId: record.recoveryLookupId, createdAt: record.createdAt,
    sign: (bytes) => signBytes(privateKey, record.algorithm, bytes),
    _publicKey: publicKey, _record: record,
  };
}

export function setRecoveryReplicator(fn) { replicateRecoveryEnvelope = fn || (async () => {}); }
export async function replicateCurrentRecoveryEnvelope() {
  if (!cached?._record?.recoveryEnvelope) return false;
  await replicateRecoveryEnvelope(cached._record.recoveryEnvelope);
  return true;
}

export async function hasStoredVaultIdentity() {
  if (cached) return true;
  const record = await idb((store) => store.get("primary")).catch(() => null);
  return !!record;
}
export async function loadOrCreateVaultIdentity() {
  if (cached) return cached;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      let record = await idb((store) => store.get("primary")).catch(() => null);
      if (!record) {
        record = await createRecord();
        await idb((store) => store.put(record), "readwrite");
      }
      return hydrate(record);
    })();
  }
  try {
    cached = await loadingPromise;
    return cached;
  } finally {
    loadingPromise = null;
  }
}
export function currentVaultIdentity() { return cached; }
export function isVaultReady() { return !!cached; }

export async function markMeshKeySaved() {
  if (!cached) return;
  cached._record.meshKeySaved = true; cached.meshKeySaved = true;
  await idb((store) => store.put(cached._record), "readwrite");
}
export function meshKeyRecoveryPhrase() { return cached?._record.phrase || null; }
export function qrPayload() { return cached ? `meshvault:recovery:v${PROTOCOL_VERSION}:${cached._record.phrase}` : null; }
export function exportMeshKeyFile() {
  if (!cached) return null;
  const recoveryKit = {
    format: RECOVERY_KIT_FORMAT,
    version: RECOVERY_KIT_VERSION,
    createdAt: new Date(cached._record.createdAt || Date.now()).toISOString(),
    vaultId: cached._record.vaultId,
    recoveryPhrase: cached._record.phrase,
    envelope: cached._record.recoveryEnvelope,
    warning: "Anyone with this file can open this vault. Keep it private and offline.",
  };
  return new Blob([JSON.stringify(recoveryKit, null, 2)], { type: "application/json" });
}

async function restoreFromEnvelope(phrase, envelope) {
  const normalized = normalizeRecoveryPhrase(phrase);
  const decoded = await openRecoveryEnvelope(normalized, envelope);
  if (!decoded?.vaultId || !decoded?.algorithm || !decoded?.ownerPublicKeyJwk || !decoded?.ownerPrivateKeyJwk || !decoded?.masterKeyRaw) {
    throw new Error("The recovery envelope is incomplete.");
  }
  const publicKey = await importPublicKeyJwk(decoded.ownerPublicKeyJwk, decoded.algorithm);
  const ownerPublicKeyRaw = await exportPublicKeyRaw(publicKey);
  const derivedVaultId = await hashHex(ownerPublicKeyRaw);
  if (derivedVaultId !== decoded.vaultId || (envelope.vaultId && envelope.vaultId !== decoded.vaultId)) {
    throw new Error("The recovery envelope does not match its vault identity.");
  }
  const record = {
    id: "primary", protocolVersion: PROTOCOL_VERSION, vaultId: decoded.vaultId, algorithm: decoded.algorithm,
    ownerPublicKeyJwk: decoded.ownerPublicKeyJwk, ownerPrivateKeyJwk: decoded.ownerPrivateKeyJwk,
    ownerPublicKeyRaw: bytesToBase64Url(ownerPublicKeyRaw),
    masterKeyRaw: decoded.masterKeyRaw, phrase: normalized, recoveryEnvelope: envelope, recoveryLookupId: envelope.recoveryLookupId,
    meshKeySaved: true, createdAt: Date.now(),
  };
  await idb((store) => store.put(record), "readwrite");
  cached = await hydrate(record);
  return cached;
}
export async function restoreVaultFromFile(fileJson, phrase) {
  const source = typeof fileJson === "string" ? JSON.parse(fileJson) : fileJson;
  const envelope = source?.envelope || source?.recoveryEnvelope || source;
  if (!envelope?.cipher || !envelope?.salt) throw new Error("This does not look like a Mesh Key recovery file.");
  if (source?.vaultId && envelope.vaultId && source.vaultId !== envelope.vaultId) {
    throw new Error("This Mesh Key file contains conflicting vault identifiers.");
  }
  const embeddedPhrase = String(source?.recoveryPhrase || source?.phrase || "").trim();
  const suppliedPhrase = String(phrase || "").trim();
  if (!embeddedPhrase && !suppliedPhrase) {
    throw new Error("This older Mesh Key file also needs its 6-group recovery phrase. Restore with both, then download a new complete Mesh Key file.");
  }
  const normalized = normalizeRecoveryPhrase(embeddedPhrase || suppliedPhrase);
  try { return await restoreFromEnvelope(normalized, envelope); }
  catch { throw new Error("That Mesh Key phrase does not match this recovery file."); }
}
export async function restoreVaultFromPhrase(phrase, fetchRecoveryEnvelope) {
  const normalized = normalizeRecoveryPhrase(phrase);
  const recoveryLookupId = await recoveryLookupIdFor(normalized);
  const envelope = await fetchRecoveryEnvelope(recoveryLookupId);
  if (!envelope) throw new Error("No recovery data could be found for this Mesh Key on the network yet.");
  try { return await restoreFromEnvelope(normalized, envelope); }
  catch { throw new Error("That Mesh Key phrase is not valid."); }
}
export async function verifyMeshKeyPhrase(phrase) { return !cached ? false : (await recoveryLookupIdFor(phrase)) === cached.recoveryLookupId; }
