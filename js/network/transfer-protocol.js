import { hashBytes } from "../security/keyring.js";

const MAX_MESSAGE = 64 * 1024;
const PACKET_BYTES = 32 * 1024;
const BUFFER_LIMIT = 1024 * 1024;
const STORED_TIMEOUT_MS = 45000;
const MAX_PROOF_BYTES = 16 * 1024 * 1024;
const MAX_PROOF_CHUNKS = Math.ceil(MAX_PROOF_BYTES / PACKET_BYTES);
const PING_TIMEOUT_MS = 4000;
const MANIFEST_TIMEOUT_MS = 4000;
const CONTROL_TIMEOUT_MS = 6000;
const MAX_CONTROL_OBJECT_BYTES = 48 * 1024;

export function attachTransferProtocol(channel, handlers = {}) {
  const incoming = new Map(); const pendingStored = new Map(); const pendingDeletes = new Map(); const incomingManifests = new Map(); const pendingManifests = new Map(); const pendingManifestStored = new Map(); const incomingProofs = new Map(); const pendingProofs = new Map(); const pendingPings = new Map(); const pendingControlStored = new Map(); const pendingControlQueries = new Map(); channel.binaryType = "arraybuffer";
  const quality = { rttEwmaMs: null, throughputEwmaBps: null, successfulTransfers: 0, failedTransfers: 0, successfulProofs: 0, failedProofs: 0, updatedAt: null };
  const send = (message) => {
    const encoded = JSON.stringify(message);
    if (encoded.length > MAX_MESSAGE) throw new Error("Peer message exceeds the transport limit.");
    if (channel.readyState !== "open") return false;
    try { channel.send(encoded); return true; }
    catch (error) {
      if (channel.readyState !== "open" || error?.name === "InvalidStateError") return false;
      throw error;
    }
  };
  const ewma = (previous, next, alpha = 0.25) => previous == null ? next : previous * (1 - alpha) + next * alpha;
  const reportQuality = (patch = {}) => { Object.assign(quality, patch, { updatedAt: Date.now() }); handlers.onMetrics?.({ ...quality }); };
  async function sendManifestBytes(manifestId, envelope, transferId = crypto.randomUUID()) {
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const base64 = btoa(String.fromCharCode(...bytes));
    const chunks = Math.max(1, Math.ceil(base64.length / PACKET_BYTES));
    send({ type: "manifest-start", transferId, manifestId, chunks });
    for (let index = 0; index < chunks; index++) { while (channel.bufferedAmount > BUFFER_LIMIT) await new Promise((resolve) => setTimeout(resolve, 20)); send({ type: "manifest-chunk", transferId, index, data: base64.slice(index * PACKET_BYTES, (index + 1) * PACKET_BYTES) }); }
    send({ type: "manifest-end", transferId });
    return transferId;
  }
  async function sendProofBytes(requestId, shardId, bytes) {
    const data = new Uint8Array(bytes); const hash = await hashBytes(data); const chunks = Math.max(1, Math.ceil(data.byteLength / PACKET_BYTES));
    if (data.byteLength > MAX_PROOF_BYTES || chunks > MAX_PROOF_CHUNKS) throw new Error("Shard proof exceeds the bounded proof size.");
    send({ type: "proof-start", requestId, shardId, hash, size: data.byteLength, chunks });
    for (let index = 0; index < chunks; index++) {
      while (channel.bufferedAmount > BUFFER_LIMIT) await new Promise((resolve) => setTimeout(resolve, 20));
      const packet = data.slice(index * PACKET_BYTES, (index + 1) * PACKET_BYTES);
      send({ type: "proof-chunk", requestId, index, data: btoa(String.fromCharCode(...packet)) });
    }
    send({ type: "proof-end", requestId });
  }
  channel.addEventListener("message", async ({ data }) => {
    let message; try { message = typeof data === "string" ? JSON.parse(data) : null; } catch { return; }
    if (!message || data.length > MAX_MESSAGE || !message.type) return;
    if (message.type === "ping") send({ type: "pong", pingId: message.pingId });
    if (message.type === "pong") { const pending = pendingPings.get(message.pingId); if (pending) { pendingPings.delete(message.pingId); clearTimeout(pending.timer); pending.resolve(performance.now() - pending.startedAt); } }
    if (message.type === "shard-start") incoming.set(message.transferId, { id: message.shardId, chunks: new Array(message.chunks), hash: message.hash });
    if (message.type === "shard-chunk") { const item = incoming.get(message.transferId); if (item && Number.isInteger(message.index) && message.index >= 0 && message.index < item.chunks.length) item.chunks[message.index] = Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0)); }
    if (message.type === "shard-abort") incoming.delete(message.transferId);
    if (message.type === "shard-end") {
      const item = incoming.get(message.transferId); if (!item || item.chunks.some((chunk) => !chunk)) return;
      const size = item.chunks.reduce((sum, chunk) => sum + chunk.length, 0); const bytes = new Uint8Array(size); let offset = 0;
      item.chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.length; }); incoming.delete(message.transferId);
      try { if (await hashBytes(bytes) !== item.hash) throw new Error("Shard integrity verification failed."); await handlers.onShard?.(item.id, bytes, item.hash); send({ type: "shard-stored", transferId: message.transferId, ok: true }); }
      catch (error) { handlers.onError?.(error); send({ type: "shard-stored", transferId: message.transferId, ok: false, error: error.message }); }
    }
    if (message.type === "shard-stored") { const pending = pendingStored.get(message.transferId); if (pending) { pendingStored.delete(message.transferId); clearTimeout(pending.timer); message.ok ? pending.resolve(true) : pending.reject(new Error(message.error || "The peer did not store the shard.")); } }
    if (message.type === "shard-request") handlers.onRequest?.(message.shardId, message.requestId);
    if (message.type === "shard-request-cancel" && message.requestId) handlers.onRequestCancel?.(message.requestId);
    if (message.type === "shard-delete" && message.requestId) {
      let ok = false;
      try { ok = !!(await handlers.onDelete?.(message.shardId, message.authorization)); } catch {}
      send({ type: "shard-deleted", requestId: message.requestId, ok });
    }
    if (message.type === "shard-deleted") {
      const pending = pendingDeletes.get(message.requestId);
      if (pending) { pendingDeletes.delete(message.requestId); clearTimeout(pending.timer); pending.resolve(!!message.ok); }
    }
    if (message.type === "availability") handlers.onAvailability?.(message.shardId, message.challenge);
    if (message.type === "proof-request") {
      try {
        const bytes = await handlers.onProofRequest?.(message.shardId);
        if (!bytes) send({ type: "proof-none", requestId: message.requestId });
        else await sendProofBytes(message.requestId, message.shardId, bytes);
      } catch { send({ type: "proof-none", requestId: message.requestId }); }
    }
    if (message.type === "proof-start" && Number.isInteger(message.chunks) && message.chunks > 0 && message.chunks <= MAX_PROOF_CHUNKS && Number.isInteger(message.size) && message.size >= 0 && message.size <= MAX_PROOF_BYTES) incomingProofs.set(message.requestId, { shardId: message.shardId, hash: message.hash, size: Number(message.size), chunks: new Array(message.chunks) });
    if (message.type === "proof-chunk") { const item = incomingProofs.get(message.requestId); if (item && Number.isInteger(message.index) && message.index >= 0 && message.index < item.chunks.length) item.chunks[message.index] = Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0)); }
    if (message.type === "proof-end") {
      const item = incomingProofs.get(message.requestId); const pending = pendingProofs.get(message.requestId);
      incomingProofs.delete(message.requestId); if (!item || !pending || item.chunks.some((chunk) => !chunk)) return;
      pendingProofs.delete(message.requestId); clearTimeout(pending.timer);
      const size = item.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0); const bytes = new Uint8Array(size); let offset = 0;
      item.chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
      const actualHash = await hashBytes(bytes);
      pending.resolve(item.shardId === pending.shardId && item.size === size && item.hash === pending.expectedHash && actualHash === pending.expectedHash);
    }
    if (message.type === "proof-none") { const pending = pendingProofs.get(message.requestId); if (pending) { pendingProofs.delete(message.requestId); clearTimeout(pending.timer); pending.resolve(false); } }
    if (message.type === "gossip") handlers.onGossip?.(message.envelope);
    if (message.type === "control-put" && message.requestId && message.object) {
      let ok = false;
      try { ok = !!(await handlers.onControlPut?.(message.object)); } catch {}
      send({ type: "control-stored", requestId: message.requestId, ok });
    }
    if (message.type === "control-stored") {
      const pending = pendingControlStored.get(message.requestId);
      if (pending) { pendingControlStored.delete(message.requestId); clearTimeout(pending.timer); pending.resolve(!!message.ok); }
    }
    if (message.type === "control-query" && message.requestId) {
      let objects = [];
      try { objects = (await handlers.onControlQuery?.({ kind: message.kind, lookupKey: message.lookupKey, limit: message.limit })) || []; } catch {}
      const bounded = [];
      for (const object of objects.slice(0, 20)) {
        const candidate = [...bounded, object];
        if (JSON.stringify({ type: "control-response", requestId: message.requestId, objects: candidate }).length > MAX_CONTROL_OBJECT_BYTES) break;
        bounded.push(object);
      }
      send({ type: "control-response", requestId: message.requestId, objects: bounded });
    }
    if (message.type === "control-response") {
      const pending = pendingControlQueries.get(message.requestId);
      if (pending) { pendingControlQueries.delete(message.requestId); clearTimeout(pending.timer); pending.resolve(Array.isArray(message.objects) ? message.objects : []); }
    }
    if (message.type === "relay-signal") handlers.onRelaySignal?.(message.signal);
    if (message.type === "manifest-request") { const envelope = await handlers.onManifestRequest?.(message.manifestId); if (envelope) await sendManifestBytes(message.manifestId, envelope); else send({ type: "manifest-none", manifestId: message.manifestId }); }
    if (message.type === "manifest-start") incomingManifests.set(message.transferId, { manifestId: message.manifestId, chunks: new Array(message.chunks) });
    if (message.type === "manifest-chunk") { const item = incomingManifests.get(message.transferId); if (item && Number.isInteger(message.index) && message.index >= 0 && message.index < item.chunks.length) item.chunks[message.index] = message.data; }
    if (message.type === "manifest-end") {
      const item = incomingManifests.get(message.transferId); if (!item || item.chunks.some((chunk) => chunk === undefined)) return;
      incomingManifests.delete(message.transferId);
      try {
        const bytes = Uint8Array.from(atob(item.chunks.join("")), (c) => c.charCodeAt(0));
        const envelope = JSON.parse(new TextDecoder().decode(bytes));
        const accepted = (await handlers.onManifestReceived?.(item.manifestId, envelope)) !== false;
        send({ type: "manifest-stored", transferId: message.transferId, ok: accepted });
        const pending = pendingManifests.get(item.manifestId); if (pending) { pendingManifests.delete(item.manifestId); clearTimeout(pending.timer); pending.resolve(envelope); }
      } catch { send({ type: "manifest-stored", transferId: message.transferId, ok: false }); }
    }
    if (message.type === "manifest-stored") { const pending = pendingManifestStored.get(message.transferId); if (pending) { pendingManifestStored.delete(message.transferId); clearTimeout(pending.timer); message.ok ? pending.resolve(true) : pending.resolve(false); } }
    if (message.type === "manifest-none") { const pending = pendingManifests.get(message.manifestId); if (pending) { pendingManifests.delete(message.manifestId); clearTimeout(pending.timer); pending.resolve(null); } }
  });
  channel.addEventListener("close", () => {
    for (const pending of pendingStored.values()) { clearTimeout(pending.timer); pending.reject(new Error("Peer disconnected during transfer.")); }
    for (const pending of pendingDeletes.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    for (const pending of pendingManifests.values()) { clearTimeout(pending.timer); pending.resolve(null); }
    for (const pending of pendingManifestStored.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    for (const pending of pendingProofs.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    for (const pending of pendingPings.values()) { clearTimeout(pending.timer); pending.resolve(null); }
    for (const pending of pendingControlStored.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    for (const pending of pendingControlQueries.values()) { clearTimeout(pending.timer); pending.resolve([]); }
    pendingStored.clear(); pendingDeletes.clear(); pendingManifests.clear(); pendingManifestStored.clear(); pendingProofs.clear(); pendingPings.clear(); pendingControlStored.clear(); pendingControlQueries.clear();
    incoming.clear(); incomingManifests.clear(); incomingProofs.clear();
  });
  return {
    sendGossip(envelope) { send({ type: "gossip", envelope }); },
    async sendManifest(manifestId, envelope) {
      if (channel.readyState !== "open") return false;
      const transferId = crypto.randomUUID();
      const stored = new Promise((resolve) => { const timer = setTimeout(() => { pendingManifestStored.delete(transferId); resolve(false); }, CONTROL_TIMEOUT_MS); pendingManifestStored.set(transferId, { resolve, timer }); });
      await sendManifestBytes(manifestId, envelope, transferId);
      return stored;
    },
    async sendControlObject(object, timeoutMs = CONTROL_TIMEOUT_MS) {
      if (channel.readyState !== "open") return false;
      if (JSON.stringify(object).length > MAX_CONTROL_OBJECT_BYTES) return false;
      const requestId = crypto.randomUUID();
      const result = new Promise((resolve) => { const timer = setTimeout(() => { pendingControlStored.delete(requestId); resolve(false); }, timeoutMs); pendingControlStored.set(requestId, { resolve, timer }); });
      send({ type: "control-put", requestId, object });
      return result;
    },
    async queryControlObjects(kind, lookupKey, limit = 20, timeoutMs = CONTROL_TIMEOUT_MS) {
      if (channel.readyState !== "open") return [];
      const requestId = crypto.randomUUID();
      const result = new Promise((resolve) => { const timer = setTimeout(() => { pendingControlQueries.delete(requestId); resolve([]); }, timeoutMs); pendingControlQueries.set(requestId, { resolve, timer }); });
      send({ type: "control-query", requestId, kind, lookupKey, limit: Math.max(1, Math.min(20, Number(limit) || 20)) });
      return result;
    },
    sendRelayedSignal(signal) { if (channel.readyState !== "open") return false; try { send({ type: "relay-signal", signal }); return true; } catch { return false; } },
    async sendShard(shardId, bytes, hash, onProgress = () => {}, { signal } = {}) {
      if (channel.readyState !== "open") throw new Error("Peer connection is not ready.");
      if (signal?.aborted) throw signal.reason || new DOMException("Shard transfer cancelled", "AbortError");
      const startedAt = performance.now();
      const transferId = crypto.randomUUID(); const chunks = Math.ceil(bytes.byteLength / PACKET_BYTES);
      const stored = new Promise((resolve, reject) => { const timer = setTimeout(() => { pendingStored.delete(transferId); reject(new Error("Peer storage verification timed out.")); }, STORED_TIMEOUT_MS); pendingStored.set(transferId, { resolve, reject, timer }); });
      let cancelWait = null;
      const cancelled = signal ? new Promise((_, reject) => {
        cancelWait = () => reject(signal.reason || new DOMException("Shard transfer cancelled", "AbortError"));
        signal.addEventListener("abort", cancelWait, { once: true });
      }) : null;
      try {
        send({ type: "shard-start", transferId, shardId, chunks, hash });
        for (let index = 0; index < chunks; index++) {
          if (signal?.aborted) throw signal.reason || new DOMException("Shard transfer cancelled", "AbortError");
          while (channel.bufferedAmount > BUFFER_LIMIT) {
            if (signal?.aborted) throw signal.reason || new DOMException("Shard transfer cancelled", "AbortError");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const packet = new Uint8Array(bytes.slice(index * PACKET_BYTES, (index + 1) * PACKET_BYTES));
          send({ type: "shard-chunk", transferId, index, data: btoa(String.fromCharCode(...packet)) });
          onProgress?.((index + 1) / chunks);
        }
        send({ type: "shard-end", transferId });
        await (cancelled ? Promise.race([stored, cancelled]) : stored);
        const seconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
        reportQuality({ successfulTransfers: quality.successfulTransfers + 1, throughputEwmaBps: ewma(quality.throughputEwmaBps, bytes.byteLength / seconds) });
        return transferId;
      } catch (error) {
        const pending = pendingStored.get(transferId);
        if (pending) { pendingStored.delete(transferId); clearTimeout(pending.timer); pending.resolve(false); }
        send({ type: "shard-abort", transferId });
        reportQuality({ failedTransfers: quality.failedTransfers + 1 });
        throw error;
      } finally {
        if (cancelWait) signal?.removeEventListener("abort", cancelWait);
      }
    },
    requestShard(shardId) {
      const requestId = crypto.randomUUID();
      return send({ type: "shard-request", requestId, shardId }) ? requestId : null;
    },
    cancelShardRequest(requestId) {
      return requestId ? send({ type: "shard-request-cancel", requestId }) : false;
    },
    async requestDelete(shardId, authorization, timeoutMs = CONTROL_TIMEOUT_MS) {
      if (channel.readyState !== "open") return false;
      const requestId = crypto.randomUUID();
      const result = new Promise((resolve) => {
        const timer = setTimeout(() => { pendingDeletes.delete(requestId); resolve(false); }, timeoutMs);
        pendingDeletes.set(requestId, { resolve, timer });
      });
      if (!send({ type: "shard-delete", requestId, shardId, authorization })) {
        const pending = pendingDeletes.get(requestId); pendingDeletes.delete(requestId); clearTimeout(pending?.timer); return false;
      }
      return result;
    },
    async requestProof(shardId, expectedHash, timeoutMs = window.__DATA__?.resilience?.proofTimeoutMs || 45000) {
      if (channel.readyState !== "open") return false;
      const requestId = crypto.randomUUID();
      const result = new Promise((resolve) => {
        const timer = setTimeout(() => { pendingProofs.delete(requestId); incomingProofs.delete(requestId); resolve(false); }, timeoutMs);
        pendingProofs.set(requestId, { shardId, expectedHash, resolve, timer });
      });
      send({ type: "proof-request", requestId, shardId });
      const verified = await result; reportQuality(verified ? { successfulProofs: quality.successfulProofs + 1 } : { failedProofs: quality.failedProofs + 1 }); return verified;
    },
    async measureRtt(timeoutMs = PING_TIMEOUT_MS) {
      if (channel.readyState !== "open") return null;
      const pingId = crypto.randomUUID();
      const measured = await new Promise((resolve) => { const startedAt = performance.now(); const timer = setTimeout(() => { pendingPings.delete(pingId); resolve(null); }, timeoutMs); pendingPings.set(pingId, { startedAt, timer, resolve }); send({ type: "ping", pingId }); });
      if (measured == null) return null; const value = ewma(quality.rttEwmaMs, measured); reportQuality({ rttEwmaMs: value }); return value;
    },
    metrics() { return { ...quality }; },
    async requestManifest(manifestId, timeoutMs = MANIFEST_TIMEOUT_MS) {
      if (channel.readyState !== "open") return null;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pendingManifests.delete(manifestId); resolve(null); }, timeoutMs);
        pendingManifests.set(manifestId, { resolve, timer });
        send({ type: "manifest-request", manifestId });
      });
    },
  };
}
