const FALLBACK_KEY_SUFFIX = "supabase-fallback-at-v3";
const BOOTSTRAP_COMPLETE_SUFFIX = "supabase-bootstrap-complete-v3";

let verifiedMeshRoute = false;
let fallbackWindowUntil = 0;
let activeNodeId = "";
let patientZeroListener = false;

function config() { return globalThis.window?.__DATA__?.coordination || {}; }
function storageKey() { return `${globalThis.window?.__DATA__?.appStoragePrefix || "polymai:app717:"}${FALLBACK_KEY_SUFFIX}`; }
function completionKey(nodeId = activeNodeId) {
  return `${globalThis.window?.__DATA__?.appStoragePrefix || "polymai:app717:"}${BOOTSTRAP_COMPLETE_SUFFIX}:${nodeId || "unbound"}`;
}
function lastFallbackAt() {
  try { return Math.max(0, Number(sessionStorage.getItem(storageKey())) || 0); }
  catch { return 0; }
}
function rememberFallback(at) {
  try { sessionStorage.setItem(storageKey(), String(at)); } catch {}
}

export function setVerifiedMeshRoute(ready) {
  verifiedMeshRoute = !!ready;
  return verifiedMeshRoute;
}

export function hasVerifiedMeshRoute() { return verifiedMeshRoute; }

export function configureSupabaseBootstrapPolicy({ nodeId = "", patientZero = false } = {}) {
  activeNodeId = String(nodeId || "");
  patientZeroListener = patientZero === true;
  verifiedMeshRoute = false;
  fallbackWindowUntil = 0;
  return supabaseBootstrapState();
}

export function supabaseBootstrapCompleted(nodeId = activeNodeId) {
  if (!nodeId || patientZeroListener) return false;
  try { return !!localStorage.getItem(completionKey(nodeId)); }
  catch { return false; }
}

export function supabaseBootstrapState() {
  return Object.freeze({
    nodeId: activeNodeId || null,
    completed: supabaseBootstrapCompleted(),
    patientZeroListener,
    windowOpen: supabaseFallbackWindowOpen(),
  });
}

export function markSupabaseBootstrapComplete() {
  verifiedMeshRoute = true;
  fallbackWindowUntil = 0;
  if (activeNodeId && !patientZeroListener) {
    try { localStorage.setItem(completionKey(), new Date().toISOString()); } catch {}
  }
  return supabaseBootstrapState();
}

export function supabaseAutomaticFallbackEnabled() {
  return config().supabaseAutomaticFallbackEnabled === true;
}

export function supabaseFallbackWindowOpen(now = Date.now()) {
  return !verifiedMeshRoute && !supabaseBootstrapCompleted() && now < fallbackWindowUntil;
}

export function openSupabaseFallbackWindow({ force = false, now = Date.now() } = {}) {
  // An ordinary device gets one bounded first-contact window until it has
  // verified a mesh peer. Completion is persisted and can never be reopened
  // by a timer, focus event or later peer failure. Patient Zero is the sole
  // force=true caller and keeps only the first-contact listener.
  if (!force && !supabaseAutomaticFallbackEnabled()) return false;
  if (supabaseBootstrapCompleted()) return false;
  if (verifiedMeshRoute && !force) return false;
  if (supabaseFallbackWindowOpen(now)) return true;
  const cooldownMs = Math.max(60000, Number(config().supabaseFallbackCooldownMs || 1800000));
  if (!force && now - lastFallbackAt() < cooldownMs) return false;
  fallbackWindowUntil = now + Math.max(10000, Number(config().supabaseFallbackWindowMs || 30000));
  rememberFallback(now);
  return true;
}

export function closeSupabaseFallbackWindow() { fallbackWindowUntil = 0; }

export function supabaseProviderAllowed() {
  return patientZeroListener || supabaseFallbackWindowOpen();
}


// The hosted service is a first-contact signaling gate, never a data plane.
// This allow-list is deliberately smaller than the generated Supabase schema:
// files, manifests, shard placements, repairs, network overviews and settings
// cannot cross the boundary even while the cold-start window is open.
export function supabaseRequestAllowed(input, { method = "GET" } = {}) {
  if (!supabaseProviderAllowed()) return false;
  let path = "";
  try { path = new URL(input?.url || input, globalThis.location?.href || "https://invalid.local").pathname; }
  catch { path = String(input?.url || input || ""); }
  const normalized = path.toLowerCase();
  const requestMethod = String(method || "GET").toUpperCase();
  if (normalized.includes("/auth/v1/")) return true;
  if (normalized.includes("/rest/v1/nodes")) return ["POST", "PATCH", "DELETE"].includes(requestMethod);
  if (requestMethod !== "POST") return false;
  return [
    "discover_bootstrap_gateways",
    "get_node_signal_topic",
    "send_mesh_signal",
  ].some((rpc) => normalized.includes(`/rest/v1/rpc/${rpc}`));
}
