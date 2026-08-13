import { appConfig } from "../services/supabase.js";

const BRIDGE_VERSION = 2;
const PROTOCOL_VERSION = 3;
const MAX_CONTRIBUTION_BYTES = 250 * 1024 * 1024 * 1024;
let cached = null;

function plugin() {
  return window.Capacitor?.Plugins?.PolymaiBackground || null;
}

function bridgeAdvertised() {
  return /(?:^|\s)PolymaiNativeBridge\/2(?:\s|$)/.test(navigator.userAgent || "") || !!plugin();
}

function parseSnapshot(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function normalize(result = {}) {
  const snapshot = parseSnapshot(result.snapshot);
  const supported = bridgeAdvertised() && !!plugin() && Number(snapshot.bridgeVersion || BRIDGE_VERSION) >= BRIDGE_VERSION;
  return {
    supported,
    enabled: supported && !!result.enabled,
    running: supported && !!result.running,
    status: supported ? String(result.status || snapshot.state || "Stopped") : "Browser only",
    state: supported ? String(snapshot.state || (result.running ? "running" : "stopped")) : "unsupported",
    protocolVersion: Number(snapshot.protocolVersion || 0),
    bridgeVersion: Number(snapshot.bridgeVersion || 0),
    nodeId: snapshot.nodeId || null,
    vaultId: snapshot.vaultId || null,
    label: snapshot.label || null,
    anchor: !!snapshot.anchor,
    capacityBytes: Math.max(0, Number(snapshot.capacityBytes) || 0),
    usedBytes: Math.max(0, Number(snapshot.usedBytes) || 0),
    shardCount: Math.max(0, Number(snapshot.shardCount) || 0),
    controlCount: Math.max(0, Number(snapshot.controlCount) || 0),
    controlBytes: Math.max(0, Number(snapshot.controlBytes) || 0),
    peerCount: Math.max(0, Number(snapshot.peerCount) || 0),
    lastHeartbeatAt: Math.max(0, Number(snapshot.lastHeartbeatAt) || 0),
    lastError: snapshot.lastError || null,
    keysAccepted: snapshot.keysAccepted === true,
  };
}

export async function nativeNodeStatus({ refresh = false } = {}) {
  if (!refresh && cached) return cached;
  const bridge = plugin();
  if (!bridgeAdvertised() || !bridge?.status) {
    cached = normalize();
    return cached;
  }
  try { cached = normalize(await bridge.status()); }
  catch { cached = normalize(); }
  return cached;
}

export function nativeNodeConfiguration(state, contributionLimitBytes) {
  const capacityBytes = Math.min(MAX_CONTRIBUTION_BYTES, Math.max(0, Number(contributionLimitBytes) || 0));
  const node = state?.node || {};
  const anchor = state?.anchor || {};
  return {
    protocolVersion: PROTOCOL_VERSION,
    supabaseUrl: appConfig.url,
    publishableKey: appConfig.anonKey,
    functionsUrl: appConfig.functionsBaseUrl,
    vaultId: state?.identity?.vaultId || null,
    label: String(node.label || anchor.nodeName || "Android node").slice(0, 80),
    countryCode: node.countryCode || null,
    regionCode: node.regionCode || null,
    networkDomainHash: null,
    capacityBytes,
    anchorEnabled: !!anchor.enabled,
    controlCapacityBytes: Number(anchor.cacheLimitBytes) || 100 * 1024 * 1024,
    restartAfterBoot: true,
    iceServers: [],
  };
}

function requirePlugin() {
  const bridge = plugin();
  if (!bridgeAdvertised() || !bridge) throw new Error("Install the Android app to use screen-off storage.");
  return bridge;
}

export async function configureNativeNode(state, contributionLimitBytes) {
  const bridge = requirePlugin();
  const result = await bridge.configure({ configuration: nativeNodeConfiguration(state, contributionLimitBytes) });
  cached = normalize(result);
  return cached;
}

export async function startNativeNode(state, contributionLimitBytes) {
  const bridge = requirePlugin();
  const result = await bridge.start({ configuration: nativeNodeConfiguration(state, contributionLimitBytes) });
  cached = normalize(result);
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  return nativeNodeStatus({ refresh: true });
}

export async function stopNativeNode() {
  const bridge = requirePlugin();
  const result = await bridge.stop();
  cached = normalize(result);
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  return nativeNodeStatus({ refresh: true });
}

export async function restartNativeNode(state, contributionLimitBytes) {
  const current = await nativeNodeStatus({ refresh: true });
  if (!current.enabled && !current.running) return configureNativeNode(state, contributionLimitBytes);
  await stopNativeNode();
  await new Promise((resolve) => window.setTimeout(resolve, 650));
  return startNativeNode(state, contributionLimitBytes);
}

export async function openNativePowerSettings() {
  const bridge = requirePlugin();
  await bridge.openPowerSettings();
}

export async function clearNativeNodeStorage() {
  const bridge = requirePlugin();
  const result = await bridge.clearStorage();
  cached = normalize(result);
  return { ...cached, removed: Math.max(0, Number(result.removed) || 0) };
}

export function isNativeBackgroundActive(status = cached) {
  return !!status?.supported && (!!status.enabled || !!status.running);
}
