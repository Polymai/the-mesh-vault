import { sendSignal, onSignal } from "./providers/provider-registry.js";
import { attachTransferProtocol } from "./transfer-protocol.js";
import { getPeer, upsertPeer, touchPeer } from "./peer-registry.js";
import { acceptGossipMessage, isForwardable, withDecrementedHop } from "./gossip.js";
import { describePeerMessage, recordDataFlow } from "../observability/data-flow-log.js";

const peers = new Map(); let context = null; let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const externalPeers = new Map();
let unsubscribeSignal = null;
const isAnchorControlMessage = (type) => /^(control-|manifest-|relay-signal$|gossip$)/.test(String(type || ""));

async function transmit(signal) {
  const attempts = await sendSignal(signal);
  if (!attempts.some((attempt) => !attempt.error && attempt.result !== false)) throw new Error("No signaling provider accepted the peer message.");
}

export function configurePeers(config) {
  context = config; iceServers = config.iceServers?.length ? config.iceServers : iceServers;
  unsubscribeSignal?.();
  unsubscribeSignal = onSignal((signal) => {
    if (signal.toNodeId !== context.fromNodeId) return;
    handlePeerSignal(signal).catch(() => context.onState?.(signal.fromNodeId, "failed"));
  });
}
function create(nodeId, polite) {
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
  const peer = { nodeId, peerId: nodeId, pc, makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false, polite, pendingIce: [], channel: null, protocol: null, devicePublicKey: null, createdAt: Date.now(), connectTimer: null };
  peer.connectTimer = setTimeout(() => {
    if (peer.channel?.readyState === "open" || peers.get(nodeId) !== peer) return;
    context.onState?.(nodeId, "timed-out");
    peers.delete(nodeId);
    pc.close();
  }, 25000);
  pc.onicecandidate = ({ candidate }) => candidate && transmit({ fromNodeId: context.fromNodeId, toNodeId: nodeId, type: "ice", payload: candidate.toJSON() }).catch(() => {});
  pc.onconnectionstatechange = () => {
    context.onState?.(nodeId, pc.connectionState);
    if (pc.connectionState === "connected") touchPeer(nodeId);
    if (["failed", "closed"].includes(pc.connectionState)) {
      clearTimeout(peer.connectTimer);
      if (peers.get(nodeId) === peer) peers.delete(nodeId);
    }
  };
  pc.ondatachannel = ({ channel }) => bindChannel(peer, channel);
  pc.onnegotiationneeded = async () => {
    try { peer.makingOffer = true; await pc.setLocalDescription(); await transmit({ fromNodeId: context.fromNodeId, toNodeId: nodeId, type: "offer", payload: pc.localDescription }); }
    catch { context.onState?.(nodeId, "failed"); }
    finally { peer.makingOffer = false; }
  };
  peers.set(nodeId, peer); return peer;
}
function bindChannel(peer, channel) {
  if (peer.channel && peer.channel !== channel && peer.channel.readyState !== "closed") { channel.close(); return; }
  peer.channel = channel;
  channel.onopen = () => { clearTimeout(peer.connectTimer); context.onState?.(peer.nodeId, "connected"); upsertPeer({ peerId: peer.nodeId, devicePublicKey: peer.devicePublicKey, protocolVersion: 3, availableStorageBytes: 0 }); window.setTimeout(() => peer.protocol?.measureRtt?.().catch(() => {}), 100); };
  channel.onclose = () => context.onState?.(peer.nodeId, "disconnected");
  channel.onerror = () => context.onState?.(peer.nodeId, "failed");
  const rawHandlers = context.protocolHandlers || {};
  const protocol = attachTransferProtocol(channel, {
    ...rawHandlers,
    onShard: async (shardHash, bytes, expectedHash) => {
      window.dispatchEvent(new CustomEvent("meshvault:shard-pulse", { detail: { fromNodeId: peer.nodeId, toNodeId: context.fromNodeId, shardHash } }));
      return rawHandlers.onShard?.(shardHash, bytes, expectedHash);
    },
    onRequest: (shardHash, requestId) => context.onFragmentRequest?.(peer, shardHash, requestId),
    onRequestCancel: (requestId) => context.onFragmentRequestCancel?.(peer, requestId),
    onDelete: (shardHash, authorization) => context.onFragmentDelete?.(peer, shardHash, authorization),
    onManifestRequest: (manifestId) => context.onManifestRequest?.(peer, manifestId),
    onManifestReceived: (manifestId, envelope) => context.onManifestReceived?.(peer, manifestId, envelope),
    onControlPut: (object) => context.onControlPut?.(peer, object),
    onControlQuery: (query) => context.onControlQuery?.(peer, query),
    onRelaySignal: (signal) => context.onRelaySignal?.(peer, signal),
    onTraffic: ({ direction, messageType, bytes }) => {
      const info = getPeer(peer.nodeId);
      const isAnchor = (info?.capabilities || []).includes("anchor-control-v3");
      const anchorRoute = isAnchorControlMessage(messageType) && (isAnchor || context.isAnchor?.());
      recordDataFlow({ route: anchorRoute ? "anchor" : "direct", direction, kind: describePeerMessage(messageType), bytes, counterparty: info?.nodeName || (anchorRoute ? "Anchor" : "Mesh peer"), transport: "WebRTC" });
      rawHandlers.onTraffic?.({ direction, messageType, bytes, peerId: peer.nodeId });
    },
    onMetrics: (metrics) => { peer.quality = metrics; window.dispatchEvent(new CustomEvent("meshvault:peer-quality", { detail: { nodeId: peer.nodeId, metrics } })); },
    onGossip: async (message) => {
      const result = await acceptGossipMessage(message, peer.nodeId);
      if (!result.accepted) return;
      context.onGossip?.(peer, message);
      if (isForwardable(message)) {
        const forwarded = withDecrementedHop(message);
        peers.forEach((other) => { if (other !== peer && other.protocol && other.channel?.readyState === "open") other.protocol.sendGossip(forwarded); });
      }
    },
  });
  peer.protocol = {
    ...protocol,
    async sendShard(shardId, bytes, hash, onProgress, options) {
      window.dispatchEvent(new CustomEvent("meshvault:shard-pulse", { detail: { fromNodeId: context.fromNodeId, toNodeId: peer.nodeId, shardHash: shardId } }));
      return protocol.sendShard(shardId, bytes, hash, onProgress, options);
    },
  };
}
export async function connectPeer(nodeId) {
  const existing = peers.get(nodeId);
  if (existing && !["failed", "closed"].includes(existing.pc.connectionState)) return existing;
  if (existing) { existing.pc.close(); peers.delete(nodeId); }
  const peer = create(nodeId, context.fromNodeId > nodeId);
  if (context.fromNodeId < nodeId) bindChannel(peer, peer.pc.createDataChannel("meshvault", { ordered: true }));
  else await transmit({ fromNodeId: context.fromNodeId, toNodeId: nodeId, type: "hello", payload: {} }).catch(() => {});
  return peer;
}
export async function handlePeerSignal(signal) {
  const peer = peers.get(signal.fromNodeId) || create(signal.fromNodeId, context.fromNodeId > signal.fromNodeId);
  const { pc } = peer;
  if (signal.type === "hello") {
    if (context.fromNodeId < signal.fromNodeId && !peer.channel) bindChannel(peer, pc.createDataChannel("meshvault", { ordered: true }));
    return;
  }
  if (signal.type === "ice") {
    if (!pc.remoteDescription) peer.pendingIce.push(signal.payload);
    else await pc.addIceCandidate(signal.payload).catch(() => {});
    return;
  }
  const description = signal.payload;
  const readyForOffer = !peer.makingOffer && (pc.signalingState === "stable" || peer.isSettingRemoteAnswerPending);
  const collision = description.type === "offer" && !readyForOffer;
  peer.ignoreOffer = !peer.polite && collision; if (peer.ignoreOffer) return;
  peer.isSettingRemoteAnswerPending = description.type === "answer";
  await pc.setRemoteDescription(description);
  peer.isSettingRemoteAnswerPending = false;
  for (const candidate of peer.pendingIce.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
  if (description.type === "offer") { await pc.setLocalDescription(); await transmit({ fromNodeId: context.fromNodeId, toNodeId: signal.fromNodeId, type: "answer", payload: pc.localDescription }); }
}
export function registerExternalProtocol(nodeId, protocol, metadata = {}) {
  if (!nodeId || !protocol) return false;
  externalPeers.set(nodeId, { nodeId, peerId: nodeId, protocol, external: true, ...metadata });
  context?.onState?.(nodeId, "connected"); return true;
}
export function unregisterExternalProtocol(nodeId) { return externalPeers.delete(nodeId); }
export function connectedProtocols() {
  const direct = Array.from(peers.values()).filter((peer) => peer.channel?.readyState === "open").map((peer) => ({ nodeId: peer.nodeId, peerId: peer.nodeId, devicePublicKey: peer.devicePublicKey, protocol: peer.protocol, quality: peer.protocol?.metrics?.() || peer.quality || null }));
  return [...direct, ...externalPeers.values()].filter((peer, index, all) => all.findIndex((entry) => entry.nodeId === peer.nodeId) === index);
}
export function connectedProtocol(nodeId) { return connectedProtocols().find((peer) => peer.nodeId === nodeId) || null; }
export function peerDiagnostics() { return Array.from(peers.values()).map((peer) => ({ nodeId: peer.nodeId, connectionState: peer.pc.connectionState, iceConnectionState: peer.pc.iceConnectionState, signalingState: peer.pc.signalingState, channelState: peer.channel?.readyState || "none", quality: peer.protocol?.metrics?.() || peer.quality || null })); }
export async function measureConnectedPeers() { return Promise.all(connectedProtocols().map(async (peer) => ({ nodeId: peer.nodeId, rttMs: await peer.protocol.measureRtt().catch(() => null) }))); }
export function broadcastGossip(message) { peers.forEach((peer) => { if (peer.protocol && peer.channel?.readyState === "open") peer.protocol.sendGossip(message); }); }
export function disconnectPeer(nodeId) {
  const peer = peers.get(nodeId);
  if (!peer) return false;
  clearTimeout(peer.connectTimer);
  peer.channel?.close();
  peer.pc.close();
  peers.delete(nodeId);
  context.onState?.(nodeId, "disconnected");
  return true;
}
export function closePeers() { peers.forEach((peer) => { clearTimeout(peer.connectTimer); peer.pc.close(); }); peers.clear(); externalPeers.clear(); unsubscribeSignal?.(); unsubscribeSignal = null; }
