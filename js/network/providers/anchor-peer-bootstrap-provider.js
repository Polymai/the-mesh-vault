import {
  publishControlObject, queryAnchors, publishManifestReplica, lookupManifestReplica,
  relaySignalThroughAnchors, onRelayedSignal,
} from "../anchor-service.js";

let presencePayload = () => null;
const presenceListeners = new Set();
const PEER_PROTOCOL_VERSION = 3;

export function configureAnchorPeerProvider({ getPresencePayload } = {}) {
  presencePayload = typeof getPresencePayload === "function" ? getPresencePayload : () => null;
}

function validPeerPayload(payload) {
  return payload
    && payload.protocolVersion === PEER_PROTOCOL_VERSION
    && typeof payload.nodeId === "string"
    && payload.nodeId
    && Number(payload.expiresAt || 0) > Date.now();
}

export const anchorPeerBootstrapProvider = {
  name: "anchor-peer",
  async discoverPeers() {
    const rows = await queryAnchors("peer", "active", 40);
    return rows.map((row) => row.payload).filter(validPeerPayload).map((peer) => ({
      peerId: peer.nodeId, nodeName: peer.nodeName || null, devicePublicKey: peer.devicePublicKey || null, protocolVersion: PEER_PROTOCOL_VERSION,
      capacityBytes: Number(peer.capacityBytes) || 0, usedBytes: Number(peer.usedBytes) || 0,
      countryCode: peer.countryCode || null, regionCode: peer.regionCode || null,
      networkDomainHash: peer.networkDomainHash || null, failureDomainId: peer.failureDomainId || null,
      reliabilityScore: peer.reliabilityScore ?? null, survivalMode: !!peer.survivalMode,
      leaseExpiresAt: peer.leaseExpiresAt || null, anchorProtocolVersion: Number(peer.anchorProtocolVersion) || 0,
      anchorControlCapacityBytes: Number(peer.anchorControlCapacityBytes) || 0,
      anchorControlUsedBytes: Number(peer.anchorControlUsedBytes) || 0,
      anchorConnectedNodes: Number(peer.anchorConnectedNodes) || 0,
      capabilities: peer.capabilities || [], source: "anchor-peer",
    }));
  },
  async publishPresence() {
    const payload = presencePayload();
    if (!payload?.nodeId || payload.protocolVersion !== PEER_PROTOCOL_VERSION) return [];
    const value = { ...payload, observedAt: Date.now(), expiresAt: Date.now() + 120000 };
    await publishControlObject("peer", "active", value, 120000);
    const entries = [value];
    presenceListeners.forEach((listener) => { try { listener(entries); } catch {} });
    return entries;
  },
  onPresence(handler) { presenceListeners.add(handler); return () => presenceListeners.delete(handler); },
  async sendSignal(signal) {
    const sent = relaySignalThroughAnchors(signal);
    return sent > 0 ? { accepted: true, conclusive: true } : false;
  },
  onSignal(handler) { return onRelayedSignal(handler); },
  async lookupManifest(manifestId) { return lookupManifestReplica(manifestId); },
  async announceManifest(envelope) { return publishManifestReplica(envelope); },
  async lookupFragmentLocations(shardHash) {
    const rows = await queryAnchors("fragment-location", shardHash, 20);
    return rows.map((row) => row.payload).filter((payload) => payload?.shardHash === shardHash && payload?.nodeId && Date.now() - Number(payload.announcedAt || 0) < 300000).map((payload) => ({ nodeId: payload.nodeId, announcedAt: payload.announcedAt, source: "anchor-peer" }));
  },
  async announceFragmentLocation(shardHash, nodeId) {
    if (!shardHash || !nodeId) return false;
    await publishControlObject("fragment-location", shardHash, { shardHash, nodeId, announcedAt: Date.now() }, 300000);
    return true;
  },
};
