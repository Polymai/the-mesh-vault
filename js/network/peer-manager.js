import { sendSignal, onSignal } from "./providers/provider-registry.js";
import { attachTransferProtocol } from "./transfer-protocol.js";
import { getPeer, upsertPeer, touchPeer } from "./peer-registry.js";
import { acceptGossipMessage, isForwardable, withDecrementedHop } from "./gossip.js";
import { describePeerMessage, recordDataFlow } from "../observability/data-flow-log.js";

const peers = new Map(); let context = null; let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const externalPeers = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const seenSignals = new Set();
let unsubscribeSignal = null;
const isAnchorControlMessage = (type) => /^(control-|manifest-|relay-signal$|gossip$)/.test(String(type || ""));
const MAX_FAST_RECONNECTS = 2;
const RECONNECT_COOLDOWN_MS = 300000;
const ICE_BATCH_MS = 250;

async function transmit(signal) {
  const attempts = await sendSignal({ ...signal, signalId: signal.signalId || crypto.randomUUID() });
  if (!attempts.some((attempt) => !attempt.error && attempt.result !== false)) throw new Error("No signaling provider accepted the peer message.");
}

function rememberSignal(signalId) {
  if (!signalId) return true;
  if (seenSignals.has(signalId)) return false;
  seenSignals.add(signalId);
  if (seenSignals.size > 1024) seenSignals.delete(seenSignals.values().next().value);
  return true;
}

function clearReconnect(nodeId, { reset = false } = {}) {
  const timer = reconnectTimers.get(nodeId);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(nodeId);
  if (reset) reconnectAttempts.delete(nodeId);
}

function scheduleReconnect(nodeId) {
  if (!context?.fromNodeId || !nodeId || reconnectTimers.has(nodeId)) return;
  const attempt = Number(reconnectAttempts.get(nodeId) || 0);
  if (attempt >= MAX_FAST_RECONNECTS) {
    reconnectTimers.set(nodeId, setTimeout(() => {
      reconnectTimers.delete(nodeId);
      reconnectAttempts.set(nodeId, 0);
      connectPeer(nodeId).catch(() => scheduleReconnect(nodeId));
    }, RECONNECT_COOLDOWN_MS));
    return;
  }
  const delay = Math.min(30000, 2000 * (2 ** attempt)) + Math.round(Math.random() * 750);
  reconnectAttempts.set(nodeId, attempt + 1);
  reconnectTimers.set(nodeId, setTimeout(() => {
    reconnectTimers.delete(nodeId);
    const stale = peers.get(nodeId);
    if (stale?.channel?.readyState === "open") { reconnectAttempts.delete(nodeId); return; }
    if (stale) {
      clearTimeout(stale.connectTimer);
      stale.manualClose = true;
      stale.pc.close();
      peers.delete(nodeId);
    }
    connectPeer(nodeId).catch(() => scheduleReconnect(nodeId));
  }, delay));
}

