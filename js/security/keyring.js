import { canonicalBytes, deriveRootBytes, hashBytes as sha256Bytes } from "./signing.js";

let metadataKey = null;
let dedupKey = null;
let segmentRootKey = null;
let keyringEpoch = 0;

const preparedKeyrings = new WeakSet();
const enc = new TextEncoder();
const dec = new TextDecoder();
const HEX_64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const COMPRESSION_METHODS = new Set(["none", "gzip"]);

function copyBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return new Uint8Array(value);
}

function binaryString(bytes) {
  let value = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return value;
}

export function bytesToBase64(value) {
  const bytes = copyBytes(value);
  try {
    return btoa(binaryString(bytes));
  } finally {
    bytes.fill(0);
  }
}

export function base64ToBytes(value) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new Error("The encrypted value is not canonical base64.");
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("The encrypted value is not valid base64.");
  }
  if (bytesToBase64(bytes) !== value) {
    bytes.fill(0);
    throw new Error("The encrypted value is not canonical base64.");
  }
  return bytes;
}

function requireAad(aad) {
  if (typeof aad !== "string" || !aad) throw new Error("Authenticated encryption requires an explicit context.");
  return enc.encode(aad);
}

async function importAes256(raw, usages = ["encrypt", "decrypt"]) {
  const bytes = copyBytes(raw);
  try {
    if (bytes.byteLength !== 32) throw new Error("Protocol v3 requires a 256-bit AES key.");
    return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usages);
  } finally {
    bytes.fill(0);
  }
}

async function seal(key, bytes, aad) {
  const additionalData = requireAad(aad);
  let iv; let cipher;
  try {
    iv = crypto.getRandomValues(new Uint8Array(12));
    cipher = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      bytes,
    ));
    return { v: 3, iv: bytesToBase64(iv), cipher: bytesToBase64(cipher), aad };
  } finally {
    additionalData.fill(0);
    iv?.fill(0);
    cipher?.fill(0);
  }
}

async function open(key, envelope, expectedAad) {
  if (envelope?.v !== 3 || envelope?.aad !== expectedAad) {
    throw new Error("Encrypted data was presented outside its authenticated context.");
  }
  const additionalData = requireAad(expectedAad);
  let iv; let cipher;
  try {
    iv = base64ToBytes(envelope.iv);
    cipher = base64ToBytes(envelope.cipher);
    if (iv.byteLength !== 12 || cipher.byteLength < 16) throw new Error("The encrypted envelope is malformed.");
    return await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      cipher,
    );
  } finally {
    additionalData.fill(0);
    iv?.fill(0);
    cipher?.fill(0);
  }
}

