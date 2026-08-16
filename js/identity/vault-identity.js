import {
  ALG_ED25519, base64UrlToBytes, bytesToBase64Url, deriveRootBytes, destroyPrivateKey,
  exportPublicKeyRaw, hashHex, keyPairFromSeed, sign as signBytes,
} from "../security/signing.js";
import {
  activatePreparedKeyring, discardPreparedKeyring, prepareKeyring,
} from "../security/keyring.js";
import {
  entropyToMnemonic, generateEntropy, mnemonicToEntropy, normalizeMnemonic,
} from "./mnemonic.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}vault-identity-v3`;
const STORE = "identity";
const PROTOCOL_VERSION = 3;
const MESH_KEY_FORMAT = "themeshvault-mesh-key";
const MESH_KEY_VERSION = 3;
const VAULT_ID_PATTERN = /^[a-f0-9]{64}$/;

let cached = null;
let cachedRecord = null;
let cachedPhrase = null;
let cachedPrivateKey = null;
let verifiedMeshKeyVaultId = null;
let loadingPromise = null;
let mutationTail = Promise.resolve();

function copyBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return new Uint8Array(value);
}

function serializeMutation(action) {
  const operation = mutationTail.catch(() => {}).then(action);
  mutationTail = operation.catch(() => {});
  return operation;
}

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
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
    tx.onabort = () => reject(tx.error || new Error("Vault identity storage transaction was aborted."));
    if (mode !== "readonly") tx.oncomplete = () => resolve(result);
  });
}

async function identityMaterial(rootSeedInput) {
  const rootSeed = copyBytes(rootSeedInput);
  let signingSeed; let discoverySecret; let pair;
  try {
    if (rootSeed.byteLength !== 32) throw new Error("The Mesh Key root must contain exactly 256 bits.");
    signingSeed = await deriveRootBytes(rootSeed, "owner-ed25519-seed");
    discoverySecret = await deriveRootBytes(rootSeed, "private-discovery-id");
    pair = await keyPairFromSeed(signingSeed);
    const ownerPublicKeyRaw = await exportPublicKeyRaw(pair.publicKey);
    return {
      pair,
      vaultId: await hashHex(ownerPublicKeyRaw),
      ownerPublicKeyRaw,
      discoveryId: await hashHex(discoverySecret),
    };
  } catch (error) {
    destroyPrivateKey(pair?.privateKey);
    throw error;
  } finally {
    rootSeed.fill(0);
    signingSeed?.fill(0);
    discoverySecret?.fill(0);
  }
}

async function recordFromRoot(rootSeedInput, { meshKeySaved = false, createdAt = Date.now() } = {}) {
  const rootSeed = copyBytes(rootSeedInput);
  let material;
  try {
    if (rootSeed.byteLength !== 32) throw new Error("The Mesh Key root must contain exactly 256 bits.");
    material = await identityMaterial(rootSeed);
    return {
      id: "primary",
      protocolVersion: PROTOCOL_VERSION,
      vaultId: material.vaultId,
      algorithm: ALG_ED25519,
      ownerPublicKeyRaw: bytesToBase64Url(material.ownerPublicKeyRaw),
      rootSeed: bytesToBase64Url(rootSeed),
      meshKeySaved: !!meshKeySaved,
      createdAt,
    };
  } finally {
    rootSeed.fill(0);
    destroyPrivateKey(material?.pair?.privateKey);
  }
}

async function createRecord() {
  const rootSeed = generateEntropy();
  try {
    return await recordFromRoot(rootSeed);
  } finally {
    rootSeed.fill(0);
  }
}

function validateRecord(record) {
  if (!record || record.id !== "primary" || record.protocolVersion !== PROTOCOL_VERSION
    || record.algorithm !== ALG_ED25519 || typeof record.rootSeed !== "string"
    || !VAULT_ID_PATTERN.test(record.vaultId) || typeof record.ownerPublicKeyRaw !== "string") {
    throw new Error("This browser contains an unsupported or malformed vault identity. Restore a v3 Mesh Key.");
  }
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt < 1) {
    throw new Error("The local vault identity has an invalid creation time.");
  }
}

