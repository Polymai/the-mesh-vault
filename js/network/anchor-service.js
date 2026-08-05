import { verifyManifestV3 } from "../security/manifest.js";
import { saveManifestLocally, getLocalManifest } from "./manifest-discovery.js";
import {
  buildControlObject, putControlObject, findControlObjects, listPendingControlObjects,
  markControlReplica, controlStoreStats,
} from "../storage/control-store.js";
import { getAnchorSettings, setAnchorSettings } from "../services/vault-service.js";

export const ANCHOR_CAPABILITY = "anchor-control-v3";
const TTL = Object.freeze({
  manifest: 30 * 86400000,
  oplog: 30 * 86400000,
  "vault-index": 30 * 86400000,
  "deletion-order": 30 * 86400000,
  "deletion-ack": 30 * 86400000,
  "repair-request": 30 * 60 * 1000,
  "repair-lease": 2 * 60 * 1000,
  "repair-complete": 30 * 86400000,
  peer: 120000,
  "fragment-location": 300000,
});

let runtime = null;
let settings = { enabled: false, cacheLimitBytes: 104857600 };
let wakeLock = null;
let timer = null;
let statusListener = null;
let statusTimer = null;
let statusPromise = null;
let lastStatus = null;
let lastStatusAt = 0;
const signalListeners = new Set();
const STATUS_EMIT_INTERVAL_MS = 1000;

function peers() { return runtime?.getPeers?.() || []; }
function anchorPeers() {
  return peers().filter((peer) => runtime?.peerInfo?.(peer.nodeId)?.capabilities?.includes(ANCHOR_CAPABILITY));
}
function signer() { return runtime?.signer || null; }
function cacheOptions() { return { maxBytes: settings.cacheLimitBytes }; }

async function acquireWakeLock() {
  if (!settings.enabled || document.visibilityState !== "visible" || !navigator.wakeLock?.request) return null;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; emitStatus().catch(() => {}); }, { once: true });
    return wakeLock;
  } catch { return null; }
}

async function persistBrowserStorage() {
  try { return !!(await navigator.storage?.persist?.()); } catch { return false; }
}

export async function createAndCacheControlObject(kind, lookupKey, payload, ttlMs = TTL[kind] || 300000) {
  const object = await buildControlObject(signer(), kind, lookupKey, payload, { ttlMs });
  await putControlObject(object, cacheOptions());
  return object;
}

async function sendObjectToAnchors(object) {
  let replicas = 0;
  for (const peer of anchorPeers().slice(0, window.__DATA__?.anchor?.replicationTarget || 3)) {
    const accepted = await peer.protocol.sendControlObject?.(object).catch(() => false);
    if (accepted) { replicas += 1; await markControlReplica(object.objectId, peer.nodeId); }
  }
  return replicas;
}

export async function publishControlObject(kind, lookupKey, payload, ttlMs) {
  const object = await createAndCacheControlObject(kind, lookupKey, payload, ttlMs);
  const replicaCount = await sendObjectToAnchors(object);
  await emitStatus();
  return { ...object, replicaCount };
}

export async function replicateOplogOperation(operation) {
  if (!operation?.vaultId || !operation?.opId) return 0;
  const object = await createAndCacheControlObject("oplog", operation.vaultId, operation, TTL.oplog);
  const replicas = await sendObjectToAnchors(object);
  await emitStatus();
  return replicas;
}

export async function acceptControlObject(object, fromNodeId) {
  if (!settings.enabled) return false;
  await putControlObject(object, { ...cacheOptions(), replicaNodeId: fromNodeId });
  await emitStatus();
  return true;
}

export async function answerControlQuery({ kind, lookupKey, limit = 20 } = {}) {
  if (!settings.enabled) return [];
  return findControlObjects(String(kind || ""), String(lookupKey || ""), limit);
}

export async function publishManifestReplica(envelope) {
  const verification = await verifyManifestV3(envelope);
  if (!verification.valid) throw new Error(`Manifest replica rejected: ${verification.reason}`);
  await saveManifestLocally(envelope);
  const object = await createAndCacheControlObject("manifest", envelope.manifestId, envelope, TTL.manifest);
  let replicas = 0;
  for (const peer of anchorPeers().slice(0, window.__DATA__?.anchor?.replicationTarget || 3)) {
    const accepted = await peer.protocol.sendManifest?.(envelope.manifestId, envelope).catch(() => false);
    if (accepted) { replicas += 1; await markControlReplica(object.objectId, peer.nodeId); }
  }
  await emitStatus();
  return replicas;
}

