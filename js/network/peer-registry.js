const STALE_MS = 5 * 60 * 1000;
const SWEEP_MS = 30000;
const peers = new Map();
const manifestAnnouncements = new Map();
const fragmentAnnouncements = new Map();
const PROFILE_CHANNEL_NAME = "themeshvault-peer-registry-v1";
const profileChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(PROFILE_CHANNEL_NAME) : null;
let registryEventQueued = false;

function announceRegistryUpdate(reason = "changed") {
  if (typeof window === "undefined" || registryEventQueued) return;
  registryEventQueued = true;
  queueMicrotask(() => {
    registryEventQueued = false;
    window.dispatchEvent(new CustomEvent("meshvault:peer-registry-updated", { detail: { reason } }));
  });
}

function comparablePeer(peer = {}) {
  return JSON.stringify([
    peer.peerId || null,
    peer.nodeName || null,
    peer.devicePublicKey || null,
    peer.countryCode || null,
    peer.regionCode || null,
    peer.networkDomainHash || null,
    peer.failureDomainId || null,
    [...(peer.capabilities || [])].sort(),
    !!peer.survivalMode,
    Number(peer.anchorProtocolVersion || 0),
    peer.coordinationMode || null,
  ]);
}

function sharePeer(peer) {
  try { profileChannel?.postMessage({ type: "peer", peer }); } catch {}
}

function shareRemoval(peerId) {
  try { profileChannel?.postMessage({ type: "remove", peerId }); } catch {}
}

function sweep() {
  const now = Date.now();
  let peerRemoved = false;
  for (const [key, peer] of peers) if (now - peer.lastSeenAt > STALE_MS) { peers.delete(key); peerRemoved = true; }
  for (const [manifestId, holders] of manifestAnnouncements) { for (const [key, info] of holders) if (now - info.announcedAt > STALE_MS) holders.delete(key); if (!holders.size) manifestAnnouncements.delete(manifestId); }
  for (const [shardHash, holders] of fragmentAnnouncements) { for (const [key, info] of holders) if (now - info.announcedAt > STALE_MS) holders.delete(key); if (!holders.size) fragmentAnnouncements.delete(shardHash); }
  if (peerRemoved) announceRegistryUpdate("expired");
}
if (typeof window !== "undefined") setInterval(sweep, SWEEP_MS);

