import { listKnownPeers } from "../peer-registry.js";

const presenceListeners = new Set();

export const localPeerBootstrapProvider = {
  name: "local-peer",
  async discoverPeers() {
    return listKnownPeers().map((peer) => ({ ...peer, peerId: peer.peerId, source: "local-peer" }));
  },
  async publishPresence() {
    const entries = listKnownPeers().map((peer) => ({ ...peer, nodeId: peer.peerId }));
    presenceListeners.forEach((listener) => { try { listener(entries); } catch {} });
    return entries;
  },
  onPresence(handler) { presenceListeners.add(handler); return () => presenceListeners.delete(handler); },
};
