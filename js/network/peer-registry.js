const STALE_MS = 5 * 60 * 1000;
const SWEEP_MS = 30000;
const peers = new Map();
const manifestAnnouncements = new Map();
const fragmentAnnouncements = new Map();

function sweep() {
  const now = Date.now();
  for (const [key, peer] of peers) if (now - peer.lastSeenAt > STALE_MS) peers.delete(key);
  for (const [manifestId, holders] of manifestAnnouncements) { for (const [key, info] of holders) if (now - info.announcedAt > STALE_MS) holders.delete(key); if (!holders.size) manifestAnnouncements.delete(manifestId); }
  for (const [shardHash, holders] of fragmentAnnouncements) { for (const [key, info] of holders) if (now - info.announcedAt > STALE_MS) holders.delete(key); if (!holders.size) fragmentAnnouncements.delete(shardHash); }
}
if (typeof window !== "undefined") setInterval(sweep, SWEEP_MS);

// Keyed by peerId (the mesh node id), not devicePublicKey: the node id is
// known the instant a DataChannel opens, while the device public key is only
// learned once a signed gossip message arrives. Keying by the key that isn't
// known yet caused every freshly-connected peer to collide under the same
// entry and silently overwrite one another.
export function upsertPeer({ peerId, devicePublicKey, protocolVersion, capacityBytes = 0, usedBytes = 0, availableStorageBytes, countryCode = null, regionCode = null, networkDomainHash = null, capabilities = [], reliabilityScore = null, survivalMode = false, leaseExpiresAt = null, uptimeSeconds = null, buddyNodeIds = [], trustStatus = "unverified" }) {
  const existing = peers.get(peerId);
  const resolvedCapacity = capacityBytes || existing?.capacityBytes || 0;
  const resolvedUsed = usedBytes || existing?.usedBytes || 0;
  peers.set(peerId, {
    peerId, devicePublicKey: devicePublicKey || existing?.devicePublicKey || null, protocolVersion, capabilities: capabilities?.length ? capabilities : existing?.capabilities || [], trustStatus,
    capacityBytes: resolvedCapacity, usedBytes: resolvedUsed,
    countryCode: countryCode || existing?.countryCode || null, regionCode: regionCode || existing?.regionCode || null, networkDomainHash: networkDomainHash || existing?.networkDomainHash || null,
    reliabilityScore: reliabilityScore ?? existing?.reliabilityScore ?? null,
    survivalMode: !!survivalMode, leaseExpiresAt: leaseExpiresAt || existing?.leaseExpiresAt || null,
    uptimeSeconds: uptimeSeconds ?? existing?.uptimeSeconds ?? null, buddyNodeIds: buddyNodeIds?.length ? buddyNodeIds.slice(0, 4) : existing?.buddyNodeIds || [],
    availableStorageBytes: availableStorageBytes ?? Math.max(0, resolvedCapacity - resolvedUsed),
    firstSeenAt: existing?.firstSeenAt || Date.now(), lastSeenAt: Date.now(),
  });
}
export function updatePeerCapacity(peerId, capacityBytes, usedBytes) {
  const existing = peers.get(peerId);
  if (!existing) return;
  existing.capacityBytes = capacityBytes; existing.usedBytes = usedBytes;
  existing.availableStorageBytes = Math.max(0, capacityBytes - usedBytes);
  existing.lastSeenAt = Date.now();
}
export function touchPeer(peerId) { const peer = peers.get(peerId); if (peer) peer.lastSeenAt = Date.now(); }
export function removePeer(peerId) { peers.delete(peerId); }
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
