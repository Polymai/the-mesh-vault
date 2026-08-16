import { canonicalBytes, bytesToBase64Url, base64UrlToBytes, hashHex, importPublicKeyRaw, verify as verifySignature } from "../../security/signing.js";

const PROTOCOL_VERSION = 3;
const sockets = new Map();
const signalListeners = new Set();
const presenceListeners = new Set();
let context = { nodeId: null, signer: null, getPresencePayload: () => null };
const virtualProtocols = new Map();

function seeds() { return window.__DATA__?.backbone?.seeds || []; }
function asSeed(entry) { return typeof entry === "string" ? { url: entry, publicKey: null } : entry; }

async function verifyServerMessage(seed, message) {
  if (!seed.publicKey || !message?.signature || message.serverPublicKey !== seed.publicKey) return false;
  const { signature, ...core } = message;
  try {
    const key = await importPublicKeyRaw(base64UrlToBytes(seed.publicKey), "Ed25519");
    return verifySignature(key, "Ed25519", base64UrlToBytes(signature), canonicalBytes(core));
  } catch { return false; }
}

async function signedHello() {
  const node = context.getPresencePayload?.();
  if (!context.signer?.publicKey || !node?.nodeId) throw new Error("Backbone identity is not ready.");
  const core = {
    type: "hello", protocolVersion: PROTOCOL_VERSION, node,
    clientPublicKey: context.signer.publicKey, algorithm: context.signer.algorithm,
    createdAt: Date.now(), expiresAt: Date.now() + Number(window.__DATA__?.backbone?.leaseMs || 120000),
  };
  return { ...core, signature: bytesToBase64Url(await context.signer.sign(canonicalBytes(core))) };
}

function failPending(state, error) {
  for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
  state.pending.clear();
}

async function connect(seedEntry) {
  const seed = asSeed(seedEntry);
  if (!/^wss:\/\//i.test(seed?.url || "") || !seed.publicKey) throw new Error("Backbone seeds require WSS and a pinned public key.");
  const existing = sockets.get(seed.url);
  if (existing?.verified && existing.socket.readyState === WebSocket.OPEN) return existing;
  if (existing?.connecting) return existing.connecting;
  const state = existing || { seed, socket: null, verified: false, pending: new Map(), connecting: null };
  const connecting = new Promise((resolve, reject) => {
    const socket = new WebSocket(seed.url);
    state.socket = socket; state.verified = false;
    const timeout = window.setTimeout(() => { socket.close(); reject(new Error("Backbone connection timed out.")); }, Number(window.__DATA__?.backbone?.seedConnectTimeoutMs || 5000));
    socket.addEventListener("open", async () => {
      try { socket.send(JSON.stringify(await signedHello())); }
      catch (error) { clearTimeout(timeout); socket.close(); reject(error); }
    });
    socket.addEventListener("message", async (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!state.verified) {
        if (message.type !== "welcome" || !(await verifyServerMessage(seed, message))) {
          clearTimeout(timeout); socket.close(1008, "Unverified seed"); reject(new Error("Backbone seed identity could not be verified.")); return;
        }
        state.verified = true; clearTimeout(timeout); resolve(state); return;
      }
      if (message.type === "signal" && message.payload?.toNodeId === context.nodeId) {
        signalListeners.forEach((listener) => { try { listener(message.payload); } catch {} }); return;
      }
      if (message.type === "presence" && Array.isArray(message.payload)) {
        presenceListeners.forEach((listener) => { try { listener(message.payload); } catch {} }); return;
      }
      const pending = state.pending.get(message.requestId);
      if (!pending) return;
      state.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.ok === false) pending.reject(new Error(message.error || "Backbone request failed."));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => { state.verified = false; failPending(state, new Error("Backbone connection closed.")); });
    socket.addEventListener("error", () => { if (!state.verified) { clearTimeout(timeout); reject(new Error("Backbone connection failed.")); } });
  }).finally(() => { state.connecting = null; });
  state.connecting = connecting; sockets.set(seed.url, state);
  return connecting;
}

