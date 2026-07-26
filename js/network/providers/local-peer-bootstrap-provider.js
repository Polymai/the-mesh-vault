import { listKnownPeers } from "../peer-registry.js";

const presenceListeners = new Set();

export const localPeerBootstrapProvider = {
  name: "local-peer",
  async discoverPeers() {
    return listKnownPeers().map((peer) => ({ peerId: peer.peerId, nodeName: peer.nodeName, devicePublicKey: peer.devicePublicKey, protocolVersion: peer.protocolVersion, capacityBytes: peer.capacityBytes, usedBytes: peer.usedBytes, source: "local-peer" }));
  },
  async publishPresence() {
    const entries = listKnownPeers().map((peer) => ({ nodeId: peer.peerId, nodeName: peer.nodeName, devicePublicKey: peer.devicePublicKey, capacityBytes: peer.capacityBytes, usedBytes: peer.usedBytes }));
    presenceListeners.forEach((listener) => { try { listener(entries); } catch {} });
    return entries;
  },
  onPresence(handler) { presenceListeners.add(handler); return () => presenceListeners.delete(handler); },
};
