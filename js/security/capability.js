import { canonicalBytes, bytesToBase64Url, base64UrlToBytes, importPublicKeyRaw, verify as verifySignature, sealAesGcm, openAesGcm } from "./signing.js";

export const CAPABILITY_PROTOCOL_VERSION = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();

export async function buildCapability({ manifestId, segmentBundles, expiresInMs, password, downloadLimit, singleUse }, signer) {
  const capabilityId = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const capabilityKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const passwordHash = password ? bytesToBase64Url(await crypto.subtle.digest("SHA-256", enc.encode(password))) : null;
  const core = {
    capabilityId, protocolVersion: CAPABILITY_PROTOCOL_VERSION, manifestId, ownerPublicKey: signer.publicKey, algorithm: signer.algorithm,
    createdAt: Date.now(), expiresAt: Date.now() + expiresInMs, singleUse: !!singleUse, downloadLimit: downloadLimit || null, passwordHash,
  };
  const signature = bytesToBase64Url(await signer.sign(canonicalBytes(core)));
  const capabilityKey = await crypto.subtle.importKey("raw", capabilityKeyRaw, "AES-GCM", false, ["encrypt"]);
  const keysBlob = await sealAesGcm(capabilityKey, enc.encode(JSON.stringify(segmentBundles)), "meshvault-capability-keys-v1");
  const encryptedCapabilityMetadata = { core, signature, keysBlob };
  const fragment = bytesToBase64Url(enc.encode(JSON.stringify({ capabilityId, capabilityKey: bytesToBase64Url(capabilityKeyRaw), manifestId })));
  return { capabilityId, encryptedCapabilityMetadata, signature, fragment, expiresAt: core.expiresAt };
}

export async function verifyCapabilityCore(core, signature) {
  if (!core || core.protocolVersion !== CAPABILITY_PROTOCOL_VERSION) return false;
  if (Date.now() > core.expiresAt) return false;
  try {
    const publicKey = await importPublicKeyRaw(base64UrlToBytes(core.ownerPublicKey), core.algorithm);
    return await verifySignature(publicKey, core.algorithm, base64UrlToBytes(signature), canonicalBytes(core));
  } catch { return false; }
}
export async function checkCapabilityPassword(core, password) {
  if (!core.passwordHash) return true;
  return bytesToBase64Url(await crypto.subtle.digest("SHA-256", enc.encode(password || ""))) === core.passwordHash;
}
export async function openCapabilityKeys(keysBlob, capabilityKeyB64Url) {
  const capabilityKey = await crypto.subtle.importKey("raw", base64UrlToBytes(capabilityKeyB64Url), "AES-GCM", false, ["decrypt"]);
  const bytes = await openAesGcm(capabilityKey, keysBlob, "meshvault-capability-keys-v1");
  return JSON.parse(dec.decode(bytes));
}
export function parseShareFragment(fragment) { return JSON.parse(dec.decode(base64UrlToBytes(fragment))); }
export function buildShareUrl(capabilityId, fragment) { return `${location.origin}${location.pathname}#/share/${capabilityId}/${fragment}`; }
