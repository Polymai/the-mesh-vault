import {
  ALG_ED25519, base64UrlToBytes, bytesToBase64Url, canonicalBytes,
  canonicalHashHex, deriveHkdfBytes, hashHex, importPublicKeyRaw,
  openAesGcm, sealAesGcm, verify as verifySignature,
} from "./signing.js";

export const CAPABILITY_PROTOCOL_VERSION = 3;
const PBKDF2_ITERATIONS = 210000;
const enc = new TextEncoder();
const dec = new TextDecoder();

async function passwordMaterial(password, salt, iterations) {
  if (!password) return new Uint8Array();
  const passwordBytes = enc.encode(password.normalize("NFKC"));
  try {
    const base = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      base,
      256,
    ));
  } finally { passwordBytes.fill(0); }
}

async function capabilityKeyBytes(fragmentSecret, core, password) {
  const passwordBytes = await passwordMaterial(password, base64UrlToBytes(core.passwordSalt), core.passwordKdfIterations);
  const input = new Uint8Array(fragmentSecret.byteLength + passwordBytes.byteLength);
  input.set(fragmentSecret);
  input.set(passwordBytes, fragmentSecret.byteLength);
  passwordBytes.fill(0);
  try {
    const salt = base64UrlToBytes(core.capabilityId);
    return deriveHkdfBytes(input, salt, "themeshvault/v3/share-capability-key", 32);
  } finally {
    input.fill(0);
  }
}

function capabilityAad(core) {
  return `themeshvault/v3/share-capability:${core.capabilityId}:${core.manifestId}:${core.coreHash}`;
}
function encodedLength(value, expected) {
  try { return base64UrlToBytes(value).byteLength === expected; }
  catch { return false; }
}

export async function buildCapability({ vaultId, fileVersionId, manifestId, segmentBundles, expiresInMs, password, downloadLimit, singleUse }, signer) {
  if (signer?.algorithm !== ALG_ED25519) throw new Error("Protocol v3 share links require an Ed25519 vault.");
  const capabilityId = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const fragmentSecret = crypto.getRandomValues(new Uint8Array(32));
  const passwordSalt = crypto.getRandomValues(new Uint8Array(16));
  const unsigned = {
    capabilityId,
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    vaultId,
    fileVersionId,
    manifestId,
    ownerPublicKey: signer.publicKey,
    algorithm: signer.algorithm,
    createdAt: Date.now(),
    expiresAt: Date.now() + expiresInMs,
    singleUse: !!singleUse,
    downloadLimit: downloadLimit || null,
    passwordRequired: !!password,
    passwordSalt: bytesToBase64Url(passwordSalt),
    passwordKdf: "PBKDF2-SHA256",
    passwordKdfIterations: PBKDF2_ITERATIONS,
  };
  const core = { ...unsigned, coreHash: await canonicalHashHex(unsigned) };
  const signature = bytesToBase64Url(await signer.sign(canonicalBytes(core)));
  const rawKey = await capabilityKeyBytes(fragmentSecret, core, password || "");
  const segmentBundleBytes = enc.encode(JSON.stringify(segmentBundles));
  try {
    const capabilityKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const keysBlob = await sealAesGcm(capabilityKey, segmentBundleBytes, capabilityAad(core));
    const encryptedCapabilityMetadata = { core, signature, keysBlob };
    const fragment = bytesToBase64Url(enc.encode(JSON.stringify({
      capabilityId,
      fragmentSecret: bytesToBase64Url(fragmentSecret),
      manifestId,
      // The encrypted, signed capability travels in the URL fragment. URL
      // fragments are not sent to the web host, so recovery needs no hosted
      // capability table after the recipient opens the link.
      capability: encryptedCapabilityMetadata,
    })));
    return { capabilityId, encryptedCapabilityMetadata, signature, fragment, expiresAt: core.expiresAt };
  } finally {
    rawKey.fill(0);
    fragmentSecret.fill(0);
    segmentBundleBytes.fill(0);
  }
}

export async function verifyCapabilityCore(core, signature) {
  if (!core || core.protocolVersion !== CAPABILITY_PROTOCOL_VERSION || core.algorithm !== ALG_ED25519) return false;
  const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
  const HASH_RE = /^[a-f0-9]{64}$/i;
  if (!/^[A-Za-z0-9_-]{32}$/.test(String(core.capabilityId || ""))
    || !HASH_RE.test(String(core.vaultId || ""))
    || !HASH_RE.test(String(core.manifestId || ""))
    || !UUID_RE.test(String(core.fileVersionId || ""))
    || core.passwordKdf !== "PBKDF2-SHA256"
    || core.passwordKdfIterations !== PBKDF2_ITERATIONS
    || !encodedLength(core.passwordSalt, 16)
    || !Number.isSafeInteger(core.createdAt)
    || !Number.isSafeInteger(core.expiresAt)
    || core.expiresAt <= core.createdAt
    || core.expiresAt - core.createdAt > 366 * 24 * 60 * 60 * 1000
    || Date.now() > core.expiresAt
    || (await canonicalHashHex((({ coreHash, ...rest }) => rest)(core))) !== core.coreHash) return false;
  try {
    const publicBytes = base64UrlToBytes(core.ownerPublicKey);
    if (publicBytes.byteLength !== 32 || base64UrlToBytes(signature).byteLength !== 64 || (await hashHex(publicBytes)) !== core.vaultId) return false;
    const publicKey = await importPublicKeyRaw(publicBytes, core.algorithm);
    return verifySignature(publicKey, core.algorithm, base64UrlToBytes(signature), canonicalBytes(core));
  } catch {
    return false;
  }
}

export async function openCapabilityKeys(keysBlob, fragmentSecretB64Url, core, password = "") {
  if (!!core.passwordRequired !== !!password) {
    if (core.passwordRequired) throw new Error("This link requires its password.");
  }
  const fragmentSecret = base64UrlToBytes(fragmentSecretB64Url);
  const rawKey = await capabilityKeyBytes(fragmentSecret, core, password || "");
  fragmentSecret.fill(0);
  try {
    const capabilityKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const bytes = await openAesGcm(capabilityKey, keysBlob, capabilityAad(core));
    try { return JSON.parse(dec.decode(bytes)); }
    finally { bytes.fill(0); }
  } catch {
    throw new Error("The share secret or password is not valid.");
  } finally {
    rawKey.fill(0);
  }
}

export function parseShareFragment(fragment) {
  return JSON.parse(dec.decode(base64UrlToBytes(fragment)));
}

export function buildShareUrl(capabilityId, fragment) {
  return `${location.origin}${location.pathname}#/share/${capabilityId}/${fragment}`;
}
