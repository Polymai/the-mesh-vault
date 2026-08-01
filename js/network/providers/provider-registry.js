import { PROVIDER_KINDS, assertImplementsProvider } from "./provider-types.js";
import { COORDINATION_MODES, providerOrder } from "../coordination-policy.js";

const active = Object.fromEntries(Object.values(PROVIDER_KINDS).map((kind) => [kind, []]));
const availability = new Map();
let coordinationMode = COORDINATION_MODES.SUPABASE_PRIMARY;

export function registerProvider(kind, provider) {
  assertImplementsProvider(provider, kind);
  active[kind].push(provider);
  if (!availability.has(provider.name)) availability.set(provider.name, { up: true, lastCheckedAt: Date.now() });
  return () => { active[kind] = active[kind].filter((entry) => entry !== provider); };
}
export function providersFor(kind) { return active[kind].slice(); }
export function markProviderStatus(name, up) { availability.set(name, { up, lastCheckedAt: Date.now() }); }
export function isProviderUp(name) { return availability.get(name)?.up !== false; }
export function providerStatuses() { return Object.fromEntries(availability); }
export function setCoordinationMode(mode) { coordinationMode = mode || COORDINATION_MODES.SUPABASE_PRIMARY; }
export function getCoordinationMode() { return coordinationMode; }

function routedProviders(kind) {
  const order = providerOrder(coordinationMode, kind);
  return providersFor(kind).slice().sort((left, right) => {
    const leftIndex = order.indexOf(left.name);
    const rightIndex = order.indexOf(right.name);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
  }).filter((provider) => order.includes(provider.name));
}

async function fanOut(kind, method, args, { stopOnFirstSuccess = false } = {}) {
  const results = [];
  for (const provider of routedProviders(kind)) {
    if (!isProviderUp(provider.name)) continue;
    try {
      const result = await provider[method](...args);
      markProviderStatus(provider.name, true);
      results.push({ provider: provider.name, result });
      if (stopOnFirstSuccess && result) return results;
    } catch (error) { markProviderStatus(provider.name, false); results.push({ provider: provider.name, error }); }
  }
  return results;
}

export async function discoverPeers({ minimumCandidates = (typeof window !== "undefined" ? window.__DATA__?.coordination?.minimumPeerCandidates : 8) || 8 } = {}) {
  const results = [];
  const found = new Set();
  for (const provider of routedProviders(PROVIDER_KINDS.PEER_DISCOVERY)) {
    if (!isProviderUp(provider.name)) continue;
    try {
      const result = await provider.discoverPeers();
      markProviderStatus(provider.name, true);
      results.push({ provider: provider.name, result });
      for (const peer of result || []) found.add(peer.peerId || peer.nodeId || peer.id);
      if (found.size >= minimumCandidates) break;
    } catch (error) { markProviderStatus(provider.name, false); results.push({ provider: provider.name, error }); }
  }
  return results;
}
export async function sendSignal(...args) { return fanOut(PROVIDER_KINDS.SIGNALING, "sendSignal", args, { stopOnFirstSuccess: true }); }
export async function publishPresence(...args) { return fanOut(PROVIDER_KINDS.PRESENCE, "publishPresence", args, { stopOnFirstSuccess: true }); }
export async function lookupManifest(manifestOrFileId) {
  const results = await fanOut(PROVIDER_KINDS.MANIFEST_DISCOVERY, "lookupManifest", [manifestOrFileId], { stopOnFirstSuccess: true });
  return results.find((entry) => entry.result)?.result || null;
}
export async function announceManifest(...args) { return fanOut(PROVIDER_KINDS.MANIFEST_DISCOVERY, "announceManifest", args); }
export async function lookupFragmentLocations(shardHash) {
  const results = await fanOut(PROVIDER_KINDS.FRAGMENT_DISCOVERY, "lookupFragmentLocations", [shardHash]);
  return results.flatMap((entry) => entry.result || []);
}
export async function announceFragmentLocation(...args) { return fanOut(PROVIDER_KINDS.FRAGMENT_DISCOVERY, "announceFragmentLocation", args); }
export async function getNetworkStats() {
  const results = await fanOut(PROVIDER_KINDS.NETWORK_STATS, "getNetworkStats", []);
  return results.map((entry) => entry.result).filter(Boolean);
}
export async function discoverAccount(...args) { return fanOut(PROVIDER_KINDS.ACCOUNT_DISCOVERY, "discoverAccount", args); }

export function onSignal(handler) { const unsubs = providersFor(PROVIDER_KINDS.SIGNALING).map((provider) => provider.onSignal(handler)); return () => unsubs.forEach((unsub) => unsub?.()); }
export function onPresence(handler) { const unsubs = providersFor(PROVIDER_KINDS.PRESENCE).map((provider) => provider.onPresence(handler)); return () => unsubs.forEach((unsub) => unsub?.()); }
