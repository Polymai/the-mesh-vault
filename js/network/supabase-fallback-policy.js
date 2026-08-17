let verifiedMeshRoute = false;
let fallbackWindowUntil = 0;
let activeNodeId = "";
let patientZeroListener = false;
let operatorRequestDepth = 0;
let patientZeroAuthorityReadDepth = 0;
let nodeRegistrationRecoveryDepth = 0;
let bootstrapCompletedThisLifecycle = false;
let fallbackAttemptedThisLifecycle = false;
let policyConfigured = false;

function config() { return globalThis.window?.__DATA__?.coordination || {}; }

export function setVerifiedMeshRoute(ready) {
  verifiedMeshRoute = !!ready;
  return verifiedMeshRoute;
}

export function hasVerifiedMeshRoute() { return verifiedMeshRoute; }

export function configureSupabaseBootstrapPolicy({ nodeId = "", patientZero = false } = {}) {
  const nextNodeId = String(nodeId || "");
  const nextPatientZero = patientZero === true;
  // UI reactivation, a native-status refresh, or another call to startDevice
  // can configure the same browser node more than once without creating a new
  // JavaScript lifecycle. Preserve the one-shot first-contact state in that
  // case. A different node/profile is the only reason to reset the gate.
  if (policyConfigured && activeNodeId === nextNodeId && patientZeroListener === nextPatientZero) {
    return supabaseBootstrapState();
  }
  activeNodeId = nextNodeId;
  patientZeroListener = nextPatientZero;
  verifiedMeshRoute = false;
  fallbackWindowUntil = 0;
  bootstrapCompletedThisLifecycle = false;
  fallbackAttemptedThisLifecycle = false;
  policyConfigured = true;
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
    attempted: fallbackAttemptedThisLifecycle,
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
  if (!force && fallbackAttemptedThisLifecycle) return false;
  fallbackWindowUntil = now + Math.max(10000, Number(config().supabaseFallbackWindowMs || 30000));
  if (!force) fallbackAttemptedThisLifecycle = true;
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

export async function withPatientZeroAuthorityRead(callback) {
  // The signed public authority chain must be known before the runtime can
  // decide whether this device is Patient Zero. This scope permits exactly
  // that authenticated read; it does not open discovery, signaling, tables,
  // files, manifests, placements or any other hosted API.
  patientZeroAuthorityReadDepth += 1;
  try { return await callback(); }
  finally { patientZeroAuthorityReadDepth = Math.max(0, patientZeroAuthorityReadDepth - 1); }
}

export async function withNodeRegistrationRecoveryRequest(callback) {
  // A persistent browser node can outlive its anonymous Supabase session. The
  // registration reclaim endpoint is permitted only inside this explicit,
  // short-lived scope; it does not reopen the hosted provider or its RPCs.
  nodeRegistrationRecoveryDepth += 1;
  try { return await callback(); }
  finally { nodeRegistrationRecoveryDepth = Math.max(0, nodeRegistrationRecoveryDepth - 1); }
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
  if (requestMethod === "POST"
    && normalized.includes("/functions/v1/app717-meshvault-api")
    && (operatorRequestDepth > 0 || nodeRegistrationRecoveryDepth > 0)) return true;
  if (operatorRequestDepth > 0 && requestMethod === "POST"
    && normalized.includes("/rest/v1/rpc/get_patient_zero_authority_bundle")) return true;
  if (patientZeroAuthorityReadDepth > 0) {
    if (normalized.includes("/auth/v1/")) return true;
    return requestMethod === "POST"
      && normalized.includes("/rest/v1/rpc/get_patient_zero_authority_bundle");
  }
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
