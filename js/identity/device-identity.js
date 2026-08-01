import {
  generateKeyPair, exportPublicKeyRaw, exportPrivateKeyJwk, exportPublicKeyJwk,
  importPrivateKeyJwk, sign as signBytes, hashHex, bytesToBase64Url,
} from "../security/signing.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}device-identity-v1`;
const STORE = "device";

let cached = null;
let loadingPromise = null;

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
    tx.onabort = () => reject(tx.error || new Error("Device identity storage transaction was aborted."));
    if (mode !== "readonly") tx.oncomplete = () => resolve(result);
  });
}
function detectDeviceType() {
  const ua = navigator.userAgent || "";
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (/mobi|iphone|android/i.test(ua)) return "mobile";
  return "desktop";
}
function defaultLabel(deviceType) {
  const platform = navigator.platform || navigator.userAgentData?.platform || "";
  const names = { desktop: platform.includes("Mac") ? "Mac" : platform.includes("Win") ? "Windows PC" : "Desktop", mobile: "Mobile device", tablet: "Tablet" };
  return names[deviceType] || "This device";
}

async function createRecord(label) {
  const { algorithm, publicKey, privateKey } = await generateKeyPair();
  const devicePublicKeyRaw = await exportPublicKeyRaw(publicKey);
  const deviceId = await hashHex(devicePublicKeyRaw);
  const deviceType = detectDeviceType();
  return {
    id: "primary", deviceId, algorithm, devicePrivateKeyJwk: await exportPrivateKeyJwk(privateKey),
    devicePublicKeyRaw: bytesToBase64Url(devicePublicKeyRaw), label: label || defaultLabel(deviceType),
    deviceType, createdAt: Date.now(),
  };
}
async function hydrate(record) {
  const privateKey = await importPrivateKeyJwk(record.devicePrivateKeyJwk, record.algorithm);
  return {
    deviceId: record.deviceId, algorithm: record.algorithm, devicePublicKey: record.devicePublicKeyRaw,
    label: record.label, deviceType: record.deviceType, createdAt: record.createdAt,
    sign: (bytes) => signBytes(privateKey, record.algorithm, bytes), _record: record,
  };
}

export async function loadOrCreateDeviceIdentity() {
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
export function currentDeviceIdentity() { return cached; }
export async function renameDevice(label) {
  if (!cached) return;
  cached._record.label = label; cached.label = label;
  await idb((store) => store.put(cached._record), "readwrite");
}
export function buildRegisterDevicePayload(vaultId) {
  if (!cached) throw new Error("Device identity is not ready yet.");
  return { vaultId, deviceId: cached.deviceId, devicePublicKey: cached.devicePublicKey, algorithm: cached.algorithm, label: cached.label, deviceType: cached.deviceType, registeredAt: Date.now() };
}
