import { anchorStatus, publishControlObject, updateAnchorSettings } from "./anchor-service.js";
import { computeAvailabilityScore, availabilityLabel } from "./availability-score.js";

const listeners = new Set();
let runtime = null;
let timer = null;
let startedAt = Date.now();
let status = {
  enabled: false, lifecycle: "stopped", leaseExpiresAt: null, leaseRemainingMs: 0,
  uptimeSeconds: 0, reliabilityScore: 0, reliabilityLabel: "unproven",
  buddyNodeIds: [], fullscreen: false, wakeAssistance: "unknown",
  serviceWorker: "unsupported", backgroundSync: "unsupported", lastHandoffAt: null,
};

function survivalConfig() {
  return window.__DATA__?.survival || {
    leaseMs: 90000, renewMs: 30000, buddyCount: 2, handoffTtlMs: 600000,
  };
}
function emit(patch = {}) {
  status = { ...status, ...patch };
  listeners.forEach((listener) => { try { listener({ ...status }); } catch {} });
  window.dispatchEvent(new CustomEvent("meshvault:survival-status", { detail: { ...status } }));
  return { ...status };
}
function peerMetrics() {
  return (runtime?.getPeers?.() || []).reduce((totals, peer) => {
    const metrics = peer.protocol?.metrics?.() || peer.quality || {};
    totals.successfulTransfers += Number(metrics.successfulTransfers || 0);
    totals.failedTransfers += Number(metrics.failedTransfers || 0);
    totals.successfulProofs += Number(metrics.successfulProofs || 0);
    totals.failedProofs += Number(metrics.failedProofs || 0);
    return totals;
  }, { successfulTransfers: 0, failedTransfers: 0, successfulProofs: 0, failedProofs: 0 });
}
function buddyIds() {
  return (runtime?.getPeers?.() || [])
    .filter((peer) => runtime?.peerInfo?.(peer.nodeId)?.capabilities?.includes("anchor-control-v1"))
    .sort((left, right) => {
      const l = left.protocol?.metrics?.()?.rttEwmaMs ?? Number.MAX_SAFE_INTEGER;
      const r = right.protocol?.metrics?.()?.rttEwmaMs ?? Number.MAX_SAFE_INTEGER;
      return l - r;
    })
    .slice(0, survivalConfig().buddyCount || 2)
    .map((peer) => peer.nodeId);
}
async function serviceWorkerRegistration() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    const workerUrl = new URL("../../sw.js", import.meta.url);
    const registration = await navigator.serviceWorker.register(workerUrl, { scope: "./" });
    emit({ serviceWorker: "ready" });
    if ("periodicSync" in registration) {
      try {
        await registration.periodicSync.register("meshvault-anchor-check", { minInterval: 12 * 60 * 60 * 1000 });
        emit({ backgroundSync: "registered" });
      } catch { emit({ backgroundSync: "permission needed" }); }
    } else if ("sync" in registration) {
      try { await registration.sync.register("meshvault-anchor-check"); emit({ backgroundSync: "registered" }); }
      catch { emit({ backgroundSync: "permission needed" }); }
    }
    return registration;
  } catch { emit({ serviceWorker: "failed" }); return null; }
}
function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
async function edgeAction(action, payload = {}) {
  const token = await runtime?.accessToken?.();
  if (!token || !window.__POLYMAI_SUPABASE_CONFIG__?.anonKey) throw new Error("Coordination session unavailable.");
  const response = await fetch(`${window.__DATA__.functionsBaseUrl}/app717-meshvault-api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: window.__POLYMAI_SUPABASE_CONFIG__.anonKey,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "Wake assistance request failed.");
    error.setupRequired = !!result.setupRequired;
    throw error;
  }
  return result;
}
export async function configureWakeAssistance() {
  const registration = await serviceWorkerRegistration();
  if (!registration || !("PushManager" in window) || !("Notification" in window)) return emit({ wakeAssistance: "unsupported" });
  try {
    const config = await edgeAction("push-config");
    if (!config.publicKey) return emit({ wakeAssistance: "setup needed" });
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") return emit({ wakeAssistance: "permission needed" });
    const pushEndpoint = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
    await edgeAction("register-push", { nodeId: runtime.nodeId, pushEndpoint: pushEndpoint.toJSON() });
    return emit({ wakeAssistance: "ready" });
  } catch (error) {
    return emit({ wakeAssistance: error.setupRequired ? "setup needed" : "unavailable" });
  }
}
async function publishHandoff(reason) {
  if (!status.enabled || !runtime?.nodeId) return;
  const anchor = await anchorStatus();
  const buddies = buddyIds();
  await publishControlObject("anchor-handoff", runtime.nodeId, {
    nodeId: runtime.nodeId,
    reason,
    buddies,
    leaseExpiresAt: status.leaseExpiresAt,
    objectCount: anchor.objectCount || 0,
    replicatedObjects: anchor.replicatedObjects || 0,
    observedAt: new Date().toISOString(),
  }, survivalConfig().handoffTtlMs || 600000).catch(() => {});
  emit({ buddyNodeIds: buddies, lastHandoffAt: new Date().toISOString() });
}
async function renew(reason = "timer") {
  if (!runtime?.nodeId) return status;
  const now = Date.now();
  const config = survivalConfig();
  const anchor = await anchorStatus();
  const leaseExpiresAt = status.enabled ? new Date(now + config.leaseMs).toISOString() : null;
  const metrics = peerMetrics();
  const uptimeSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const reliabilityScore = computeAvailabilityScore({
    ...metrics,
    uptimeSeconds,
    leaseRemainingMs: status.enabled ? config.leaseMs : 0,
    leaseDurationMs: config.leaseMs,
    wakeLockActive: anchor.wakeLock === "held",
    persistentStorage: !!(await navigator.storage?.persisted?.().catch(() => false)),
    visible: document.visibilityState === "visible",
  });
  const next = emit({
    lifecycle: status.enabled ? (document.visibilityState === "visible" ? "serving" : "backgrounded") : "stopped",
    leaseExpiresAt, leaseRemainingMs: status.enabled ? config.leaseMs : 0,
    uptimeSeconds, reliabilityScore, reliabilityLabel: availabilityLabel(reliabilityScore, status.enabled),
    buddyNodeIds: buddyIds(), fullscreen: !!document.fullscreenElement,
  });
  await runtime.renewLease?.({ ...next, reason, wakeLockActive: anchor.wakeLock === "held", sessionStartedAt: new Date(startedAt).toISOString() });
  if (status.enabled && (reason !== "timer" || !status.lastHandoffAt || now - Date.parse(status.lastHandoffAt) > 90000)) await publishHandoff(reason);
  return next;
}
function schedule() {
  clearInterval(timer);
  timer = window.setInterval(() => renew("timer").catch(() => {}), survivalConfig().renewMs || 30000);
}
async function onVisibility() {
  if (!status.enabled) return;
  await renew(document.visibilityState === "visible" ? "resumed" : "backgrounded");
}
function onFreeze() { publishHandoff("frozen").catch(() => {}); }
function onPageHide() { publishHandoff("page-hidden").catch(() => {}); }

export async function configureSurvivalService(options = {}) {
  runtime = options;
  startedAt = Date.now();
  serviceWorkerRegistration().catch(() => {});
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("freeze", onFreeze);
  document.addEventListener("resume", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  if (document.wasDiscarded) emit({ lifecycle: "restored-after-discard" });
  schedule();
  const anchor = await anchorStatus();
  emit({ enabled: !!anchor.enabled });
  return renew("started");
}
export async function setSurvivalMode(enabled, { fullscreen = false } = {}) {
  await updateAnchorSettings({ enabled: !!enabled });
  emit({ enabled: !!enabled });
  if (enabled) {
    await navigator.storage?.persist?.().catch(() => false);
    if (fullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen?.().catch(() => {});
    await configureWakeAssistance();
  } else if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
  return renew(enabled ? "enabled" : "disabled");
}
export async function requestBuddyWake(nodeId) {
  if (!runtime?.nodeId || !nodeId) throw new Error("A connected buddy node is required.");
  return edgeAction("send-node-wake", { senderNodeId: runtime.nodeId, recipientNodeId: nodeId });
}
export function onSurvivalStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function survivalStatus() {
  const remaining = status.leaseExpiresAt ? Math.max(0, Date.parse(status.leaseExpiresAt) - Date.now()) : 0;
  return { ...status, leaseRemainingMs: remaining, fullscreen: !!document.fullscreenElement };
}
export async function stopSurvivalService() {
  clearInterval(timer); timer = null;
  document.removeEventListener("visibilitychange", onVisibility);
  document.removeEventListener("freeze", onFreeze);
  document.removeEventListener("resume", onVisibility);
  window.removeEventListener("pagehide", onPageHide);
  if (status.enabled) await publishHandoff("stopped");
  runtime = null;
}