// Keyed by peerId (the mesh node id), not devicePublicKey: the node id is
// known the instant a DataChannel opens, while the device public key is only
// learned once a signed gossip message arrives. Keying by the key that isn't
// known yet caused every freshly-connected peer to collide under the same
// entry and silently overwrite one another.
export function upsertPeer({
  peerId, nodeName = null, devicePublicKey, protocolVersion, capacityBytes = 0, usedBytes = 0,
  availableStorageBytes, countryCode = null, regionCode = null, networkDomainHash = null,
  failureDomainId = null, capabilities = [], reliabilityScore = null, survivalMode = false,
  leaseExpiresAt = null, uptimeSeconds = null, buddyNodeIds = [], anchorProtocolVersion = null,
  anchorControlCapacityBytes = null, anchorControlUsedBytes = null, anchorConnectedNodes = null,
  coordinationMode = null, trustStatus = "unverified",
}, { broadcast = true } = {}) {
  if (!peerId) return false;
  const existing = peers.get(peerId);
  const resolvedCapacity = capacityBytes || existing?.capacityBytes || 0;
  const resolvedUsed = usedBytes || existing?.usedBytes || 0;
  const resolvedNodeName = String(nodeName || existing?.nodeName || "Mesh peer").trim().slice(0, 80) || "Mesh peer";
  const next = {
    peerId, nodeName: resolvedNodeName, devicePublicKey: devicePublicKey || existing?.devicePublicKey || null, protocolVersion, capabilities: capabilities?.length ? capabilities : existing?.capabilities || [], trustStatus,
    capacityBytes: resolvedCapacity, usedBytes: resolvedUsed,
    countryCode: countryCode || existing?.countryCode || null, regionCode: regionCode || existing?.regionCode || null, networkDomainHash: networkDomainHash || existing?.networkDomainHash || null,
    failureDomainId: failureDomainId || existing?.failureDomainId || peerId,
    reliabilityScore: reliabilityScore ?? existing?.reliabilityScore ?? null,
    survivalMode: !!survivalMode, leaseExpiresAt: leaseExpiresAt || existing?.leaseExpiresAt || null,
    anchorProtocolVersion: anchorProtocolVersion ?? existing?.anchorProtocolVersion ?? 0,
    anchorControlCapacityBytes: anchorControlCapacityBytes ?? existing?.anchorControlCapacityBytes ?? 0,
    anchorControlUsedBytes: anchorControlUsedBytes ?? existing?.anchorControlUsedBytes ?? 0,
    anchorConnectedNodes: anchorConnectedNodes ?? existing?.anchorConnectedNodes ?? 0,
    coordinationMode: coordinationMode || existing?.coordinationMode || null,
    uptimeSeconds: uptimeSeconds ?? existing?.uptimeSeconds ?? null, buddyNodeIds: buddyNodeIds?.length ? buddyNodeIds.slice(0, 4) : existing?.buddyNodeIds || [],
    availableStorageBytes: availableStorageBytes ?? Math.max(0, resolvedCapacity - resolvedUsed),
    firstSeenAt: existing?.firstSeenAt || Date.now(), lastSeenAt: Date.now(),
  };
  peers.set(peerId, next);
  const changed = !existing || comparablePeer(existing) !== comparablePeer(next);
  if (changed) announceRegistryUpdate(existing ? "changed" : "added");
  if (broadcast) sharePeer(next);
  return changed;
}
export function updatePeerCapacity(peerId, capacityBytes, usedBytes) {
  const existing = peers.get(peerId);
  if (!existing) return;
  const changed = existing.capacityBytes !== capacityBytes || existing.usedBytes !== usedBytes;
  existing.capacityBytes = capacityBytes; existing.usedBytes = usedBytes;
  existing.availableStorageBytes = Math.max(0, capacityBytes - usedBytes);
  existing.lastSeenAt = Date.now();
  if (changed) { announceRegistryUpdate("capacity"); sharePeer(existing); }
}
export function touchPeer(peerId) { const peer = peers.get(peerId); if (peer) peer.lastSeenAt = Date.now(); }
export function removePeer(peerId, { broadcast = true } = {}) {
  const removed = peers.delete(peerId);
  if (removed) {
    announceRegistryUpdate("removed");
    if (broadcast) shareRemoval(peerId);
  }
  return removed;
}
export function listKnownPeers() { return Array.from(peers.values()); }
export function getPeer(peerId) { return peers.get(peerId) || null; }
export function peerCount() { return peers.size; }

export function recordManifestAnnouncement(manifestId, devicePublicKey) {
  if (!manifestAnnouncements.has(manifestId)) manifestAnnouncements.set(manifestId, new Map());
  manifestAnnouncements.get(manifestId).set(devicePublicKey, { announcedAt: Date.now() });
}
export function holdersForManifest(manifestId) { return Array.from((manifestAnnouncements.get(manifestId) || new Map()).keys()); }
export function recordFragmentAnnouncement(shardHash, devicePublicKey) {
  if (!fragmentAnnouncements.has(shardHash)) fragmentAnnouncements.set(shardHash, new Map());
  fragmentAnnouncements.get(shardHash).set(devicePublicKey, { announcedAt: Date.now() });
}
export function holdersForFragment(shardHash) { return Array.from((fragmentAnnouncements.get(shardHash) || new Map()).keys()); }

if (profileChannel) {
  profileChannel.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "request") {
      try { profileChannel.postMessage({ type: "snapshot", peers: listKnownPeers() }); } catch {}
      return;
    }
    if (message.type === "snapshot") {
      (Array.isArray(message.peers) ? message.peers : []).forEach((peer) => upsertPeer(peer, { broadcast: false }));
      return;
    }
    if (message.type === "peer" && message.peer) upsertPeer(message.peer, { broadcast: false });
    if (message.type === "remove" && message.peerId) removePeer(message.peerId, { broadcast: false });
  });
  try { profileChannel.postMessage({ type: "request" }); } catch {}
}
