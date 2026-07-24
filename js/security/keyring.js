let masterKey = null;
let masterRaw = null;

const enc = new TextEncoder();
export const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const base64ToBytes = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const b64 = bytesToBase64;
const unb64 = base64ToBytes;
async function importAes(raw, usages = ["encrypt", "decrypt"]) { return crypto.subtle.importKey("raw", raw, "AES-GCM", false, usages); }
async function seal(key, bytes, aad = "meshvault-envelope-v1") {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, bytes);
  return { v: 1, iv: b64(iv), cipher: b64(cipher), aad };
}
async function open(key, envelope) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv), additionalData: enc.encode(envelope.aad || "meshvault-envelope-v1") }, key, unb64(envelope.cipher));
}
export async function setMasterKeyRaw(raw) { masterRaw = new Uint8Array(raw); masterKey = await importAes(masterRaw); }
export async function encryptJson(value, aad = "metadata") {
  if (!masterKey) throw new Error("The vault's master key is not ready yet.");
  return seal(masterKey, enc.encode(JSON.stringify(value)), aad);
}
export async function decryptJson(envelope) {
  if (!masterKey) throw new Error("The vault's master key is not ready yet.");
  return JSON.parse(new TextDecoder().decode(await open(masterKey, envelope)));
}
export async function createFileKey() {
  if (!masterKey) throw new Error("The vault's master key is not ready yet.");
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await seal(masterKey, raw, "meshvault-file-key-v1");
  return { raw, wrapped };
}
export async function createSegmentKey() {
  if (!masterKey) throw new Error("The vault's master key is not ready yet.");
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await seal(masterKey, raw, "meshvault-segment-key-v1");
  return { raw, wrapped };
}
export async function unwrapFileKey(envelope) {
  if (!masterKey) throw new Error("The vault's master key is not ready yet.");
  return new Uint8Array(await open(masterKey, envelope));
}
export async function unwrapSegmentKey(envelope) {
  if (!masterKey) throw new Error("The vault's master key is not ready yet.");
  return new Uint8Array(await open(masterKey, envelope));
}
export async function dedupFingerprint(bytes) {
  if (!masterRaw) throw new Error("The vault's master key is not ready yet.");
  const key = await crypto.subtle.importKey("raw", masterRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const context = enc.encode("meshvault-vault-dedup-v1\0"); const input = new Uint8Array(context.length + bytes.byteLength); input.set(context); input.set(new Uint8Array(bytes), context.length);
  const signature = await crypto.subtle.sign("HMAC", key, input); input.fill(0);
  return Array.from(new Uint8Array(signature), (v) => v.toString(16).padStart(2, "0")).join("");
}
export async function encryptBytes(bytes, rawKey, aad = "") {
  const key = await importAes(rawKey); const iv = crypto.getRandomValues(new Uint8Array(12));
  const options = { name: "AES-GCM", iv, ...(aad ? { additionalData: enc.encode(aad) } : {}) };
  const cipher = await crypto.subtle.encrypt(options, key, bytes);
  const out = new Uint8Array(iv.length + cipher.byteLength); out.set(iv); out.set(new Uint8Array(cipher), iv.length); return out;
}
export async function decryptBytes(bytes, rawKey, aad = "") {
  const key = await importAes(rawKey); const data = new Uint8Array(bytes);
  const options = { name: "AES-GCM", iv: data.slice(0, 12), ...(aad ? { additionalData: enc.encode(aad) } : {}) };
  return new Uint8Array(await crypto.subtle.decrypt(options, key, data.slice(12)));
}
export async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
}
