import { generateSecretKey, getPublicKey } from "../../vendor/nostr-tools.bundle.js";
import { base64UrlToBytes, bytesToBase64Url } from "../../security/signing.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}rendezvous-identity-v1`;
const STORE = "transport";
let cachedPromise = null;

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRecord() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get("primary");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeRecord(record) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Rendezvous identity storage was aborted."));
  });
}

export async function loadOrCreateRendezvousIdentity() {
  if (!cachedPromise) cachedPromise = (async () => {
    let record = await readRecord().catch(() => null);
    let secretKey;
    try {
      secretKey = record?.secretKey ? base64UrlToBytes(record.secretKey) : generateSecretKey();
      if (secretKey.byteLength !== 32) throw new Error("The rendezvous transport key is invalid.");
      const publicKey = getPublicKey(secretKey);
      if (!record || record.publicKey !== publicKey) {
        record = { id: "primary", secretKey: bytesToBase64Url(secretKey), publicKey, createdAt: Date.now() };
        await writeRecord(record);
      }
      return { publicKey, secretKey: new Uint8Array(secretKey) };
    } finally {
      secretKey?.fill?.(0);
    }
  })();
  return cachedPromise;
}
