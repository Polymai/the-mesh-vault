import {
  ALG_ED25519, base64UrlToBytes, bytesToBase64Url, canonicalBytes,
  importPublicKeyRaw, verify,
} from "../../security/signing.js";

export const RENDEZVOUS_PROTOCOL = 1;
export const RENDEZVOUS_EVENT_KIND = 25171;
export const RENDEZVOUS_DESCRIPTOR_KIND = 30078;
export const RENDEZVOUS_TAG = "themeshvault-v3";
export const RENDEZVOUS_DESCRIPTOR_TAG = "themeshvault-patient-zero-v1";
export const RENDEZVOUS_PRESENCE_TYPE = "tmv-signed-presence-v1";
const MAX_PRESENCE_LIFETIME_MS = 10 * 60 * 1000;

function nowMs() { return Date.now(); }
function isHexKey(value) { return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value); }
function isAuthorityKey(value) {
  if (typeof value !== "string") return false;
  try { return base64UrlToBytes(value).byteLength === 32; } catch { return false; }
}

function boundedPresence(value) {
  if (!value || typeof value !== "object") return null;
  const nodeId = String(value.nodeId || "").slice(0, 128);
  const devicePublicKey = String(value.devicePublicKey || "").slice(0, 128);
  if (!nodeId || !devicePublicKey) return null;
  return {
    nodeId,
    nodeName: String(value.nodeName || "Mesh node").slice(0, 80),
    devicePublicKey,
    protocolVersion: Math.max(3, Number(value.protocolVersion) || 3),
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.map((item) => String(item).slice(0, 64)).slice(0, 16) : [],
    capacityBytes: Math.max(0, Number(value.capacityBytes) || 0),
    usedBytes: Math.max(0, Number(value.usedBytes) || 0),
    countryCode: value.countryCode ? String(value.countryCode).slice(0, 2).toUpperCase() : null,
    regionCode: value.regionCode ? String(value.regionCode).slice(0, 16) : null,
    failureDomainId: value.failureDomainId ? String(value.failureDomainId).slice(0, 160) : null,
    reliabilityScore: value.reliabilityScore !== null && value.reliabilityScore !== "" && Number.isFinite(Number(value.reliabilityScore))
      ? Number(value.reliabilityScore)
      : null,
    survivalMode: !!value.survivalMode,
    leaseExpiresAt: value.leaseExpiresAt ? String(value.leaseExpiresAt).slice(0, 40) : null,
    uptimeSeconds: Math.max(0, Number(value.uptimeSeconds) || 0),
    anchorProtocolVersion: Math.max(0, Number(value.anchorProtocolVersion) || 0),
    coordinationMode: value.coordinationMode ? String(value.coordinationMode).slice(0, 32) : null,
  };
}

export async function signAuthorityObject(signer, type, payload, lifetimeMs) {
  if (!signer?.publicKey || typeof signer.sign !== "function") throw new Error("Patient Zero signer is unavailable.");
  const core = {
    protocol: RENDEZVOUS_PROTOCOL,
    type,
    authorityPublicKey: signer.publicKey,
    issuedAt: nowMs(),
    expiresAt: nowMs() + Math.max(10000, Number(lifetimeMs) || 60000),
    payload,
  };
  const signature = bytesToBase64Url(await signer.sign(canonicalBytes(core)));
  return { ...core, signature, algorithm: signer.algorithm || ALG_ED25519 };
}

export async function verifyAuthorityObject(value, allowedAuthorityPublicKeys, expectedType, at = nowMs()) {
  if (!value || value.protocol !== RENDEZVOUS_PROTOCOL || value.type !== expectedType) return null;
  if (!isAuthorityKey(value.authorityPublicKey) || !allowedAuthorityPublicKeys.includes(value.authorityPublicKey)) return null;
  if (value.algorithm !== ALG_ED25519 || !Number.isFinite(value.issuedAt) || !Number.isFinite(value.expiresAt)) return null;
  if (value.issuedAt > at + 120000 || value.expiresAt <= at || value.expiresAt - value.issuedAt > 24 * 60 * 60 * 1000) return null;
  const core = {
    protocol: value.protocol,
    type: value.type,
    authorityPublicKey: value.authorityPublicKey,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    payload: value.payload,
  };
  let raw; let signature;
  try {
    raw = base64UrlToBytes(value.authorityPublicKey);
    signature = base64UrlToBytes(value.signature);
    const key = await importPublicKeyRaw(raw, ALG_ED25519);
    return await verify(key, ALG_ED25519, signature, canonicalBytes(core)) ? value : null;
  } catch { return null; }
  finally { raw?.fill(0); signature?.fill(0); }
}