function disposeStage(stage) {
  if (!stage) return;
  destroyPrivateKey(stage.privateKey);
  discardPreparedKeyring(stage.preparedKeyring);
  stage.privateKey = null;
  stage.preparedKeyring = null;
  stage.identity = null;
  stage.record = null;
  stage.phrase = null;
}

async function stageHydrate(record) {
  validateRecord(record);
  const rootSeed = base64UrlToBytes(record.rootSeed);
  let material; let preparedKeyring; let stage;
  try {
    if (rootSeed.byteLength !== 32) throw new Error("The locally stored Mesh Key root is malformed.");
    material = await identityMaterial(rootSeed);
    const ownerPublicKey = bytesToBase64Url(material.ownerPublicKeyRaw);
    if (material.vaultId !== record.vaultId || ownerPublicKey !== record.ownerPublicKeyRaw) {
      throw new Error("The local Mesh Key does not match its vault identity.");
    }
    preparedKeyring = await prepareKeyring(rootSeed);
    const phrase = await entropyToMnemonic(rootSeed);
    const privateKey = material.pair.privateKey;
    const identity = Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      vaultId: material.vaultId,
      algorithm: ALG_ED25519,
      ownerPublicKey,
      discoveryId: material.discoveryId,
      meshKeySaved: !!record.meshKeySaved,
      createdAt: record.createdAt,
      sign: (bytes) => signBytes(privateKey, ALG_ED25519, bytes),
    });
    stage = { identity, record, phrase, privateKey, preparedKeyring };
    return stage;
  } finally {
    rootSeed.fill(0);
    if (!stage) {
      destroyPrivateKey(material?.pair?.privateKey);
      discardPreparedKeyring(preparedKeyring);
    }
  }
}

function commitStage(stage) {
  if (!stage?.identity || !stage.record || !stage.privateKey || !stage.preparedKeyring) {
    throw new Error("The staged vault identity is incomplete.");
  }
  activatePreparedKeyring(stage.preparedKeyring);
  stage.preparedKeyring = null;

  const previousPrivateKey = cachedPrivateKey;
  cached = stage.identity;
  cachedRecord = stage.record;
  cachedPhrase = stage.phrase;
  cachedPrivateKey = stage.privateKey;
  verifiedMeshKeyVaultId = null;

  stage.identity = null;
  stage.record = null;
  stage.phrase = null;
  stage.privateKey = null;
  destroyPrivateKey(previousPrivateKey);
  return cached;
}

async function rollbackRecord(previousRecord) {
  if (previousRecord) await idb((store) => store.put(previousRecord), "readwrite");
  else await idb((store) => store.delete("primary"), "readwrite");
}

async function persistAndCommit(stage, previousRecord) {
  let persisted = false;
  try {
    await idb((store) => store.put(stage.record), "readwrite");
    persisted = true;
    return commitStage(stage);
  } catch (error) {
    if (persisted) {
      try {
        await rollbackRecord(previousRecord);
      } catch (rollbackError) {
        disposeStage(stage);
        const failure = new Error("Vault restore failed and its local identity rollback also failed.");
        failure.cause = { restoreError: error, rollbackError };
        throw failure;
      }
    }
    disposeStage(stage);
    throw error;
  }
}

async function loadOrCreateNow() {
  let record = await idb((store) => store.get("primary"));
  if (record) {
    const stage = await stageHydrate(record);
    try {
      return commitStage(stage);
    } catch (error) {
      disposeStage(stage);
      throw error;
    }
  }

  record = await createRecord();
  const stage = await stageHydrate(record);
  return persistAndCommit(stage, null);
}

export function normalizeRecoveryPhrase(phrase) {
  return normalizeMnemonic(phrase);
}

export async function hasStoredVaultIdentity() {
  if (cached) return true;
  return !!(await idb((store) => store.get("primary")).catch(() => null));
}