export async function acceptManifestReplica(envelope, fromNodeId) {
  const verification = await verifyManifestV3(envelope);
  if (!verification.valid) return false;
  await saveManifestLocally(envelope);
  if (settings.enabled) {
    const object = await createAndCacheControlObject("manifest", envelope.manifestId, envelope, TTL.manifest);
    if (fromNodeId) await markControlReplica(object.objectId, fromNodeId);
  }
  await emitStatus();
  return true;
}

export async function lookupManifestReplica(manifestId) {
  const local = await getLocalManifest(manifestId);
  if (local && (await verifyManifestV3(local)).valid) return local;
  const cached = await findControlObjects("manifest", manifestId, 1);
  if (cached[0] && (await verifyManifestV3(cached[0].payload)).valid) return cached[0].payload;
  for (const peer of anchorPeers()) {
    const envelope = await peer.protocol.requestManifest?.(manifestId).catch(() => null);
    if (envelope && (await verifyManifestV3(envelope)).valid) { await saveManifestLocally(envelope); return envelope; }
  }
  return null;
}

export async function queryAnchors(kind, lookupKey, limit = 20) {
  const found = new Map();
  for (const local of await findControlObjects(kind, lookupKey, limit)) found.set(local.objectId, local);
  for (const peer of anchorPeers()) {
    const rows = await peer.protocol.queryControlObjects?.(kind, lookupKey, limit).catch(() => []);
    for (const row of rows || []) {
      try { const accepted = await putControlObject(row, cacheOptions()); found.set(accepted.objectId, accepted); } catch {}
    }
    if (found.size >= limit) break;
  }
  return Array.from(found.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function replicatePendingControlObjects() {
  if (!peers().length) return 0;
  let replicated = 0;
  for (const object of await listPendingControlObjects(40)) replicated += await sendObjectToAnchors(object);
  await emitStatus();
  return replicated;
}

export function relaySignalThroughAnchors(signal) {
  const envelope = {
    ...signal,
    relayId: signal.relayId || crypto.randomUUID(),
    relayHops: Number.isInteger(signal.relayHops) ? signal.relayHops : 0,
    relayVisited: Array.from(new Set([...(signal.relayVisited || []), runtime?.nodeId].filter(Boolean))).slice(-8),
  };
  let sent = 0;
  for (const peer of anchorPeers()) {
    if (envelope.relayVisited.includes(peer.nodeId)) continue;
    if (peer.protocol.sendRelayedSignal?.(envelope)) sent += 1;
  }
  return sent;
}

export function receiveRelayedSignal(signal, sourcePeerId) {
  const sourceIsAnchor = runtime?.peerInfo?.(sourcePeerId)?.capabilities?.includes(ANCHOR_CAPABILITY);
  if (!signal || (signal.fromNodeId !== sourcePeerId && !sourceIsAnchor) || !signal.toNodeId || Number(signal.relayHops || 0) > 3) return false;
  if (signal.toNodeId === runtime?.nodeId) {
    signalListeners.forEach((listener) => { try { listener(signal); } catch {} });
    return true;
  }
  if (!settings.enabled) return false;
  const target = peers().find((peer) => peer.nodeId === signal.toNodeId);
  if (target?.protocol?.sendRelayedSignal?.(signal)) return true;
  const visited = new Set([...(signal.relayVisited || []), sourcePeerId, runtime?.nodeId].filter(Boolean));
  const forwarded = { ...signal, relayHops: Number(signal.relayHops || 0) + 1, relayVisited: Array.from(visited).slice(-8) };
  let sent = 0;
  for (const peer of anchorPeers()) {
    if (visited.has(peer.nodeId)) continue;
    if (peer.protocol.sendRelayedSignal?.(forwarded)) sent += 1;
  }
  return sent > 0;
}

export function onRelayedSignal(listener) { signalListeners.add(listener); return () => signalListeners.delete(listener); }

export async function anchorStatus() {
  const stats = await controlStoreStats();
  const connected = peers();
  const connectedAnchors = anchorPeers().length;
  const observed = connected.map((peer) => runtime?.peerInfo?.(peer.nodeId)).filter(Boolean);
  const coordination = runtime?.getCoordinationStatus?.() || {};
  const wakeLockStatus = !navigator.wakeLock?.request ? "unsupported" : wakeLock && !wakeLock.released ? "held" : document.visibilityState === "visible" ? "released" : "background";
  return {
    enabled: settings.enabled, cacheLimitBytes: settings.cacheLimitBytes,
    connectedAnchors, servedPeers: Math.max(0, connected.length - connectedAnchors),
    observedCapacityBytes: observed.reduce((sum, peer) => sum + Math.max(0, Number(peer.capacityBytes) || 0), 0),
    observedUsedBytes: observed.reduce((sum, peer) => sum + Math.max(0, Number(peer.usedBytes) || 0), 0),
    coordinationMode: coordination.mode || "supabase-primary",
    fallbackActive: coordination.fallbackActive !== false,
    wakeLock: wakeLockStatus, ...stats,
    warmIndependent: settings.enabled && connectedAnchors >= 1 && wakeLockStatus === "held",
    status: !settings.enabled ? "off" : document.visibilityState !== "visible" ? "paused" : "running",
  };
}

async function performStatusEmit() {
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  if (statusPromise) return statusPromise;
  statusPromise = anchorStatus().then((status) => {
    lastStatus = status;
    lastStatusAt = Date.now();
    statusListener?.(status);
    window.dispatchEvent(new CustomEvent("meshvault:anchor-status", { detail: status }));
    return status;
  }).finally(() => { statusPromise = null; });
  return statusPromise;
}

async function emitStatus({ immediate = false } = {}) {
  const remaining = STATUS_EMIT_INTERVAL_MS - (Date.now() - lastStatusAt);
  if (!immediate && lastStatus && remaining > 0) {
    if (!statusTimer) statusTimer = window.setTimeout(() => performStatusEmit().catch(() => {}), remaining);
    return lastStatus;
  }
  return performStatusEmit();
}

async function cycle() { await replicatePendingControlObjects().catch(() => {}); }

export async function configureAnchorService({ nodeId, deviceIdentity, getPeers, peerInfo, getCoordinationStatus, onStatus } = {}) {
  runtime = { nodeId, getPeers, peerInfo, getCoordinationStatus, signer: { publicKey: deviceIdentity.devicePublicKey, algorithm: deviceIdentity.algorithm, sign: deviceIdentity.sign } };
  statusListener = onStatus || null;
  settings = await getAnchorSettings();
  clearInterval(timer); timer = window.setInterval(() => cycle().catch(() => {}), window.__DATA__?.anchor?.heartbeatMs || 30000);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (settings.enabled) { await persistBrowserStorage(); await acquireWakeLock(); }
  await emitStatus({ immediate: true });
  return settings;
}

async function onVisibilityChange() {
  if (settings.enabled && document.visibilityState === "visible" && (!wakeLock || wakeLock.released)) await acquireWakeLock();
  await emitStatus({ immediate: true });
}

export async function updateAnchorSettings(next) {
  settings = await setAnchorSettings(next);
  if (settings.enabled) { await persistBrowserStorage(); await acquireWakeLock(); }
  else { await wakeLock?.release?.().catch(() => {}); wakeLock = null; }
  // A settings change must not wait for slow or half-open peers. Publish the
  // local role immediately and let control-record replication continue in the
  // background.
  await emitStatus({ immediate: true });
  replicatePendingControlObjects().catch(() => {});
  return settings;
}

export function anchorCapabilities() { return settings.enabled ? [ANCHOR_CAPABILITY] : []; }
export function isAnchorEnabled() { return settings.enabled; }

export async function stopAnchorService() {
  clearInterval(timer); timer = null;
  clearTimeout(statusTimer); statusTimer = null; statusPromise = null; lastStatus = null; lastStatusAt = 0;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  await wakeLock?.release?.().catch(() => {}); wakeLock = null; runtime = null; statusListener = null;
}
