import { hasShard, getShard } from "../storage/fragment-store.js";
import { hashHex } from "../security/signing.js";
import { lookupFragmentLocations as bootstrapLookupFragmentLocations, announceFragmentLocation as bootstrapAnnounceFragmentLocation } from "./providers/provider-registry.js";
import { holdersForFragment } from "./peer-registry.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}fragment-location-cache-v1`;
const STORE = "locations";
// A shard can be several MiB. Asking peers one by one with a short fixed wait
// made recovery fail on a healthy mesh whenever the right holder was late or a
// phone connection was temporarily slow. Request from every currently
// reachable candidate in parallel and allow the same bounded transfer window
// used by the peer protocol.
const PEER_WAIT_MS = 45000;
const MESH_WAIT_MS = 45000;

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "shardHash" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function idb(action, mode = "readonly") {
  const db = await database();
  return new Promise((resolve, reject) => { const tx = db.transaction(STORE, mode); const request = action(tx.objectStore(STORE)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export async function getCachedLocations(shardHash) { const row = await idb((store) => store.get(shardHash)).catch(() => null); return row?.holders || []; }
export async function recordVerifiedLocation(shardHash, peerId) {
  const row = (await idb((store) => store.get(shardHash)).catch(() => null)) || { shardHash, holders: [] };
  row.holders = [{ peerId, verifiedAt: Date.now() }, ...row.holders.filter((holder) => holder.peerId !== peerId)].slice(0, 10);
  await idb((store) => store.put(row), "readwrite");
}

async function verifiedBytes(bytes, shardHash) {
  if (!bytes) return null;
  return (await hashHex(bytes)) === shardHash ? bytes : null;
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForVerifiedShard(shardHash, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    if (await hasShard(shardHash)) {
      const bytes = await verifiedBytes(await getShard(shardHash), shardHash);
      if (bytes) return bytes;
    }
    await wait(100);
  }
  return null;
}

async function requestFromPeers(peers, shardHash, timeoutMs, signal) {
  if (signal?.aborted) return null;
  const unique = new Map();
  for (const peer of peers || []) {
    const peerId = peer?.peerId || peer?.nodeId;
    if (peerId && peer?.protocol) unique.set(peerId, peer);
  }
  if (!unique.size) return null;
  let sourcePeerId = null;
  const observeSource = (event) => {
    if (event.detail?.shardHash === shardHash && unique.has(event.detail?.fromNodeId)) sourcePeerId ||= event.detail.fromNodeId;
  };
  window.addEventListener("meshvault:shard-pulse", observeSource);
  try {
    for (const peer of unique.values()) peer.protocol.requestShard(shardHash);
    const bytes = await waitForVerifiedShard(shardHash, timeoutMs, signal);
    return bytes ? { bytes, sourcePeerId } : null;
  } finally {
    window.removeEventListener("meshvault:shard-pulse", observeSource);
  }
}

export async function findFragment(shardHash, { connectedPeers = [], propagate, connectToNode, signal } = {}) {
  if (signal?.aborted) return { bytes: null, source: "cancelled" };
  if (await hasShard(shardHash)) {
    const bytes = await verifiedBytes(await getShard(shardHash), shardHash);
    if (bytes) return { bytes, source: "local" };
  }

  const cachedPeerIds = new Set((await getCachedLocations(shardHash)).map((holder) => holder.peerId));
  const gossipedPeerIds = new Set(holdersForFragment(shardHash));
  const prioritized = [...connectedPeers].sort((a, b) => Number(gossipedPeerIds.has(b.peerId) || cachedPeerIds.has(b.peerId)) - Number(gossipedPeerIds.has(a.peerId) || cachedPeerIds.has(a.peerId)));
  const peerResult = await requestFromPeers(prioritized, shardHash, PEER_WAIT_MS, signal);
  if (peerResult) {
    if (peerResult.sourcePeerId) await recordVerifiedLocation(shardHash, peerResult.sourcePeerId);
    return { bytes: peerResult.bytes, source: "peer" };
  }

  if (signal?.aborted) return { bytes: null, source: "cancelled" };
  if (propagate) {
    const newHolderNodeIds = (await propagate(shardHash).catch(() => [])) || [];
    const discoveredPeers = [];
    for (const nodeId of newHolderNodeIds) {
      if (signal?.aborted) break;
      const peer = await connectToNode?.(nodeId).catch(() => null);
      if (peer) discoveredPeers.push(peer);
    }
    const meshResult = await requestFromPeers(discoveredPeers, shardHash, MESH_WAIT_MS, signal);
    if (meshResult) {
      if (meshResult.sourcePeerId) await recordVerifiedLocation(shardHash, meshResult.sourcePeerId);
      return { bytes: meshResult.bytes, source: "mesh" };
    }
  }

  if (signal?.aborted) return { bytes: null, source: "cancelled" };
  const bootstrapLocations = (await bootstrapLookupFragmentLocations(shardHash).catch(() => [])) || [];
  const bootstrapPeers = [];
  for (const location of bootstrapLocations) {
    if (signal?.aborted) break;
    const peer = await connectToNode?.(location.nodeId).catch(() => null);
    if (peer) bootstrapPeers.push(peer);
  }
  const bootstrapResult = await requestFromPeers(bootstrapPeers, shardHash, MESH_WAIT_MS, signal);
  if (bootstrapResult) {
    if (bootstrapResult.sourcePeerId) await recordVerifiedLocation(shardHash, bootstrapResult.sourcePeerId);
    return { bytes: bootstrapResult.bytes, source: "bootstrap" };
  }

  return { bytes: null, source: "unavailable" };
}

export async function announceHeldFragment(shardHash, nodeId) { await bootstrapAnnounceFragmentLocation(shardHash, nodeId).catch(() => {}); }
