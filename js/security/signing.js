export const ALG_ED25519 = "Ed25519";
export const ALG_ECDSA_P256 = "ECDSA-P256";

const enc = new TextEncoder();
export const bytesToBase64Url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const base64UrlToBytes = (value) => { const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "="); return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)); };

let detectedAlgorithm = null;
async function detectAlgorithm() {
  if (detectedAlgorithm) return detectedAlgorithm;
  try { await crypto.subtle.generateKey({ name: ALG_ED25519 }, true, ["sign", "verify"]); detectedAlgorithm = ALG_ED25519; }
  catch { detectedAlgorithm = ALG_ECDSA_P256; }
  return detectedAlgorithm;
}
function signParams(algorithm) { return algorithm === ALG_ED25519 ? { name: ALG_ED25519 } : { name: "ECDSA", hash: "SHA-256" }; }
function generateParams(algorithm) { return algorithm === ALG_ED25519 ? { name: ALG_ED25519 } : { name: "ECDSA", namedCurve: "P-256" }; }

export async function generateKeyPair() {
  const algorithm = await detectAlgorithm();
  const pair = await crypto.subtle.generateKey(generateParams(algorithm), true, ["sign", "verify"]);
  return { algorithm, publicKey: pair.publicKey, privateKey: pair.privateKey };
}
export async function exportPublicKeyRaw(publicKey) { return new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)); }
export async function importPublicKeyRaw(bytes, algorithm) { return crypto.subtle.importKey("raw", bytes, generateParams(algorithm), true, ["verify"]); }
export async function exportPrivateKeyJwk(privateKey) { return crypto.subtle.exportKey("jwk", privateKey); }
export async function exportPublicKeyJwk(publicKey) { return crypto.subtle.exportKey("jwk", publicKey); }
export async function importPrivateKeyJwk(jwk, algorithm) { return crypto.subtle.importKey("jwk", jwk, generateParams(algorithm), true, ["sign"]); }
export async function importPublicKeyJwk(jwk, algorithm) { return crypto.subtle.importKey("jwk", jwk, generateParams(algorithm), true, ["verify"]); }

export async function sign(privateKey, algorithm, bytes) { return new Uint8Array(await crypto.subtle.sign(signParams(algorithm), privateKey, bytes)); }
export async function verify(publicKey, algorithm, signature, bytes) {
  try { return await crypto.subtle.verify(signParams(algorithm), publicKey, signature, bytes); }
  catch { return false; }
}
export async function hashBytes(bytes) { return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); }
export async function hashHex(bytes) { return Array.from(await hashBytes(bytes), (v) => v.toString(16).padStart(2, "0")).join(""); }

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => { out[key] = sortDeep(value[key]); return out; }, {});
  return value;
}
export function canonicalBytes(value) { return enc.encode(JSON.stringify(sortDeep(value))); }
export async function canonicalHashHex(value) { return hashHex(canonicalBytes(value)); }

export async function deriveHkdfKey(ikmBytes, saltBytes, infoText, usages = ["encrypt", "decrypt"]) {
  const base = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: saltBytes, info: enc.encode(infoText) }, base, { name: "AES-GCM", length: 256 }, false, usages);
}
export async function sealAesGcm(key, bytes, aad = "") {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const options = { name: "AES-GCM", iv, ...(aad ? { additionalData: enc.encode(aad) } : {}) };
  const cipher = await crypto.subtle.encrypt(options, key, bytes);
  return { iv: bytesToBase64Url(iv), cipher: bytesToBase64Url(cipher) };
}
export async function openAesGcm(key, envelope, aad = "") {
  const options = { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv), ...(aad ? { additionalData: enc.encode(aad) } : {}) };
  return new Uint8Array(await crypto.subtle.decrypt(options, key, base64UrlToBytes(envelope.cipher)));
}
