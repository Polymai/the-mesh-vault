const runtimeConfig = window.__POLYMAI_SUPABASE_CONFIG__ || {};
if (!runtimeConfig.url || !runtimeConfig.anonKey) throw new Error("TheMeshVault is not configured yet.");
if (!window.supabase?.createClient) throw new Error("The secure data client could not be loaded.");

export const supabase = window.supabase.createClient(runtimeConfig.url, runtimeConfig.anonKey, {
  auth: {
    storageKey: runtimeConfig.authStorageKey,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  db: { schema: "app717_meshvault" },
});
export const appConfig = Object.freeze({ ...runtimeConfig, schema: "app717_meshvault" });
export function appTable(name) { return supabase.from(name); }
export async function currentAccessToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || "";
}
export async function currentAuthUserId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id || null;
}
export async function ensureAnonymousSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { data: signedIn, error } = await supabase.auth.signInAnonymously();
  if (error) throw new Error("Could not start a session in TheMeshVault.");
  return signedIn.session;
}