async function request(action, payload = {}, { first = false, seedEntries = null } = {}) {
  const results = [];
  for (const seedEntry of (seedEntries || seeds())) {
    try {
      const state = await connect(seedEntry);
      const requestId = crypto.randomUUID();
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { state.pending.delete(requestId); reject(new Error("Backbone request timed out.")); }, Number(window.__DATA__?.backbone?.requestTimeoutMs || 15000));
        state.pending.set(requestId, { resolve, reject, timer });
      });
      state.socket.send(JSON.stringify({ type: "request", requestId, action, payload }));
      const value = await result;
      results.push(value);
      if (first && value) return value;
    } catch {}
  }
  return first ? null : results;
}

export function configureBackboneSeedProvider({ nodeId, signer, getPresencePayload } = {}) {
  context = { nodeId, signer, getPresencePayload: typeof getPresencePayload === "function" ? getPresencePayload : () => null };
}

function storageProtocol(instance) {
  const existing = virtualProtocols.get(instance.nodeId);
  if (existing) return existing;
  const metrics = { successfulTransfers: 0, failedTransfers: 0, successfulProofs: 0, failedProofs: 0, rttEwmaMs: null, throughputEwmaBps: null };
  const instanceSeeds = instance.backboneUrl && instance.backbonePublicKey
    ? [{ url: instance.backboneUrl, publicKey: instance.backbonePublicKey }]
    : null;
  const instanceRequest = (action, payload = {}, options = {}) => request(action, payload, { ...options, seedEntries: instanceSeeds });
  const protocol = {
    async sendShard(shardId, bytes, expectedHash, onProgress = () => {}, { signal } = {}) {
      const payload = new Uint8Array(bytes); const transferId = crypto.randomUUID(); const startedAt = performance.now();
      if (signal?.aborted) throw signal.reason || new DOMException("Shard transfer cancelled", "AbortError");
      const started = await instanceRequest("shard-start", { instanceId: instance.nodeId, transferId, shardHash: shardId, expectedHash, expectedSize: payload.byteLength }, { first: true });
      if (!started) throw new Error("Backbone storage reservation was rejected.");
      try {
        const packetBytes = Math.min(65536, Math.max(16384, Number(window.__DATA__?.transport?.packetBytes || 32768)));
        for (let offset = 0; offset < payload.byteLength; offset += packetBytes) {
          if (signal?.aborted) throw signal.reason || new DOMException("Shard transfer cancelled", "AbortError");
          const chunk = payload.subarray(offset, Math.min(payload.byteLength, offset + packetBytes));
          const accepted = await instanceRequest("shard-chunk", { transferId, data: bytesToBase64Url(chunk) }, { first: true });
          if (!accepted) throw new Error("Backbone storage rejected a shard packet.");
          onProgress(Math.min(1, (offset + chunk.byteLength) / payload.byteLength));
        }
        if (!(await instanceRequest("shard-finish", { transferId }, { first: true }))) throw new Error("Backbone storage verification failed.");
        const seconds = Math.max(.001, (performance.now() - startedAt) / 1000); metrics.successfulTransfers += 1; metrics.throughputEwmaBps = payload.byteLength / seconds;
        return transferId;
      } catch (error) {
        metrics.failedTransfers += 1; await instanceRequest("shard-abort", { transferId }, { first: true }).catch(() => {}); throw error;
      }
    },
    requestShard(shardId) {
      const requestId = crypto.randomUUID();
      (async () => {
        const info = await instanceRequest("shard-info", { instanceId: instance.nodeId, shardHash: shardId }, { first: true });
        if (!info?.size || info.size > 4 * 1024 * 1024) return;
        const chunks = []; let received = 0;
        while (received < info.size) {
          const result = await instanceRequest("shard-read", { instanceId: instance.nodeId, shardHash: shardId, offset: received, length: Math.min(65536, info.size - received) }, { first: true });
          if (!result?.data) return;
          const chunk = base64UrlToBytes(result.data); chunks.push(chunk); received += chunk.byteLength;
        }
        const bytes = new Uint8Array(received); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        if ((await hashHex(bytes)) !== shardId) return;
        window.dispatchEvent(new CustomEvent("meshvault:backbone-shard", { detail: { requestId, fromNodeId: instance.nodeId, shardHash: shardId, bytes } }));
      })().catch(() => {});
      return requestId;
    },
    cancelShardRequest() { return true; },
    async requestDelete(shardId, authorization) { return !!(await instanceRequest("shard-delete", { instanceId: instance.nodeId, shardHash: shardId, authorization }, { first: true })); },
    async requestProof(shardId, expectedHash) {
      const info = await instanceRequest("shard-info", { instanceId: instance.nodeId, shardHash: shardId }, { first: true });
      const ok = !!info && info.hash === expectedHash && info.size > 0; metrics[ok ? "successfulProofs" : "failedProofs"] += 1; return ok;
    },
    async sendManifest(manifestId, envelope) { return !!(await instanceRequest("manifest-put", { envelope: { ...envelope, manifestId } }, { first: true })); },
    async requestManifest(manifestId) { return instanceRequest("manifest-get", { manifestId }, { first: true }); },
    async sendControlObject(object) { return !!(await instanceRequest("control-put", { object }, { first: true })); },
    async queryControlObjects(kind, lookupKey, limit = 20) { return (await instanceRequest("control-query", { kind, lookupKey, limit }, { first: true })) || []; },
    sendRelayedSignal(signal) { instanceRequest("signal", signal, { first: true }).catch(() => {}); return true; },
    sendGossip() { return false; },
    async measureRtt() { const started = performance.now(); const ok = await instanceRequest("ping", {}, { first: true }); metrics.rttEwmaMs = ok ? performance.now() - started : null; return metrics.rttEwmaMs; },
    metrics() { return { ...metrics }; },
  };
  virtualProtocols.set(instance.nodeId, protocol); return protocol;
}