export async function signPresenceObject(signer, transportPublicKey, presence, lifetimeMs = 5 * 60 * 1000) {
  const normalized = boundedPresence(presence);
  if (!normalized || !signer?.publicKey || typeof signer.sign !== "function" || !isHexKey(transportPublicKey)) {
    throw new Error("A valid device identity and rendezvous transport are required.");
  }
  if (normalized.devicePublicKey !== signer.publicKey) throw new Error("Presence does not belong to this device signer.");
  const issuedAt = nowMs();
  const core = {
    protocol: RENDEZVOUS_PROTOCOL,
    type: RENDEZVOUS_PRESENCE_TYPE,
    devicePublicKey: signer.publicKey,
    transportPublicKey: transportPublicKey.toLowerCase(),
    issuedAt,
    expiresAt: issuedAt + Math.min(MAX_PRESENCE_LIFETIME_MS, Math.max(10000, Number(lifetimeMs) || 60000)),
    presence: normalized,
  };
  return {
    ...core,
    signature: bytesToBase64Url(await signer.sign(canonicalBytes(core))),
    algorithm: signer.algorithm || ALG_ED25519,
  };
}

export async function verifyPresenceObject(value, expectedTransportPublicKey = null, at = nowMs()) {
  if (!value || value.protocol !== RENDEZVOUS_PROTOCOL || value.type !== RENDEZVOUS_PRESENCE_TYPE) return null;
  if (!isAuthorityKey(value.devicePublicKey) || !isHexKey(value.transportPublicKey)) return null;
  if (expectedTransportPublicKey && value.transportPublicKey.toLowerCase() !== String(expectedTransportPublicKey).toLowerCase()) return null;
  const presence = boundedPresence(value.presence);
  if (!presence || presence.devicePublicKey !== value.devicePublicKey || value.algorithm !== ALG_ED25519) return null;
  if (!Number.isFinite(value.issuedAt) || !Number.isFinite(value.expiresAt)) return null;
  if (value.issuedAt > at + 120000 || value.expiresAt <= at || value.expiresAt - value.issuedAt > MAX_PRESENCE_LIFETIME_MS) return null;
  const core = {
    protocol: value.protocol,
    type: value.type,
    devicePublicKey: value.devicePublicKey,
    transportPublicKey: value.transportPublicKey.toLowerCase(),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    presence,
  };
  let raw; let signature;
  try {
    raw = base64UrlToBytes(value.devicePublicKey);
    signature = base64UrlToBytes(value.signature);
    const key = await importPublicKeyRaw(raw, ALG_ED25519);
    return await verify(key, ALG_ED25519, signature, canonicalBytes(core)) ? { ...value, presence } : null;
  } catch { return null; }
  finally { raw?.fill(0); signature?.fill(0); }
}

export function normalizeDescriptorPayload(payload) {
  const responders = Array.isArray(payload?.responders) ? payload.responders : [];
  return {
    responders: responders.filter((item) => isHexKey(item?.transportPublicKey) && isAuthorityKey(item?.authorityPublicKey)).slice(0, 12).map((item) => ({
      transportPublicKey: item.transportPublicKey.toLowerCase(),
      authorityPublicKey: item.authorityPublicKey,
    })),
  };
}

export function normalizeDirectoryPayload(payload, { maximumPeers = 50 } = {}) {
  const peers = [];
  for (const item of Array.isArray(payload?.peers) ? payload.peers : []) {
    if (!isHexKey(item?.transportPublicKey)) continue;
    if (!item.presenceEnvelope || typeof item.presenceEnvelope !== "object") continue;
    peers.push({ transportPublicKey: item.transportPublicKey.toLowerCase(), presenceEnvelope: item.presenceEnvelope });
    if (peers.length >= maximumPeers) break;
  }
  return { peers };
}

export function safePresence(value) { return boundedPresence(value); }
