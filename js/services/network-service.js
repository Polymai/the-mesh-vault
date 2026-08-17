import { listKnownPeers } from "../network/peer-registry.js";
import { listTopologyObservations } from "../network/topology-registry.js";

const MESH_VIEW_NODE_LIMIT = 96;
const SNAPSHOT_LIMIT = 48;
const EVENT_LIMIT = 48;
const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const EVENT_KEY = `${prefix}mesh-network-events-v3`;
const SNAPSHOT_KEY = `${prefix}mesh-network-snapshots-v3`;
const ICE_CACHE_KEY = `${prefix}peer-ice-config-v3`;

function readBounded(key, limit) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(rows) ? rows.slice(-limit) : [];
  } catch { return []; }
}

function writeBounded(key, rows, limit) {
  try { localStorage.setItem(key, JSON.stringify(rows.slice(-limit))); } catch {}
}

function cachedIceConfig() {
  try { return JSON.parse(sessionStorage.getItem(ICE_CACHE_KEY) || "null")?.value || null; }
  catch { return null; }
}

// ICE discovery is transport setup, not mesh metadata. A configuration fetched
// during cold start may be reused for the life of this browser session. Once a
// mesh route exists this function never contacts Supabase; it falls back to
// ordinary public STUN, which carries no vault/file/shard data.
export async function getPeerIceConfig() {
  const cached = cachedIceConfig();
  if (cached) return cached;
  return {
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.l.google.com:19302" },
    ],
    source: "public-stun",
  };
}

function peerToNode(peer) {
  return {
    id: peer.peerId,
    device_public_key: peer.devicePublicKey || null,
    failure_domain_id: peer.failureDomainId || peer.peerId,
    device_label: peer.nodeName || "Mesh peer",
    status: "online",
    reliability_score: peer.reliabilityScore,
    survival_mode: !!peer.survivalMode,
    capacity_bytes: Number(peer.capacityBytes || 0),
    used_bytes: Number(peer.usedBytes || 0),
    country_code: peer.countryCode || null,
    region_code: peer.regionCode || null,
    network_domain_hash: peer.networkDomainHash || null,
    last_seen_at: new Date(Number(peer.lastSeenAt || Date.now())).toISOString(),
    capabilities: peer.capabilities || [],
  };
}

export async function loadNetworkOverview({ includeNodes = true } = {}) {
  const peers = listKnownPeers().slice(0, MESH_VIEW_NODE_LIMIT);
  const nodes = includeNodes ? peers.map(peerToNode) : [];
  return {
    nodes,
    events: readBounded(EVENT_KEY, EVENT_LIMIT).slice(-6).reverse(),
    snapshots: readBounded(SNAPSHOT_KEY, SNAPSHOT_LIMIT),
    activeNodes: peers.length,
    verifiedCapacity: peers.reduce((sum, peer) => sum + Number(peer.capacityBytes || 0), 0),
    usedBytes: peers.reduce((sum, peer) => sum + Number(peer.usedBytes || 0), 0),
    topology: listTopologyObservations(),
    source: "observed-mesh",
  };
}

export async function writeNetworkEvent(vaultId, eventType, details = {}) {
  const rows = readBounded(EVENT_KEY, EVENT_LIMIT);
  rows.push({ id: crypto.randomUUID(), vault_id: vaultId, event_type: eventType, details, created_at: new Date().toISOString() });
  writeBounded(EVENT_KEY, rows, EVENT_LIMIT);
  window.dispatchEvent(new CustomEvent("meshvault:network-event", { detail: rows.at(-1) }));
  return rows.at(-1);
}

export async function writeSnapshot(vaultId, snapshot) {
  const rows = readBounded(SNAPSHOT_KEY, SNAPSHOT_LIMIT);
  const value = {
    id: crypto.randomUUID(), vault_id: vaultId,
    active_nodes: Number(snapshot.activeNodes || 0),
    verified_capacity_bytes: Number(snapshot.verifiedCapacity || 0),
    used_bytes: Number(snapshot.usedBytes || 0),
    resilient_bytes: Number(snapshot.resilientBytes || 0),
    captured_at: new Date().toISOString(),
  };
  rows.push(value); writeBounded(SNAPSHOT_KEY, rows, SNAPSHOT_LIMIT); return value;
}
