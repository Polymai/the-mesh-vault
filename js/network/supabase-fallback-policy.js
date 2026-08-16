let verifiedMeshRoute = false;
let fallbackWindowUntil = 0;
let activeNodeId = "";
let patientZeroListener = false;
let operatorRequestDepth = 0;
let bootstrapCompletedThisLifecycle = false;
let lastFallbackAttemptAt = 0;

function config() { return globalThis.window?.__DATA__?.coordination || {}; }

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
  bootstrapCompletedThisLifecycle = false;
  lastFallbackAttemptAt = 0;
  return supabaseBootstrapState();
}

export function supabaseBootstrapCompleted(nodeId = activeNodeId) {
  if (!nodeId || patientZeroListener) return false;
  return bootstrapCompletedThisLifecycle;
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
  if (activeNodeId && !patientZeroListener) bootstrapCompletedThisLifecycle = true;
  return supabaseBootstrapState();
}

export function supabaseAutomaticFallbackEnabled() {
  return config().supabaseAutomaticFallbackEnabled === true;
}

export function supabaseFallbackWindowOpen(now = Date.now()) {
  return !verifiedMeshRoute && !supabaseBootstrapCompleted() && now < fallbackWindowUntil;
}

export function openSupabaseFallbackWindow({ force = false, now = Date.now() } = {}) {
  // An ordinary device gets one bounded first-contact window during this app
  // lifecycle. It cannot reopen after a verified peer disconnects, but a later
  // cold start may use the gate again when no cached mesh route is reachable.
  // Patient Zero is the sole force=true caller and keeps only the listener.
  if (!force && !supabaseAutomaticFallbackEnabled()) return false;
  if (supabaseBootstrapCompleted()) return false;
  if (verifiedMeshRoute && !force) return false;
  if (supabaseFallbackWindowOpen(now)) return true;
  const cooldownMs = Math.max(60000, Number(config().supabaseFallbackCooldownMs || 1800000));
  if (!force && lastFallbackAttemptAt > 0 && now - lastFallbackAttemptAt < cooldownMs) return false;
  fallbackWindowUntil = now + Math.max(10000, Number(config().supabaseFallbackWindowMs || 30000));
  lastFallbackAttemptAt = now;
  return true;
}

export function closeSupabaseFallbackWindow() { fallbackWindowUntil = 0; }

export function supabaseProviderAllowed() {
  return patientZeroListener || supabaseFallbackWindowOpen();
}

export async function withPatientZeroOperatorRequest(callback) {
  operatorRequestDepth += 1;
  try { return await callback(); }
  finally { operatorRequestDepth = Math.max(0, operatorRequestDepth - 1); }
}


// The hosted service is a first-contact signaling gate, never a data plane.
// This allow-list is deliberately smaller than the generated Supabase schema:
// files, manifests, shard placements, repairs, network overviews and settings
// cannot cross the boundary even while the cold-start window is open.
export function supabaseRequestAllowed(input, { method = "GET" } = {}) {
  let path = "";
  try { path = new URL(input?.url || input, globalThis.location?.href || "https://invalid.local").pathname; }
  catch { path = String(input?.url || input || ""); }
  const normalized = path.toLowerCase();
  const requestMethod = String(method || "GET").toUpperCase();
  if (operatorRequestDepth > 0 && requestMethod === "POST" && (
    normalized.includes("/functions/v1/app717-meshvault-api")
    || normalized.includes("/rest/v1/rpc/get_patient_zero_authority_bundle")
  )) return true;
  if (!supabaseProviderAllowed()) return false;
  if (normalized.includes("/auth/v1/")) return true;
  if (normalized.includes("/rest/v1/nodes")) return ["POST", "PATCH", "DELETE"].includes(requestMethod);
  if (requestMethod !== "POST") return false;
  return [
    "discover_bootstrap_gateways",
    "get_patient_zero_authority_bundle",
    "get_node_signal_topic",
    "send_mesh_signal",
  ].some((rpc) => normalized.includes(`/rest/v1/rpc/${rpc}`));
}
