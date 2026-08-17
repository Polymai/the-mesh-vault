import { sendSignal, onSignal } from "./providers/provider-registry.js";
import { attachTransferProtocol } from "./transfer-protocol.js";
import { getPeer, upsertPeer, touchPeer } from "./peer-registry.js";
import { acceptGossipMessage, isForwardable, withDecrementedHop } from "./gossip.js";
import { describePeerMessage, recordDataFlow } from "../observability/data-flow-log.js";

const peers = new Map(); let context = null; let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const externalPeers = new Map();
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
const signalQueues = new Map();
const seenSignals = new Set();
const preferredInitiators = new Set();
let unsubscribeSignal = null;
const isAnchorControlMessage = (type) => /^(control-|manifest-|relay-signal$|gossip$)/.test(String(type || ""));
const MAX_FAST_RECONNECTS = 2;
const RECONNECT_COOLDOWN_MS = 300000;
const ICE_BATCH_MS = 250;
// Supabase Realtime is used only as the addressed cold-start mailbox. A
// broadcast sent just before the recipient has subscribed is not retained, so
// repeat the already-created handshake a few times instead of polling for the
// peer again. This is bounded per peer and stops as soon as the DataChannel is
// usable.
const HANDSHAKE_RETRY_DELAYS_MS = [1500, 4000, 9000];

function reportPeerError(peer, phase, error) {
  const message = String(error?.message || error || "Peer connection failed.").slice(0, 240);
  if (peer) peer.lastError = { phase, message, at: Date.now() };
  context?.onState?.(peer?.nodeId || null, "failed");
  window.dispatchEvent(new CustomEvent("meshvault:peer-diagnostic", {
    detail: { nodeId: peer?.nodeId || null, phase, message },
  }));
}

function enqueuePeerSignal(signal) {
  const nodeId = signal?.fromNodeId;
  if (!nodeId) return Promise.resolve();
  const previous = signalQueues.get(nodeId) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => handlePeerSignal(signal));
  signalQueues.set(nodeId, operation);
  operation.catch((error) => reportPeerError(peers.get(nodeId), `signal:${signal?.type || "unknown"}`, error))
    .finally(() => { if (signalQueues.get(nodeId) === operation) signalQueues.delete(nodeId); });
  return operation;
}

function emitState(peer, status) {
  if (!peer || peer.lastReportedState === status) return;
  peer.lastReportedState = status;
  context?.onState?.(peer.nodeId, status);
}

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

function clearHandshakeRetries(peer) {
  for (const timer of peer?.handshakeTimers || []) clearTimeout(timer);
  if (peer) peer.handshakeTimers = [];
}

async function repeatHandshake(peer) {
  if (!peer || peers.get(peer.nodeId) !== peer || peer.manualClose || peer.channel?.readyState === "open") return;
  const { pc, nodeId } = peer;
  // The lexicographically smaller node owns the negotiated DataChannel. Once
  // it has an offer, resend that same offer; the other side will answer it
  // again. The larger node repeats hello until the owner has seen it.
  if (peer.initiator || context.fromNodeId < nodeId) {
    if (!pc.localDescription) await ensureOffer(peer);
    if (pc.localDescription?.type === "offer") {
      await transmit({ fromNodeId: context.fromNodeId, toNodeId: nodeId, type: "offer", payload: pc.localDescription });
    }
  } else if (!peer.channel) {
    await transmit({ fromNodeId: context.fromNodeId, toNodeId: nodeId, type: "hello", payload: {} });
  }
  // ICE broadcasts are also ephemeral. Replaying the small candidate set lets
  // a late subscriber finish the same handshake without a new discovery read.
  if (peer.localIceHistory.length) {
    await transmit({ fromNodeId: context.fromNodeId, toNodeId: nodeId, type: "ice", payload: { candidates: peer.localIceHistory.slice() } });
  }
}

function scheduleHandshakeRetries(peer) {
  if (!peer || peer.handshakeTimers.length) return;
  peer.handshakeTimers = HANDSHAKE_RETRY_DELAYS_MS.map((delay) => setTimeout(() => {
    repeatHandshake(peer).catch((error) => reportPeerError(peer, "handshake-retry", error));
  }, delay));
}

