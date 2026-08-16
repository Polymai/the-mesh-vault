import { byteLength, describeSupabaseRequest, recordDataFlow } from "../observability/data-flow-log.js";
import { supabaseRequestAllowed } from "../network/supabase-fallback-policy.js";

const runtimeConfig = window.__POLYMAI_SUPABASE_CONFIG__ || {};
if (!runtimeConfig.url || !runtimeConfig.anonKey) throw new Error("TheMeshVault is not configured yet.");
if (!window.supabase?.createClient) throw new Error("The secure data client could not be loaded.");

export async function supabaseFetch(input, init = {}) {
  const method = String(init?.method || input?.method || "GET").toUpperCase();
  const body = init?.body ?? null;
  const kind = describeSupabaseRequest(input?.url || input, method, body);
  if (!supabaseRequestAllowed(input, { method })) {
    // Return a normal HTTP response so existing generated callers can fall
    // back to the signed local catalog without producing an external packet.
    return new Response(JSON.stringify({
      code: "MESH_ONLY",
      message: "Hosted access is closed after the first verified mesh connection.",
    }), { status: 409, headers: { "content-type": "application/json" } });
  }
  const outboundBytes = byteLength(body);
  if (method !== "GET" && method !== "HEAD") recordDataFlow({ route: "supabase", direction: "out", kind, bytes: outboundBytes, counterparty: "Supabase", transport: "HTTPS" });
  const response = await globalThis.fetch(input, init);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 0) {
    recordDataFlow({ route: "supabase", direction: "in", kind, bytes: contentLength, counterparty: "Supabase", transport: "HTTPS" });
  } else if (response.status !== 204 && method !== "HEAD") {
    response.clone().arrayBuffer().then((buffer) => {
      recordDataFlow({ route: "supabase", direction: "in", kind, bytes: buffer.byteLength, counterparty: "Supabase", transport: "HTTPS" });
    }).catch(() => {});
  }
  return response;
}

export const supabase = window.supabase.createClient(runtimeConfig.url, runtimeConfig.anonKey, {
  global: { fetch: supabaseFetch },
  auth: {
    storageKey: runtimeConfig.authStorageKey,
    persistSession: true,
    // A silent token refresh would violate the bounded lifecycle bootstrap boundary.
    // Explicit optional-account clients are created separately when requested.
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  db: { schema: "app717_meshvault" },
});
export const appConfig = Object.freeze({ ...runtimeConfig, schema: "app717_meshvault" });
export function appTable(name) { return supabase.from(name); }
let anonymousSessionPromise = null;
export async function currentAccessToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || "";
}
export async function currentAuthUserId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id || null;
}
export async function ensureAnonymousSession({ refreshIfExpiring = false } = {}) {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    const expiresAt = Number(data.session.expires_at || 0) * 1000;
    if (!refreshIfExpiring || !expiresAt || expiresAt - Date.now() > 5 * 60 * 1000) return data.session;
    const { data: refreshed, error } = await supabase.auth.refreshSession();
    if (error || !refreshed.session) throw new Error("Patient Zero could not renew its first-contact listener.");
    return refreshed.session;
  }
  if (anonymousSessionPromise) return anonymousSessionPromise;
  anonymousSessionPromise = (async () => {
    const { data: existing } = await supabase.auth.getSession();
    if (existing.session) return existing.session;
    const { data: signedIn, error } = await supabase.auth.signInAnonymously();
    if (error) throw new Error("Could not start a session in TheMeshVault.");
    return signedIn.session;
  })();
  try { return await anonymousSessionPromise; }
  finally { anonymousSessionPromise = null; }
}

export async function clearAnonymousSessionLocally() {
  // Called only while the bounded hosted window for this lifecycle is open. Supabase may
  // receive this final logout request, after which its local session is gone.
  await supabase.auth.signOut({ scope: "local" }).catch(() => {});
}
