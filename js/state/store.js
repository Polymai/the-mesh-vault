const initialState = Object.freeze({
  boot: "loading", identity: null, storageNodeOnly: false, accountLink: null, route: "home",
  mobileNavOpen: false, notice: null, files: [], pendingDeletions: [], folders: [], nodes: [], transfers: [], myStorageNodeIds: [],
  vaultProfile: { name: "", synced: false, syncStatus: "not-set" }, erasureClass: "standard",
  network: { activeNodes: 0, verifiedCapacity: 0, usedBytes: 0, resilientBytes: 0, snapshots: [], events: [] },
  vaultStorage: { uniqueSegments: 0, uniqueOriginalBytes: 0, representationBytes: 0, compressionSavedBytes: 0, physicalBytes: 0, physicalShardCopies: 0, surplusPlacements: 0, profiles: [] },
  node: { id: null, label: "Browser node", status: "offline", capacityBytes: 0, usedBytes: 0, persistence: "unknown", countryCode: null, regionCode: null, locationSource: null, locationUpdatedAt: null },
  anchor: { enabled: false, status: "off", nodeName: "Browser node", cacheLimitBytes: 104857600, bytesUsed: 0, objectCount: 0, replicatedObjects: 0, connectedAnchors: 0, coordinationMode: "supabase-primary", fallbackActive: true, wakeLock: "released", warmIndependent: false },
  survival: { enabled: false, lifecycle: "stopped", leaseExpiresAt: null, leaseRemainingMs: 0, uptimeSeconds: 0, reliabilityScore: 0, reliabilityLabel: "unproven", buddyNodeIds: [], fullscreen: false, wakeAssistance: "unknown", wakeAssistanceReason: null, wakeAssistanceMessage: null, serviceWorker: "unsupported", backgroundSync: "unsupported", lastHandoffAt: null },
  pwaInstall: { installed: false, available: false, prompting: false, platform: "other", displayMode: "browser", lastOutcome: null },
  activeTasks: {}, error: null,
});
let state = structuredClone(initialState);
const listeners = new Set();

export const getState = () => state;
export function setState(patch) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((listener) => listener(state));
  return state;
}
export function updateNested(key, patch) {
  return setState({ [key]: { ...state[key], ...(typeof patch === "function" ? patch(state[key]) : patch) } });
}
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function resetPrivateState() {
  state = { ...structuredClone(initialState), boot: "ready", route: "home" };
  listeners.forEach((listener) => listener(state));
}
export function announce(message, tone = "info", timeout = 5000) {
  const id = crypto.randomUUID();
  setState({ notice: { id, message, tone } });
  if (timeout) window.setTimeout(() => { if (state.notice?.id === id) setState({ notice: null }); }, timeout);
}