export async function prepareKeyring(rootSeedInput) {
  const rootSeed = copyBytes(rootSeedInput);
  let metadataRaw; let dedupRaw; let segmentRaw;
  try {
    if (rootSeed.byteLength !== 32) throw new Error("The Mesh Key root must be exactly 256 bits.");
    metadataRaw = await deriveRootBytes(rootSeed, "metadata-aes-256");
    dedupRaw = await deriveRootBytes(rootSeed, "dedup-hmac-sha256");
    segmentRaw = await deriveRootBytes(rootSeed, "segment-hkdf-root");
    const prepared = {
      metadataKey: await importAes256(metadataRaw),
      dedupKey: await crypto.subtle.importKey("raw", dedupRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      segmentRootKey: await crypto.subtle.importKey("raw", segmentRaw, "HKDF", false, ["deriveBits"]),
    };
    preparedKeyrings.add(prepared);
    return prepared;
  } finally {
    rootSeed.fill(0);
    metadataRaw?.fill(0);
    dedupRaw?.fill(0);
    segmentRaw?.fill(0);
  }
}

function consumePreparedKeyring(prepared) {
  if (!prepared || !preparedKeyrings.has(prepared)
    || !prepared.metadataKey || !prepared.dedupKey || !prepared.segmentRootKey) {
    throw new Error("The prepared keyring is invalid or has already been consumed.");
  }
  const keys = {
    metadataKey: prepared.metadataKey,
    dedupKey: prepared.dedupKey,
    segmentRootKey: prepared.segmentRootKey,
  };
  preparedKeyrings.delete(prepared);
  prepared.metadataKey = null;
  prepared.dedupKey = null;
  prepared.segmentRootKey = null;
  return keys;
}

function installPreparedKeyring(prepared, { invalidatePending = true } = {}) {
  const keys = consumePreparedKeyring(prepared);
  if (invalidatePending) keyringEpoch += 1;
  metadataKey = keys.metadataKey;
  dedupKey = keys.dedupKey;
  segmentRootKey = keys.segmentRootKey;
}

export function activatePreparedKeyring(prepared) {
  installPreparedKeyring(prepared);
}

export function discardPreparedKeyring(prepared) {
  if (!prepared || !preparedKeyrings.has(prepared)) return;
  preparedKeyrings.delete(prepared);
  prepared.metadataKey = null;
  prepared.dedupKey = null;
  prepared.segmentRootKey = null;
}

export async function initializeKeyring(rootSeedInput) {
  const epoch = ++keyringEpoch;
  const prepared = await prepareKeyring(rootSeedInput);
  if (epoch !== keyringEpoch) {
    discardPreparedKeyring(prepared);
    throw new Error("A newer Mesh Key replaced this keyring initialization.");
  }
  installPreparedKeyring(prepared, { invalidatePending: false });
}

export function clearKeyring() {
  keyringEpoch += 1;
  metadataKey = null;
  dedupKey = null;
  segmentRootKey = null;
}

export function isKeyringReady() {
  return !!(metadataKey && dedupKey && segmentRootKey);
}

export async function encryptJson(value, aad) {
  if (!metadataKey) throw new Error("The vault key hierarchy is not ready yet.");
  return seal(metadataKey, enc.encode(JSON.stringify(value)), aad);
}

export async function decryptJson(envelope, expectedAad) {
  if (!metadataKey) throw new Error("The vault key hierarchy is not ready yet.");
  return JSON.parse(dec.decode(await open(metadataKey, envelope, expectedAad)));
}

export async function dedupFingerprint(bytes) {
  if (!dedupKey) throw new Error("The vault key hierarchy is not ready yet.");
  const context = enc.encode("themeshvault/v3/dedup-token\0");
  const source = copyBytes(bytes);
  const input = new Uint8Array(context.length + source.byteLength);
  input.set(context);
  input.set(source, context.length);
  try {
    const signature = await crypto.subtle.sign("HMAC", dedupKey, input);
    return Array.from(new Uint8Array(signature), (value) => value.toString(16).padStart(2, "0")).join("");
  } finally {
    source.fill(0);
    input.fill(0);
  }
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function protocolInteger(value, field, { minimum = 0, exact = null } = {}) {
  let number;
  if (typeof value === "number") number = value;
  else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) number = Number(value);
  else throw new Error(`${field} must be a canonical integer.`);
  if (!Number.isSafeInteger(number) || number < minimum || (exact !== null && number !== exact)) {
    throw new Error(`${field} is not valid for protocol v3.`);
  }
  return number;
}

function protocolString(value, field, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${field} is not valid for protocol v3.`);
  return value;
}

function derivationDescriptor(segment = {}) {
  const descriptor = {
    protocol: 3,
    vaultId: protocolString(firstDefined(segment.vaultId, segment.vault_id, ""), "Vault ID", HEX_64),
    segmentId: protocolString(firstDefined(segment.segmentId, segment.id, ""), "Segment ID", UUID),
    keyDerivationVersion: protocolInteger(firstDefined(segment.keyDerivationVersion, segment.key_derivation_version, 3), "Key derivation version", { exact: 3 }),
    encryptionGeneration: protocolInteger(firstDefined(segment.encryptionGeneration, segment.encryption_generation, 1), "Encryption generation", { minimum: 1 }),
    storageFormatVersion: protocolInteger(firstDefined(segment.storageFormatVersion, segment.format_version, 3), "Storage format version", { exact: 3 }),
    dedupToken: protocolString(firstDefined(segment.dedupToken, segment.dedupFingerprint, segment.dedup_fingerprint, ""), "Deduplication token", HEX_64),
  };
  return descriptor;
}

function encryptionDescriptor(segment = {}) {
  const descriptor = derivationDescriptor(segment);
  const compression = firstDefined(segment.compression, segment.compression_method, "none");
  if (typeof compression !== "string" || !COMPRESSION_METHODS.has(compression)) {
    throw new Error("Compression method is not valid for protocol v3.");
  }
  return {
    domain: "themeshvault/v3/segment-cipher",
    ...descriptor,
    originalSize: protocolInteger(firstDefined(segment.originalSize, segment.original_size_bytes, 0), "Original size"),
    storedSize: protocolInteger(firstDefined(segment.storedSize, segment.stored_size_bytes, 0), "Stored size"),
    compression,
  };
}

export async function deriveSegmentKey(segment) {
  if (!segmentRootKey) throw new Error("The vault key hierarchy is not ready yet.");
  const descriptor = derivationDescriptor(segment);
  const salt = await sha256Bytes(canonicalBytes(descriptor));
  try {
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("themeshvault/v3/segment-aes-256-gcm") },
      segmentRootKey,
      256,
    );
    return new Uint8Array(bits);
  } finally {
    salt.fill(0);
  }
}

export function segmentEncryptionAad(segment = {}) {
  return JSON.stringify(encryptionDescriptor(segment));
}

export function segmentPrivateMetadataAad(segment = {}) {
  return JSON.stringify({ domain: "themeshvault/v3/segment-private-metadata", ...derivationDescriptor(segment) });
}

export async function encryptBytes(bytes, rawKey, aad) {
  const additionalData = requireAad(aad);
  let iv; let cipher;
  try {
    const key = await importAes256(rawKey);
    iv = crypto.getRandomValues(new Uint8Array(12));
    cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, bytes));
    const out = new Uint8Array(iv.byteLength + cipher.byteLength);
    out.set(iv);
    out.set(cipher, iv.byteLength);
    return out;
  } finally {
    additionalData.fill(0);
    iv?.fill(0);
    cipher?.fill(0);
  }
}

export async function decryptBytes(bytes, rawKey, aad) {
  const additionalData = requireAad(aad);
  const data = copyBytes(bytes);
  try {
    if (data.byteLength < 28) throw new Error("Encrypted segment is too short.");
    const key = await importAes256(rawKey);
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.subarray(0, 12), additionalData, tagLength: 128 },
      key,
      data.subarray(12),
    ));
  } finally {
    additionalData.fill(0);
    data.fill(0);
  }
}

export async function hashBytes(bytes) {
  return Array.from(await sha256Bytes(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}
