import { anchorStatus, publishControlObject, updateAnchorSettings } from "./anchor-service.js";
import { computeAvailabilityScore, availabilityLabel } from "./availability-score.js";
import { ensureAppServiceWorker } from "../platform/service-worker.js";

const listeners = new Set();
let runtime = null;
let timer = null;
let startedAt = Date.now();
let status = {
  enabled: false, lifecycle: "stopped", leaseExpiresAt: null, leaseRemainingMs: 0,
  uptimeSeconds: 0, reliabilityScore: 0, reliabilityLabel: "unproven",
  buddyNodeIds: [], fullscreen: false, wakeAssistance: "unknown",
  wakeAssistanceReason: null, wakeAssistanceMessage: null,
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
async function setWakeAssistance(wakeAssistance, detail = {}) {
  return emit({
    wakeAssistance,
    wakeAssistanceReason: detail.reason || null,
    wakeAssistanceMessage: detail.message || null,
  });
}
async function isBraveBrowser() {
  try { return !!(navigator.brave?.isBrave && await navigator.brave.isBrave()); }
  catch { return false; }
}
async function reportWakeFailure(error, phase) {
  const setupRequired = !!error?.setupRequired;
  if (setupRequired) {
    return setWakeAssistance("setup needed", {
      reason: "network-setup",
      message: "The network has not configured Node reminders yet.",
    });
  }
  if (phase === "push-subscribe" && Notification.permission === "granted" && await isBraveBrowser()) {
    return setWakeAssistance("brave setup needed", {
      reason: "brave-push-service",
      message: "Brave allowed site notifications, but its push service is unavailable.",
    });
  }
  const messages = {
    "service-worker": "The browser could not start the background worker required for Node reminders. Reload the page, then retry.",
    "push-config": "The Node reminder service could not be reached. Check the connection, then retry.",
    "push-subscribe": "The browser allowed notifications but could not create a push subscription. Restart the browser, then retry.",
    "backend-register": "The browser created a push subscription, but the network could not register it. Check the connection, then retry.",
  };
  return setWakeAssistance("unavailable", {
    reason: phase,
    message: messages[phase] || "Node reminders could not be enabled. Retry in a moment.",
  });
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
    .filter((peer) => runtime?.peerInfo?.(peer.nodeId)?.capabilities?.includes("anchor-control-v3"))
    .sort((left, right) => {
      const l = left.protocol?.metrics?.()?.rttEwmaMs ?? Number.MAX_SAFE_INTEGER;
      const r = right.protocol?.metrics?.()?.rttEwmaMs ?? Number.MAX_SAFE_INTEGER;
      return l - r;
    })
    .slice(0, survivalConfig().buddyCount || 2)
    .map((peer) => peer.nodeId);
}
async function serviceWorkerRegistration({ probe = true } = {}) {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    emit({ serviceWorker: "unsupported" });
    await setWakeAssistance("unsupported");
    return null;
  }
  try {
    const registration = await ensureAppServiceWorker();
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
    if (probe) await probeWakeAssistance(registration);
    return registration;
  } catch (error) {
    emit({ serviceWorker: "failed" });
    await reportWakeFailure(error, "service-worker");
    return null;
  }
}
async function probeWakeAssistance(registration) {
  if (!registration || !("Notification" in window)) return setWakeAssistance("unsupported");
  if (Notification.permission === "denied") return setWakeAssistance("blocked");
  return setWakeAssistance(Notification.permission === "granted" ? "ready" : "available", {
    reason: "local-only",
    message: "Reminders are local to this installed app; no push subscription is sent to a hosted service.",
  });
}
export async function configureWakeAssistance() {
  // Do not emit the passive "available" probe state during an explicit enable
  // action. That intermediate state can re-render the active control before the
  // subscription and Anchor activation have completed.
  const registration = await serviceWorkerRegistration({ probe: false });
  if (!registration) return survivalStatus();
  if (!("Notification" in window)) return setWakeAssistance("unsupported");
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") return setWakeAssistance(permission === "denied" ? "blocked" : "permission needed");
  return setWakeAssistance("ready", {
    reason: "local-only",
    message: "Local reminders are enabled. The browser still controls when the app may run in the background.",
  });
}
export async function disableWakeAssistance() {
  if (!("Notification" in window)) return setWakeAssistance("unsupported");
  return setWakeAssistance(Notification.permission === "denied" ? "blocked" : "available");
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
    wakeAssistanceReady: status.wakeAssistance === "ready",
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
  await serviceWorkerRegistration().catch(() => null);
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
export async function setSurvivalMode(enabled, { fullscreen = false, cacheLimitBytes } = {}) {
  await updateAnchorSettings({ enabled: !!enabled, ...(cacheLimitBytes === undefined ? {} : { cacheLimitBytes }) });
  emit({ enabled: !!enabled });
  if (enabled) {
    await navigator.storage?.persist?.().catch(() => false);
    if (fullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
  return renew(enabled ? "enabled" : "disabled");
}
export async function requestBuddyWake(nodeId) {
  if (!runtime?.nodeId || !nodeId) throw new Error("A connected buddy node is required.");
  throw new Error("Remote wake is unavailable in mesh-only mode. Browsers cannot wake another device without a push provider.");
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