export function configurePeers(config) {
  context = config; iceServers = config.iceServers?.length ? config.iceServers : iceServers;
  unsubscribeSignal?.();
  unsubscribeSignal = onSignal((signal) => {
    if (signal.toNodeId !== context.fromNodeId) return;
    if (!rememberSignal(signal.signalId)) return;
    handlePeerSignal(signal).catch(() => context.onState?.(signal.fromNodeId, "failed"));
  });
}
function create(nodeId, polite) {
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 1 });
  const peer = { nodeId, peerId: nodeId, pc, makingOffer: false, ignoreOffer: false, isSettingRemoteAnswerPending: false, polite, pendingIce: [], pendingLocalIce: [], iceBatchTimer: null, channel: null, protocol: null, devicePublicKey: null, createdAt: Date.now(), connectTimer: null, manualClose: false };
  peer.connectTimer = setTimeout(() => {
    if (peer.channel?.readyState === "open" || peers.get(nodeId) !== peer) return;
    clearTimeout(peer.iceBatchTimer); peer.iceBatchTimer = null; peer.pendingLocalIce.length = 0;
    context.onState?.(nodeId, "timed-out");
    peers.delete(nodeId);
    pc.close();
    scheduleReconnect(nodeId);
  }, 25000);
  const flushIce = () => {
    clearTimeout(peer.iceBatchTimer); peer.iceBatchTimer = null;
    const candidates = peer.pendingLocalIce.splice(0);
    if (candidates.length) transmit({ fromNodeId: context.fromNodeId, toNodeId: nodeId, type: "ice", payload: { candidates } }).catch(() => {});
  };
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) { flushIce(); return; }
    peer.pendingLocalIce.push(candidate.toJSON());
    if (!peer.iceBatchTimer) peer.iceBatchTimer = setTimeout(flushIce, ICE_BATCH_MS);
  };
  pc.onconnectionstatechange = () => {
    context.onState?.(nodeId, pc.connectionState);
    if (pc.connectionState === "connected") touchPeer(nodeId);
    if (["failed", "closed"].includes(pc.connectionState)) {
      clearTimeout(peer.connectTimer);
      clearTimeout(peer.iceBatchTimer); peer.iceBatchTimer = null; peer.pendingLocalIce.length = 0;
      if (peers.get(nodeId) === peer) peers.delete(nodeId);
      if (!peer.manualClose) scheduleReconnect(nodeId);
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
  channel.onopen = () => { clearTimeout(peer.connectTimer); clearReconnect(peer.nodeId, { reset: true }); context.onState?.(peer.nodeId, "connected"); upsertPeer({ peerId: peer.nodeId, devicePublicKey: peer.devicePublicKey, protocolVersion: 3, availableStorageBytes: 0 }); window.setTimeout(() => peer.protocol?.measureRtt?.().catch(() => {}), 100); };
  channel.onclose = () => { context.onState?.(peer.nodeId, "disconnected"); if (!peer.manualClose) scheduleReconnect(peer.nodeId); };
  channel.onerror = () => { context.onState?.(peer.nodeId, "failed"); if (!peer.manualClose) scheduleReconnect(peer.nodeId); };
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
  // A scheduled reconnect is also a traffic budget. Periodic discovery must not
  // cancel the cooldown and immediately reopen Supabase signaling for a peer
  // that has already failed repeatedly.
  if (reconnectTimers.has(nodeId)) return peers.get(nodeId) || null;
  clearReconnect(nodeId);
  const existing = peers.get(nodeId);
  if (existing && !["failed", "closed", "disconnected"].includes(existing.pc.connectionState)) return existing;
  if (existing) { existing.manualClose = true; existing.pc.close(); peers.delete(nodeId); }
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
    const candidates = Array.isArray(signal.payload?.candidates) ? signal.payload.candidates : [signal.payload];
    if (!pc.remoteDescription) peer.pendingIce.push(...candidates.filter(Boolean));
    else for (const candidate of candidates) if (candidate) await pc.addIceCandidate(candidate).catch(() => {});
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
  clearReconnect(nodeId, { reset: true });
  const peer = peers.get(nodeId);
  if (!peer) return false;
  clearTimeout(peer.connectTimer);
  clearTimeout(peer.iceBatchTimer);
  peer.manualClose = true;
  peer.channel?.close();
  peer.pc.close();
  peers.delete(nodeId);
  context.onState?.(nodeId, "disconnected");
  return true;
}
export function closePeers() { reconnectTimers.forEach((timer) => clearTimeout(timer)); reconnectTimers.clear(); reconnectAttempts.clear(); seenSignals.clear(); peers.forEach((peer) => { clearTimeout(peer.connectTimer); clearTimeout(peer.iceBatchTimer); peer.manualClose = true; peer.pc.close(); }); peers.clear(); externalPeers.clear(); unsubscribeSignal?.(); unsubscribeSignal = null; }
