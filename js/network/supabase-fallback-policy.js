const FALLBACK_KEY_SUFFIX = "supabase-fallback-at-v3";

let verifiedMeshRoute = false;
let fallbackWindowUntil = 0;

function config() { return globalThis.window?.__DATA__?.coordination || {}; }
function storageKey() { return `${globalThis.window?.__DATA__?.appStoragePrefix || "polymai:app717:"}${FALLBACK_KEY_SUFFIX}`; }
function lastFallbackAt() {
  try { return Math.max(0, Number(sessionStorage.getItem(storageKey())) || 0); }
  catch { return 0; }
}
function rememberFallback(at) {
  try { sessionStorage.setItem(storageKey(), String(at)); } catch {}
}

export function setVerifiedMeshRoute(ready) {
  verifiedMeshRoute = !!ready;
  if (verifiedMeshRoute) fallbackWindowUntil = 0;
  return verifiedMeshRoute;
}

export function hasVerifiedMeshRoute() { return verifiedMeshRoute; }

export function supabaseAutomaticFallbackEnabled() {
  return config().supabaseAutomaticFallbackEnabled === true;
}

export function supabaseFallbackWindowOpen(now = Date.now()) {
  return !verifiedMeshRoute && now < fallbackWindowUntil;
}

export function openSupabaseFallbackWindow({ force = false, now = Date.now() } = {}) {
  // Deployments with a pinned distributed rendezvous route remain genuinely
  // mesh-first: a timer, focus event or failed peer attempt may not silently
  // turn Supabase back into the transport. A future explicit recovery action
  // may opt in with force=true without changing this steady-state contract.
  if (!force && !supabaseAutomaticFallbackEnabled()) return false;
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
  return supabaseFallbackWindowOpen();
}
