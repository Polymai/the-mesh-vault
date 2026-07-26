import { verifyManifestV2 } from "../security/manifest.js";
import { saveManifestLocally, getLocalManifest } from "./manifest-discovery.js";
import {
  buildControlObject, putControlObject, findControlObjects, listPendingControlObjects,
  markControlReplica, controlStoreStats,
} from "../storage/control-store.js";
import { getAnchorSettings, setAnchorSettings } from "../services/vault-service.js";

export const ANCHOR_CAPABILITY = "anchor-control-v1";
const TTL = Object.freeze({ manifest: 30 * 86400000, oplog: 30 * 86400000, peer: 120000, "fragment-location": 300000 });

let runtime = null;
let settings = { enabled: false, cacheLimitBytes: 104857600 };
let wakeLock = null;
let timer = null;
let statusListener = null;
const signalListeners = new Set();

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
  for (const peer of anchorPeers().slice(0, window.__DATA__?.anchor?.replicationTarget || 2)) {
    const accepted = await peer.protocol.sendControlObject?.(object).catch(() => false);
    if (accepted) { replicas += 1; await markControlReplica(object.objectId, peer.nodeId); }
  }
  return replicas;
}

export async function publishControlObject(kind, lookupKey, payload, ttlMs) {
  const object = await createAndCacheControlObject(kind, lookupKey, payload, ttlMs);
  await sendObjectToAnchors(object);
  await emitStatus();
  return object;
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
  const verification = await verifyManifestV2(envelope);
  if (!verification.valid) throw new Error(`Manifest replica rejected: ${verification.reason}`);
  await saveManifestLocally(envelope);
  const object = await createAndCacheControlObject("manifest", envelope.manifestId, envelope, TTL.manifest);
  let replicas = 0;
  for (const peer of anchorPeers().slice(0, window.__DATA__?.anchor?.replicationTarget || 2)) {
    const accepted = await peer.protocol.sendManifest?.(envelope.manifestId, envelope).catch(() => false);
    if (accepted) { replicas += 1; await markControlReplica(object.objectId, peer.nodeId); }
  }
  await emitStatus();
  return replicas;
}

export async function acceptManifestReplica(envelope, fromNodeId) {
  const verification = await verifyManifestV2(envelope);
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
  if (local && (await verifyManifestV2(local)).valid) return local;
  const cached = await findControlObjects("manifest", manifestId, 1);
  if (cached[0] && (await verifyManifestV2(cached[0].payload)).valid) return cached[0].payload;
  for (const peer of anchorPeers()) {
    const envelope = await peer.protocol.requestManifest?.(manifestId).catch(() => null);
    if (envelope && (await verifyManifestV2(envelope)).valid) { await saveManifestLocally(envelope); return envelope; }
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
  let sent = 0;
  for (const peer of anchorPeers()) { if (peer.protocol.sendRelayedSignal?.(signal)) sent += 1; }
  return sent;
}

export function receiveRelayedSignal(signal, sourcePeerId) {
  const sourceIsAnchor = runtime?.peerInfo?.(sourcePeerId)?.capabilities?.includes(ANCHOR_CAPABILITY);
  if (!signal || (signal.fromNodeId !== sourcePeerId && !sourceIsAnchor) || !signal.toNodeId) return false;
  if (signal.toNodeId === runtime?.nodeId) {
    signalListeners.forEach((listener) => { try { listener(signal); } catch {} });
    return true;
  }
  if (!settings.enabled) return false;
  const target = peers().find((peer) => peer.nodeId === signal.toNodeId);
  return !!target?.protocol?.sendRelayedSignal?.(signal);
}

export function onRelayedSignal(listener) { signalListeners.add(listener); return () => signalListeners.delete(listener); }

export async function anchorStatus() {
  const stats = await controlStoreStats();
  const connectedAnchors = anchorPeers().length;
  const wakeLockStatus = !navigator.wakeLock?.request ? "unsupported" : wakeLock && !wakeLock.released ? "held" : document.visibilityState === "visible" ? "released" : "background";
  return {
    enabled: settings.enabled, cacheLimitBytes: settings.cacheLimitBytes,
    connectedAnchors, wakeLock: wakeLockStatus, ...stats,
    warmIndependent: settings.enabled && connectedAnchors >= 1 && wakeLockStatus === "held",
    status: !settings.enabled ? "off" : document.visibilityState !== "visible" ? "paused" : "running",
  };
}

async function emitStatus() {
  const status = await anchorStatus();
  statusListener?.(status);
  window.dispatchEvent(new CustomEvent("meshvault:anchor-status", { detail: status }));
  return status;
}

async function cycle() { await replicatePendingControlObjects().catch(() => {}); await emitStatus(); }

export async function configureAnchorService({ nodeId, deviceIdentity, getPeers, peerInfo, onStatus } = {}) {
  runtime = { nodeId, getPeers, peerInfo, signer: { publicKey: deviceIdentity.devicePublicKey, algorithm: deviceIdentity.algorithm, sign: deviceIdentity.sign } };
  statusListener = onStatus || null;
  settings = await getAnchorSettings();
  clearInterval(timer); timer = window.setInterval(() => cycle().catch(() => {}), window.__DATA__?.anchor?.heartbeatMs || 30000);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (settings.enabled) { await persistBrowserStorage(); await acquireWakeLock(); }
  await emitStatus();
  return settings;
}

async function onVisibilityChange() {
  if (settings.enabled && document.visibilityState === "visible" && (!wakeLock || wakeLock.released)) await acquireWakeLock();
  await emitStatus();
}

export async function updateAnchorSettings(next) {
  settings = await setAnchorSettings(next);
  if (settings.enabled) { await persistBrowserStorage(); await acquireWakeLock(); }
  else { await wakeLock?.release?.().catch(() => {}); wakeLock = null; }
  await cycle();
  return settings;
}

export function anchorCapabilities() { return settings.enabled ? [ANCHOR_CAPABILITY] : []; }
export function isAnchorEnabled() { return settings.enabled; }

export async function stopAnchorService() {
  clearInterval(timer); timer = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  await wakeLock?.release?.().catch(() => {}); wakeLock = null; runtime = null; statusListener = null;
}
