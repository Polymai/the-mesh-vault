// Polymai runtime Supabase config.
// Frontend-safe only: Project URL, publishable API key, public Functions base URL, public site URL, and app-scoped browser storage ids.
// Never add secret API keys, service role keys, DB passwords, or connection strings here.
(function () {
  const config = Object.freeze({
    appId: "app717",
    url: "https://pfnlebwkbhblytpvaokd.supabase.co",
    anonKey: "sb_publishable_O8CemBWuZAjQDC6gSkNq9Q_wAmDtHiv",
    functionsBaseUrl: "https://pfnlebwkbhblytpvaokd.supabase.co/functions/v1",
    siteUrl: "https://polymai.github.io/the-mesh-vault/",
    appStoragePrefix: "polymai:app717:",
    authStorageKey: "polymai:app717:pfnlebwkbhblytpvaokd:auth",
  });
  window.__POLYMAI_SUPABASE_CONFIG__ = config;
  window.__SUPABASE_CONFIG__ = config;
})();
