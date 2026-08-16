import { verifyManifestV3 } from "../security/manifest.js";
import { lookupManifest as bootstrapLookupManifest } from "./providers/provider-registry.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}manifest-store-v3`;
const STORE = "manifests";

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "manifestId" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function idb(action, mode = "readonly") {
  const db = await database();
  return new Promise((resolve, reject) => { const tx = db.transaction(STORE, mode); const request = action(tx.objectStore(STORE)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export async function saveManifestLocally(envelope) { await idb((store) => store.put(envelope), "readwrite"); }
export async function getLocalManifest(manifestId) { return idb((store) => store.get(manifestId)).catch(() => null); }
export async function listLocalManifestIds() { return idb((store) => store.getAllKeys()).catch(() => []); }
export async function deleteLocalManifest(manifestId) { return idb((store) => store.delete(manifestId), "readwrite").catch(() => {}); }

async function verifiedOrNull(envelope, verifyOpts) {
  if (!envelope) return null;
  const result = await verifyManifestV3(envelope, verifyOpts);
  return result.valid ? envelope : null;
}

export async function findManifest(manifestId, { connectedPeers = [], trustedDevicePeerIds = new Set(), propagate, verifyOpts = {} } = {}) {
  let envelope = await verifiedOrNull(await getLocalManifest(manifestId), verifyOpts);
  if (envelope) return { envelope, source: "local" };

  const trusted = connectedPeers.filter((peer) => trustedDevicePeerIds.has(peer.peerId));
  const others = connectedPeers.filter((peer) => !trustedDevicePeerIds.has(peer.peerId));
  for (const peer of [...trusted, ...others]) {
    envelope = await verifiedOrNull(await peer.protocol.requestManifest(manifestId).catch(() => null), verifyOpts);
    if (envelope) { await saveManifestLocally(envelope); return { envelope, source: trusted.includes(peer) ? "trusted-device" : "peer" }; }
  }

  if (propagate) {
    const discoveredPeers = (await propagate(manifestId).catch(() => [])) || [];
    for (const peer of discoveredPeers) {
      envelope = await verifiedOrNull(await peer.protocol.requestManifest(manifestId).catch(() => null), verifyOpts);
      if (envelope) { await saveManifestLocally(envelope); return { envelope, source: "mesh" }; }
    }
  }

  envelope = await verifiedOrNull(await bootstrapLookupManifest(manifestId), verifyOpts);
  if (envelope) { await saveManifestLocally(envelope); return { envelope, source: "bootstrap" }; }

  return { envelope: null, source: "unavailable" };
}