export function backboneStorageProtocol(instance) {
  return instance?.capabilities?.includes("backbone-storage-v3") ? storageProtocol(instance) : null;
}

export async function disconnectBackboneSeeds() {
  for (const state of sockets.values()) state.socket?.close?.(1000, "Node stopped");
  sockets.clear();
  virtualProtocols.clear();
}

export function backboneSeedStatus() {
  const entries = [...sockets.values()];
  return { configured: seeds().length, connected: entries.filter((entry) => entry.verified && entry.socket?.readyState === WebSocket.OPEN).length };
}

export const backboneSeedProvider = {
  name: "backbone-seed",
  async discoverPeers() { return (await request("discover")).flat().filter((peer) => peer?.protocolVersion === 3).map((peer) => ({ ...peer, peerId: peer.nodeId, source: "backbone-seed" })); },
  async publishPresence() {
    const value = context.getPresencePayload?.();
    if (!value) return [];
    await request("presence", value);
    presenceListeners.forEach((listener) => { try { listener([value]); } catch {} });
    return [value];
  },
  onPresence(handler) { presenceListeners.add(handler); return () => presenceListeners.delete(handler); },
  async sendSignal(signal) { return !!(await request("signal", signal, { first: true })); },
  onSignal(handler) { signalListeners.add(handler); return () => signalListeners.delete(handler); },
  async lookupManifest(manifestId) { return request("manifest-get", { manifestId }, { first: true }); },
  async announceManifest(envelope) { return !!(await request("manifest-put", { envelope }, { first: true })); },
  async lookupFragmentLocations(shardHash) { return (await request("fragment-get", { shardHash })).flat(); },
  async announceFragmentLocation(shardHash, nodeId) { return !!(await request("fragment-put", { shardHash, nodeId }, { first: true })); },
};
