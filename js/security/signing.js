export const ALG_ED25519 = "Ed25519";

const enc = new TextEncoder();
const ROOT_SALT_LABEL = "TheMeshVault deterministic key hierarchy v3";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

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

export function bytesToBase64Url(value) {
  const bytes = copyBytes(value);
  try {
    return btoa(binaryString(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } finally {
    bytes.fill(0);
  }
}

export function base64UrlToBytes(value) {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new Error("The value is not canonical base64url.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  let bytes;
  try {
    bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("The value is not valid base64url.");
  }
  if (bytesToBase64Url(bytes) !== value) {
    bytes.fill(0);
    throw new Error("The value is not canonical base64url.");
  }
  return bytes;
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function naclApi() {
  const api = globalThis.nacl;
  if (!api?.sign?.keyPair?.fromSeed || !api?.sign?.detached) {
    throw new Error("This browser could not load the pinned Ed25519 implementation.");
  }
  return api;
}

function edPublic(raw) {
  const bytes = copyBytes(raw);
  if (bytes.byteLength !== 32) {
    bytes.fill(0);
    throw new Error("Protocol v3 requires a 32-byte Ed25519 public key.");
  }
  return { type: "public", algorithm: ALG_ED25519, raw: bytes };
}

function edPrivate(seedInput) {
  const seed = copyBytes(seedInput);
  let pair = null;
  try {
    if (seed.byteLength !== 32) throw new Error("An Ed25519 signing seed must be 32 bytes.");
    pair = naclApi().sign.keyPair.fromSeed(seed);
    const privateKey = {
      type: "private",
      algorithm: ALG_ED25519,
      destroyed: false,
      secretKey: pair.secretKey,
      publicKey: pair.publicKey,
    };
    pair = null;
    return privateKey;
  } finally {
    seed.fill(0);
    pair?.secretKey?.fill(0);
  }
}

export function destroyPrivateKey(privateKey) {
  try { if (privateKey) privateKey.destroyed = true; } catch {}
  try { privateKey?.secretKey?.fill?.(0); } catch {}
  try { privateKey?.publicKey?.fill?.(0); } catch {}
}

export async function keyPairFromSeed(seedInput) {
  const seed = copyBytes(seedInput);
  try {
    if (seed.byteLength !== 32) throw new Error("An Ed25519 signing seed must be 32 bytes.");
    const privateKey = edPrivate(seed);
    return { algorithm: ALG_ED25519, privateKey, publicKey: edPublic(privateKey.publicKey) };
  } finally {
    seed.fill(0);
  }
}

export async function generateKeyPair() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  try {
    return await keyPairFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

export async function exportPublicKeyRaw(publicKey) {
  if (publicKey?.algorithm !== ALG_ED25519 || publicKey?.raw?.byteLength !== 32) {
    throw new Error("Only 32-byte Ed25519 public keys are supported by protocol v3.");
  }
  return copyBytes(publicKey.raw);
}

export async function importPublicKeyRaw(bytes, algorithm) {
  if (algorithm !== ALG_ED25519) throw new Error("Protocol v3 requires an Ed25519 public key.");
  return edPublic(bytes);
}

function validateJwkMetadata(jwk, usage) {
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk) || jwk.kty !== "OKP" || jwk.crv !== ALG_ED25519) {
    throw new Error("Protocol v3 requires an OKP Ed25519 JWK.");
  }
  if (jwk.alg !== undefined && !["EdDSA", ALG_ED25519].includes(jwk.alg)) {
    throw new Error("The JWK algorithm is not compatible with Ed25519.");
  }
  if (jwk.use !== undefined && jwk.use !== "sig") throw new Error("The JWK is not a signing key.");
  if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes(usage))) {
    throw new Error(`The JWK does not permit ${usage}.`);
  }
}

export async function exportPrivateKeyJwk(privateKey) {
  if (privateKey?.destroyed || privateKey?.algorithm !== ALG_ED25519 || privateKey?.secretKey?.byteLength !== 64 || privateKey?.publicKey?.byteLength !== 32) {
    throw new Error("Only Ed25519 private keys are supported.");
  }
  if (!equalBytes(privateKey.secretKey.subarray(32), privateKey.publicKey)) {
    throw new Error("The Ed25519 private key is internally inconsistent.");
  }
  return {
    kty: "OKP",
    crv: ALG_ED25519,
    d: bytesToBase64Url(privateKey.secretKey.subarray(0, 32)),
    x: bytesToBase64Url(privateKey.publicKey),
  };
}

export async function exportPublicKeyJwk(publicKey) {
  return { kty: "OKP", crv: ALG_ED25519, x: bytesToBase64Url(await exportPublicKeyRaw(publicKey)) };
}

export async function importPrivateKeyJwk(jwk, algorithm) {
  if (algorithm !== ALG_ED25519) throw new Error("Protocol v3 requires an Ed25519 private key.");
  validateJwkMetadata(jwk, "sign");
  if (typeof jwk.d !== "string" || typeof jwk.x !== "string") {
    throw new Error("An Ed25519 private JWK requires both d and x.");
  }
  let seed; let publicBytes; let key = null;
  try {
    seed = base64UrlToBytes(jwk.d);
    publicBytes = base64UrlToBytes(jwk.x);
    if (seed.byteLength !== 32 || publicBytes.byteLength !== 32) {
      throw new Error("Ed25519 JWK coordinates must contain exactly 32 bytes.");
    }
    key = edPrivate(seed);
    if (!equalBytes(key.publicKey, publicBytes)) throw new Error("The Ed25519 key material is inconsistent.");
    const result = key;
    key = null;
    return result;
  } finally {
    seed?.fill(0);
    publicBytes?.fill(0);
    destroyPrivateKey(key);
  }
}

export async function importPublicKeyJwk(jwk, algorithm) {
  if (algorithm !== ALG_ED25519) throw new Error("Protocol v3 requires an Ed25519 public key.");
  validateJwkMetadata(jwk, "verify");
  if (typeof jwk.x !== "string") throw new Error("An Ed25519 public JWK requires x.");
  const publicBytes = base64UrlToBytes(jwk.x);
  try {
    if (publicBytes.byteLength !== 32) throw new Error("An Ed25519 public coordinate must contain exactly 32 bytes.");
    return await importPublicKeyRaw(publicBytes, algorithm);
  } finally {
    publicBytes.fill(0);
  }
}

export async function sign(privateKey, algorithm, bytes) {
  if (privateKey?.destroyed || algorithm !== ALG_ED25519 || privateKey?.algorithm !== ALG_ED25519 || privateKey?.secretKey?.byteLength !== 64) {
    throw new Error("Protocol v3 signs with a 64-byte Ed25519 secret key only.");
  }
  const message = copyBytes(bytes);
  try {
    return new Uint8Array(naclApi().sign.detached(message, privateKey.secretKey));
  } finally {
    message.fill(0);
  }
}

export async function verify(publicKey, algorithm, signature, bytes) {
  let signatureBytes; let message;
  try {
    if (algorithm !== ALG_ED25519 || publicKey?.algorithm !== ALG_ED25519 || publicKey?.raw?.byteLength !== 32) return false;
    signatureBytes = copyBytes(signature);
    if (signatureBytes.byteLength !== 64) return false;
    message = copyBytes(bytes);
    return naclApi().sign.detached.verify(message, signatureBytes, publicKey.raw);
  } catch {
    return false;
  } finally {
    signatureBytes?.fill(0);
    message?.fill(0);
  }
}

export async function hashBytes(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function hashHex(bytes) {
  return Array.from(await hashBytes(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => { out[key] = sortDeep(value[key]); return out; }, {});
  return value;
}

export function canonicalBytes(value) {
  return enc.encode(JSON.stringify(sortDeep(value)));
}

export async function canonicalHashHex(value) {
  return hashHex(canonicalBytes(value));
}

export async function deriveHkdfBytes(ikmBytes, saltBytes, infoText, length = 32) {
  if (typeof infoText !== "string" || !infoText || !Number.isSafeInteger(length) || length < 1) {
    throw new Error("HKDF requires a non-empty domain and a positive byte length.");
  }
  const ikm = copyBytes(ikmBytes);
  const salt = copyBytes(saltBytes);
  const info = enc.encode(infoText);
  try {
    const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, base, length * 8);
    return new Uint8Array(bits);
  } finally {
    ikm.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}

export async function deriveRootBytes(rootSeed, domain, length = 32) {
  if (typeof domain !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(domain)) {
    throw new Error("Root-key derivation requires an explicit protocol domain.");
  }
  const salt = await hashBytes(enc.encode(ROOT_SALT_LABEL));
  try {
    return await deriveHkdfBytes(rootSeed, salt, `themeshvault/v3/${domain}`, length);
  } finally {
    salt.fill(0);
  }
}

export async function deriveHkdfKey(ikmBytes, saltBytes, infoText, usages = ["encrypt", "decrypt"]) {
  const raw = await deriveHkdfBytes(ikmBytes, saltBytes, infoText, 32);
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
  } finally {
    raw.fill(0);
  }
}

function requireAad(aad) {
  if (typeof aad !== "string" || !aad) throw new Error("Authenticated encryption requires an explicit context.");
  return enc.encode(aad);
}

export async function sealAesGcm(key, bytes, aad) {
  const additionalData = requireAad(aad);
  let iv; let cipherBytes;
  try {
    iv = crypto.getRandomValues(new Uint8Array(12));
    cipherBytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, bytes));
    return { v: 3, iv: bytesToBase64Url(iv), cipher: bytesToBase64Url(cipherBytes) };
  } finally {
    additionalData.fill(0);
    iv?.fill(0);
    cipherBytes?.fill(0);
  }
}

export async function openAesGcm(key, envelope, aad) {
  if (envelope?.v !== 3 || typeof envelope?.iv !== "string" || typeof envelope?.cipher !== "string") {
    throw new Error("The authenticated-encryption envelope is not protocol v3.");
  }
  const additionalData = requireAad(aad);
  let iv; let cipher;
  try {
    iv = base64UrlToBytes(envelope.iv);
    cipher = base64UrlToBytes(envelope.cipher);
    if (iv.byteLength !== 12 || cipher.byteLength < 16) throw new Error("The authenticated-encryption envelope is malformed.");
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, key, cipher));
  } finally {
    additionalData.fill(0);
    iv?.fill(0);
    cipher?.fill(0);
  }
}