export async function loadOrCreateVaultIdentity() {
  if (cached) return cached;
  if (!loadingPromise) loadingPromise = serializeMutation(loadOrCreateNow);
  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

export function currentVaultIdentity() {
  return cached;
}

export function isVaultReady() {
  return !!cached;
}

export async function markMeshKeySaved() {
  return serializeMutation(async () => {
    if (!cached || !cachedRecord) throw new Error("Open a vault before saving its Mesh Key state.");
    if (verifiedMeshKeyVaultId !== cached.vaultId) {
      throw new Error("Re-enter and verify all 24 Mesh Key words before marking the key as saved.");
    }
    const nextRecord = { ...cachedRecord, meshKeySaved: true };
    await idb((store) => store.put(nextRecord), "readwrite");
    cachedRecord = nextRecord;
    cached = Object.freeze({ ...cached, meshKeySaved: true });
    verifiedMeshKeyVaultId = null;
  });
}

export function meshKeyRecoveryPhrase() {
  return cachedPhrase;
}

export function qrPayload() {
  return cached && cachedPhrase ? `themeshvault:mesh-key:v3:${cachedPhrase}` : null;
}

export function exportMeshKeyFile() {
  if (!cached || !cachedRecord || !cachedPhrase) return null;
  const meshKey = {
    format: MESH_KEY_FORMAT,
    version: MESH_KEY_VERSION,
    createdAt: new Date(cachedRecord.createdAt).toISOString(),
    vaultId: cached.vaultId,
    algorithm: ALG_ED25519,
    meshKey: cachedPhrase,
    warning: "This 24-word Mesh Key is the complete secret for this vault. Keep it private and offline.",
  };
  return new Blob([JSON.stringify(meshKey, null, 2)], { type: "application/json" });
}

function restoreFromRoot(rootSeedInput, expectedVaultId = null) {
  const rootSeed = copyBytes(rootSeedInput);
  return serializeMutation(async () => {
    try {
      if (rootSeed.byteLength !== 32) throw new Error("The Mesh Key root must contain exactly 256 bits.");
      const record = await recordFromRoot(rootSeed, { meshKeySaved: true });
      if (expectedVaultId && record.vaultId !== expectedVaultId) {
        throw new Error("This Mesh Key file contains a conflicting Vault ID.");
      }
      const previousRecord = await idb((store) => store.get("primary"));
      const stage = await stageHydrate(record);
      return await persistAndCommit(stage, previousRecord || null);
    } finally {
      rootSeed.fill(0);
    }
  });
}

export async function restoreVaultFromFile(fileJson) {
  const source = typeof fileJson === "string" ? JSON.parse(fileJson) : fileJson;
  if (!source || typeof source !== "object" || Array.isArray(source)
    || source.format !== MESH_KEY_FORMAT || source.version !== MESH_KEY_VERSION
    || source.algorithm !== ALG_ED25519 || !VAULT_ID_PATTERN.test(source.vaultId)
    || typeof source.meshKey !== "string") {
    throw new Error("Choose a complete TheMeshVault v3 Mesh Key file.");
  }
  const rootSeed = await mnemonicToEntropy(source.meshKey);
  try {
    return await restoreFromRoot(rootSeed, source.vaultId);
  } finally {
    rootSeed.fill(0);
  }
}

export async function restoreVaultFromPhrase(phrase) {
  const rootSeed = await mnemonicToEntropy(phrase);
  try {
    return await restoreFromRoot(rootSeed);
  } finally {
    rootSeed.fill(0);
  }
}

export async function verifyMeshKeyPhrase(phrase) {
  if (!cached) return false;
  verifiedMeshKeyVaultId = null;
  let rootSeed; let material;
  try {
    rootSeed = await mnemonicToEntropy(phrase);
    material = await identityMaterial(rootSeed);
    const matches = material.vaultId === cached.vaultId;
    if (matches) verifiedMeshKeyVaultId = cached.vaultId;
    return matches;
  } catch {
    return false;
  } finally {
    rootSeed?.fill(0);
    destroyPrivateKey(material?.pair?.privateKey);
  }
}

export const VAULT_PROTOCOL_VERSION = PROTOCOL_VERSION;
