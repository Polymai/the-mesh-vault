import { listKnownPeers } from "../peer-registry.js";

const presenceListeners = new Set();

export const localPeerBootstrapProvider = {
  name: "local-peer",
  async discoverPeers() {
    return listKnownPeers().map((peer) => ({ peerId: peer.peerId, devicePublicKey: peer.devicePublicKey, protocolVersion: peer.protocolVersion, source: "local-peer" }));
  },
  async publishPresence() {
    const entries = listKnownPeers().map((peer) => ({ nodeId: peer.peerId, devicePublicKey: peer.devicePublicKey, capacityBytes: peer.availableStorageBytes }));
    presenceListeners.forEach((listener) => { try { listener(entries); } catch {} });
    return entries;
  },
  onPresence(handler) { presenceListeners.add(handler); return () => presenceListeners.delete(handler); },
};