function scheduleReconnect(nodeId) {
  if (!context?.fromNodeId || !nodeId || reconnectTimers.has(nodeId)) return;
  const attempt = Number(reconnectAttempts.get(nodeId) || 0);
  if (attempt >= MAX_FAST_RECONNECTS) {
    reconnectTimers.set(nodeId, setTimeout(() => {
      reconnectTimers.delete(nodeId);
      reconnectAttempts.set(nodeId, 0);
      connectPeer(nodeId, { forceOffer: preferredInitiators.has(nodeId) }).catch(() => scheduleReconnect(nodeId));
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
    connectPeer(nodeId, { forceOffer: preferredInitiators.has(nodeId) }).catch(() => scheduleReconnect(nodeId));
  }, delay));
}

async function ensureOffer(peer) {
  if (!peer || peers.get(peer.nodeId) !== peer || peer.manualClose || peer.channel?.readyState === "open") return false;
  if (peer.negotiationPromise) return peer.negotiationPromise;
  const operation = (async () => {
    const { pc, nodeId } = peer;
    // Only the deterministic channel owner creates offers. This keeps a hub
    // with many simultaneous cold-start clients from entering glare on every
    // connection while still allowing each peer to negotiate independently.
    if ((!peer.initiator && context.fromNodeId >= nodeId) || pc.signalingState !== "stable") return false;
    peer.makingOffer = true;
    const offer = await pc.createOffer();
    if (pc.signalingState !== "stable") return false;
    await pc.setLocalDescription(offer);
    await transmit({ fromNodeId: context.fromNodeId, toNodeId: nodeId, type: "offer", payload: pc.localDescription });
    return true;
  })();
  peer.negotiationPromise = operation;
  try { return await operation; }
  catch (error) { reportPeerError(peer, "create-offer", error); return false; }
  finally {
    peer.makingOffer = false;
    if (peer.negotiationPromise === operation) peer.negotiationPromise = null;
  }
}

export function configurePeers(config) {
  context = config; iceServers = config.iceServers?.length ? config.iceServers : iceServers;
  unsubscribeSignal?.();
  unsubscribeSignal = onSignal((signal) => {
    if (signal.toNodeId !== context.fromNodeId) return;
    if (!rememberSignal(signal.signalId)) return;
    enqueuePeerSignal(signal);
  });
}
export function updatePeerIceServers(nextIceServers = []) {
  if (!Array.isArray(nextIceServers) || !nextIceServers.length) return false;
  iceServers = nextIceServers;
  return true;
}
function create(nodeId, polite, { initiator = false } = {}) {
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 1 });
  const peer = { nodeId, peerId: nodeId, pc, makingOffer: false, negotiationPromise: null, ignoreOffer: false, isSettingRemoteAnswerPending: false, polite, initiator, pendingIce: [], pendingLocalIce: [], localIceHistory: [], iceBatchTimer: null, handshakeTimers: [], channel: null, protocol: null, devicePublicKey: null, createdAt: Date.now(), connectTimer: null, manualClose: false, lastReportedState: null, lastError: null };
  peer.connectTimer = setTimeout(() => {
    if (peer.channel?.readyState === "open" || peers.get(nodeId) !== peer) return;
    clearHandshakeRetries(peer);
    clearTimeout(peer.iceBatchTimer); peer.iceBatchTimer = null; peer.pendingLocalIce.length = 0;
    emitState(peer, "timed-out");
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
    const value = candidate.toJSON();
    peer.pendingLocalIce.push(value);
    peer.localIceHistory.push(value);
    if (peer.localIceHistory.length > 64) peer.localIceHistory.splice(0, peer.localIceHistory.length - 64);
    if (!peer.iceBatchTimer) peer.iceBatchTimer = setTimeout(flushIce, ICE_BATCH_MS);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") touchPeer(nodeId);
    // A connected ICE transport is not yet an application connection. Only
    // the DataChannel open event below may announce a usable mesh peer.
    if (!["connected", "new"].includes(pc.connectionState)) emitState(peer, pc.connectionState);
    if (["failed", "closed"].includes(pc.connectionState)) {
      clearHandshakeRetries(peer);
      clearTimeout(peer.connectTimer);
      clearTimeout(peer.iceBatchTimer); peer.iceBatchTimer = null; peer.pendingLocalIce.length = 0;
      if (peers.get(nodeId) === peer) peers.delete(nodeId);
      if (!peer.manualClose) scheduleReconnect(nodeId);
    }
  };
  pc.ondatachannel = ({ channel }) => bindChannel(peer, channel);
  pc.onnegotiationneeded = () => { ensureOffer(peer); };
  peers.set(nodeId, peer); return peer;
}
function bindChannel(peer, channel) {
  if (peer.channel && peer.channel !== channel && peer.channel.readyState !== "closed") { channel.close(); return; }
  peer.channel = channel;
  channel.onopen = () => {
    clearTimeout(peer.connectTimer);
    clearHandshakeRetries(peer);
    clearReconnect(peer.nodeId, { reset: true });
    // Do not overwrite capacity learned during discovery with a synthetic 0.
    upsertPeer({ peerId: peer.nodeId, devicePublicKey: peer.devicePublicKey, protocolVersion: 3 });
    emitState(peer, "connected");
    Promise.resolve(context.onProtocolConnected?.(peer))
      .catch((error) => reportPeerError(peer, "protocol-connected", error));
    window.setTimeout(() => peer.protocol?.measureRtt?.().catch(() => {}), 100);
  };
  channel.onclose = () => { emitState(peer, "disconnected"); if (!peer.manualClose) scheduleReconnect(peer.nodeId); };
  channel.onerror = (error) => { reportPeerError(peer, "data-channel", error); if (!peer.manualClose) scheduleReconnect(peer.nodeId); };
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
export async function connectPeer(nodeId, { forceOffer = false } = {}) {
  // A scheduled reconnect is also a traffic budget. Periodic discovery must not
  // cancel the cooldown and immediately reopen Supabase signaling for a peer
  // that has already failed repeatedly.
  if (reconnectTimers.has(nodeId)) return peers.get(nodeId) || null;
  clearReconnect(nodeId);
  if (forceOffer) preferredInitiators.add(nodeId);
  const existing = peers.get(nodeId);
  if (existing && !["failed", "closed", "disconnected"].includes(existing.pc.connectionState)) {
    if (forceOffer && !existing.channel) {
      existing.initiator = true;
      bindChannel(existing, existing.pc.createDataChannel("meshvault", { ordered: true }));
      await ensureOffer(existing);
      scheduleHandshakeRetries(existing);
    }
    return existing;
  }
  if (existing) { existing.manualClose = true; existing.pc.close(); peers.delete(nodeId); }
  const peer = create(nodeId, context.fromNodeId > nodeId, { initiator: forceOffer });
  if (forceOffer || context.fromNodeId < nodeId) {
    bindChannel(peer, peer.pc.createDataChannel("meshvault", { ordered: true }));
    await ensureOffer(peer);
  }
  else await transmit({ fromNodeId: context.fromNodeId, toNodeId: nodeId, type: "hello", payload: {} }).catch(() => {});
  scheduleHandshakeRetries(peer);
  return peer;
}
export async function handlePeerSignal(signal) {
  const peer = peers.get(signal.fromNodeId) || create(signal.fromNodeId, context.fromNodeId > signal.fromNodeId);
  scheduleHandshakeRetries(peer);
  const { pc } = peer;
  if (signal.type === "hello") {
    if (context.fromNodeId < signal.fromNodeId && !peer.channel) {
      bindChannel(peer, pc.createDataChannel("meshvault", { ordered: true }));
      await ensureOffer(peer);
    }
    return;
  }
  if (signal.type === "ice") {
    const candidates = Array.isArray(signal.payload?.candidates) ? signal.payload.candidates : [signal.payload];
    if (!pc.remoteDescription) peer.pendingIce.push(...candidates.filter(Boolean));
    else for (const candidate of candidates) if (candidate) await pc.addIceCandidate(candidate).catch(() => {});
    return;
  }
  const description = signal.payload;
  if (!description?.type || !["offer", "answer"].includes(description.type)) return;
  // A late answer from an abandoned attempt must not poison the replacement
  // connection. A fresh offer or reconnect will establish the current route.
  if (description.type === "answer" && pc.signalingState !== "have-local-offer") return;
  const readyForOffer = !peer.makingOffer && (pc.signalingState === "stable" || peer.isSettingRemoteAnswerPending);
  const collision = description.type === "offer" && !readyForOffer;
  peer.ignoreOffer = !peer.polite && collision; if (peer.ignoreOffer) return;
  peer.isSettingRemoteAnswerPending = description.type === "answer";
  try {
    if (collision && peer.polite && pc.signalingState !== "stable") {
      await pc.setLocalDescription({ type: "rollback" });
    }
    await pc.setRemoteDescription(description);
  } finally {
    peer.isSettingRemoteAnswerPending = false;
  }
  for (const candidate of peer.pendingIce.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
  if (description.type === "offer") {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await transmit({ fromNodeId: context.fromNodeId, toNodeId: signal.fromNodeId, type: "answer", payload: pc.localDescription });
  }
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
export function peerDiagnostics() { return Array.from(peers.values()).map((peer) => ({ nodeId: peer.nodeId, connectionState: peer.pc.connectionState, iceConnectionState: peer.pc.iceConnectionState, signalingState: peer.pc.signalingState, channelState: peer.channel?.readyState || "none", lastError: peer.lastError || null, quality: peer.protocol?.metrics?.() || peer.quality || null })); }
export async function measureConnectedPeers() { return Promise.all(connectedProtocols().map(async (peer) => ({ nodeId: peer.nodeId, rttMs: await peer.protocol.measureRtt().catch(() => null) }))); }
export function broadcastGossip(message) { peers.forEach((peer) => { if (peer.protocol && peer.channel?.readyState === "open") peer.protocol.sendGossip(message); }); }
export function disconnectPeer(nodeId) {
  preferredInitiators.delete(nodeId);
  clearReconnect(nodeId, { reset: true });
  const peer = peers.get(nodeId);
  if (!peer) return false;
  clearTimeout(peer.connectTimer);
  clearTimeout(peer.iceBatchTimer);
  clearHandshakeRetries(peer);
  peer.manualClose = true;
  peer.channel?.close();
  peer.pc.close();
  peers.delete(nodeId);
  context.onState?.(nodeId, "disconnected");
  return true;
}
export function closePeers() { reconnectTimers.forEach((timer) => clearTimeout(timer)); reconnectTimers.clear(); reconnectAttempts.clear(); signalQueues.clear(); seenSignals.clear(); preferredInitiators.clear(); peers.forEach((peer) => { clearTimeout(peer.connectTimer); clearTimeout(peer.iceBatchTimer); clearHandshakeRetries(peer); peer.manualClose = true; peer.pc.close(); }); peers.clear(); externalPeers.clear(); unsubscribeSignal?.(); unsubscribeSignal = null; }
