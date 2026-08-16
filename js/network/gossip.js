import { canonicalBytes, canonicalHashHex, bytesToBase64Url, base64UrlToBytes, importPublicKeyRaw, verify as verifySignature } from "../security/signing.js";

export const GOSSIP_PROTOCOL_VERSION = 3;
export const DEFAULT_TTL_HOPS = 4;
export const DEFAULT_EXPIRY_MS = 2 * 60 * 1000;
export const MAX_PAYLOAD_BYTES = 8 * 1024;
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX_PER_PEER = 40;
const SEEN_SWEEP_MS = 30000;

export const GOSSIP_KINDS = Object.freeze({
  PEER_ANNOUNCE: "peer-announce",
  MANIFEST_AVAILABILITY: "manifest-availability",
  FRAGMENT_AVAILABILITY: "fragment-availability",
  MANIFEST_REQUEST: "manifest-request",
  FRAGMENT_REQUEST: "fragment-request",
  REPAIR_REQUEST: "repair-request",
  CAPACITY_CHANGE: "capacity-change",
  BOOTSTRAP_AVAILABILITY: "bootstrap-availability",
  TOPOLOGY_ANNOUNCE: "topology-announce",
});

const seenMessages = new Map();
const peerRateCounters = new Map();
if (typeof window !== "undefined") {
  setInterval(() => { const now = Date.now(); for (const [id, expiresAt] of seenMessages) if (expiresAt < now) seenMessages.delete(id); }, SEEN_SWEEP_MS);
}

function rateLimited(peerKey) {
  if (!peerKey) return false;
  const now = Date.now(); const counter = peerRateCounters.get(peerKey);
  if (!counter || now - counter.windowStart > RATE_LIMIT_WINDOW_MS) { peerRateCounters.set(peerKey, { windowStart: now, count: 1 }); return false; }
  counter.count += 1; return counter.count > RATE_LIMIT_MAX_PER_PEER;
}

export async function buildGossipMessage(signer, kind, payload, { ttlHops = DEFAULT_TTL_HOPS, expiresInMs = DEFAULT_EXPIRY_MS } = {}) {
  if (canonicalBytes(payload).byteLength > MAX_PAYLOAD_BYTES) throw new Error("Gossip payload exceeds the size limit.");
  const payloadHash = await canonicalHashHex(payload);
  const core = {
    messageId: crypto.randomUUID(), kind, senderPublicKey: signer.publicKey, algorithm: signer.algorithm,
    timestamp: Date.now(), expiresAt: Date.now() + expiresInMs, ttlHops, payloadHash, payload, protocolVersion: GOSSIP_PROTOCOL_VERSION,
  };
  const signature = bytesToBase64Url(await signer.sign(canonicalBytes(core)));
  return { ...core, signature };
}

export async function acceptGossipMessage(message, peerKey) {
  if (!message || typeof message !== "object") return { accepted: false, reason: "malformed" };
  if (message.protocolVersion !== GOSSIP_PROTOCOL_VERSION) return { accepted: false, reason: "unsupported_protocol_version" };
  if (!Object.values(GOSSIP_KINDS).includes(message.kind)) return { accepted: false, reason: "unknown_kind" };
  if (canonicalBytes(message.payload ?? {}).byteLength > MAX_PAYLOAD_BYTES) return { accepted: false, reason: "payload_too_large" };
  if (typeof message.expiresAt !== "number" || Date.now() > message.expiresAt) return { accepted: false, reason: "expired" };
  if (!Number.isInteger(message.ttlHops) || message.ttlHops < 0) return { accepted: false, reason: "invalid_ttl" };
  if (seenMessages.has(message.messageId)) return { accepted: false, reason: "duplicate" };
  if (rateLimited(peerKey)) return { accepted: false, reason: "rate_limited" };
  if ((await canonicalHashHex(message.payload)) !== message.payloadHash) return { accepted: false, reason: "payload_hash_mismatch" };
  try {
    const publicKey = await importPublicKeyRaw(base64UrlToBytes(message.senderPublicKey), message.algorithm);
    const { signature, ...core } = message;
    const ok = await verifySignature(publicKey, message.algorithm, base64UrlToBytes(signature), canonicalBytes(core));
    if (!ok) return { accepted: false, reason: "invalid_signature" };
  } catch { return { accepted: false, reason: "invalid_signature" }; }
  seenMessages.set(message.messageId, message.expiresAt);
  return { accepted: true };
}

export function isForwardable(message) { return message.ttlHops > 1 && Date.now() < message.expiresAt; }
export function withDecrementedHop(message) { return { ...message, ttlHops: message.ttlHops - 1 }; }
