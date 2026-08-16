import { appTable, appConfig, currentAccessToken, ensureAnonymousSession, supabase, supabaseFetch } from "./supabase.js";

// The overview is a bounded rendering sample, not an export of the network.
const MESH_VIEW_NODE_LIMIT = 96;
const SNAPSHOT_LIMIT = 48;
const overviewCache = new Map();
const overviewPromises = new Map();
const ICE_CACHE_KEY = `${window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:"}peer-ice-config-v3`;
const ICE_CACHE_MS = 5 * 60 * 1000;

function cachedIceConfig() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(ICE_CACHE_KEY) || "null");
    return cached?.value && Date.now() - Number(cached.at || 0) < ICE_CACHE_MS ? cached.value : null;
  } catch { return null; }
}

export async function getPeerIceConfig(timeoutMs = 15000) {
  const cached = cachedIceConfig();
  if (cached) return cached;
  let accessToken = await currentAccessToken();
  if (!accessToken) accessToken = (await ensureAnonymousSession())?.access_token || "";
  if (!accessToken) throw new Error("Sign in is required to connect this device.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await supabaseFetch(`${appConfig.functionsBaseUrl}/app717-meshvault-api`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: appConfig.anonKey },
      body: JSON.stringify({ action: "turn-credentials", clientProtocolVersion: 3 }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not load peer connection settings.");
    try { sessionStorage.setItem(ICE_CACHE_KEY, JSON.stringify({ at: Date.now(), value: result })); } catch {}
    return result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Peer connection settings timed out.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadNetworkOverviewFallback({ includeNodes = true } = {}) {
  const ordinaryCutoff = Date.now() - Number(window.__DATA__?.resilience?.nodeStaleMs || 120000);
  const backboneCutoff = Date.now() - Number(window.__DATA__?.coordination?.supabaseBackboneLeaseMs || 900000);
  const visibleNode = (node) => node.status === "online"
    && Date.parse(node.last_seen_at || 0) >= (node.survival_mode ? backboneCutoff : ordinaryCutoff)
    && (!node.survival_mode || Date.parse(node.lease_expires_at || 0) > Date.now());
  // The node list here is a bounded sample for rendering only - it is never
  // the source of the activeNodes/verifiedCapacity totals below, so those
  // stay honest regardless of how many nodes actually exist network-wide.
  let nodesQuery = includeNodes
    ? appTable("nodes").select("id,vault_id,device_public_key,failure_domain_id,device_label,status,reliability_score,survival_mode,lifecycle_state,lease_expires_at,uptime_seconds,wake_lock_active,buddy_node_ids,last_handoff_at,capacity_bytes,used_bytes,country_code,region_code,network_domain_hash,location_source,location_updated_at,last_seen_at").eq("status", "online").order("last_seen_at", { ascending: false }).limit(MESH_VIEW_NODE_LIMIT)
    : Promise.resolve({ data: [], error: null });
  let [nodesResult, eventsResult, snapshotsResult, totalsResult] = await Promise.all([
    nodesQuery,
    appTable("network_events").select("id,event_type,created_at").order("created_at", { ascending: false }).limit(6),
    appTable("network_snapshots").select("id,active_nodes,verified_capacity_bytes,used_bytes,resilient_bytes,captured_at").gte("captured_at", new Date(Date.now() - 86400000).toISOString()).order("captured_at", { ascending: false }).limit(SNAPSHOT_LIMIT),
    supabase.schema("app717_meshvault").rpc("network_totals").maybeSingle(),
  ]);
  if (includeNodes && nodesResult.error && /country_code|region_code|network_domain_hash|location_source|survival_mode|lifecycle_state|lease_expires_at|uptime_seconds|wake_lock_active|buddy_node_ids|last_handoff_at/i.test(`${nodesResult.error.message || ""} ${nodesResult.error.details || ""}`)) nodesResult = await appTable("nodes").select("id,vault_id,device_public_key,failure_domain_id,device_label,status,reliability_score,capacity_bytes,used_bytes,last_seen_at").eq("status", "online").order("last_seen_at", { ascending: false }).limit(MESH_VIEW_NODE_LIMIT);
  if (nodesResult.error) throw nodesResult.error; if (eventsResult.error) throw eventsResult.error; if (snapshotsResult.error) throw snapshotsResult.error;
  const nodes = (nodesResult.data || []).filter(visibleNode); const totals = totalsResult.data || {};
  return {
    nodes, events: eventsResult.data || [], snapshots: [...(snapshotsResult.data || [])].reverse(),
    activeNodes: Number(totals.active_nodes || 0),
    verifiedCapacity: Number(totals.total_capacity_bytes || 0),
    usedBytes: Number(totals.total_used_bytes || 0),
  };
}

export async function loadNetworkOverview({ force = false, includeNodes = true } = {}) {
  const cacheKey = includeNodes ? "full" : "totals";
  const cacheMs = Math.max(30000, Number(window.__DATA__?.coordination?.networkOverviewCacheMs || 120000));
  const cached = overviewCache.get(cacheKey);
  if (!force && cached?.value && Date.now() - cached.at < cacheMs) return cached.value;
  if (!force && overviewPromises.has(cacheKey)) return overviewPromises.get(cacheKey);
  const request = (async () => {
    const { data, error } = await supabase.schema("app717_meshvault").rpc("load_network_overview", {
      p_node_limit: includeNodes ? MESH_VIEW_NODE_LIMIT : 0,
      p_snapshot_limit: SNAPSHOT_LIMIT,
    });
    let value;
    if (error || !data || !Array.isArray(data.nodes)) value = await loadNetworkOverviewFallback({ includeNodes });
    else value = {
      nodes: data.nodes || [],
      events: data.events || [],
      snapshots: data.snapshots || [],
      activeNodes: Number(data.active_nodes || 0),
      verifiedCapacity: Number(data.total_capacity_bytes || 0),
      usedBytes: Number(data.total_used_bytes || 0),
    };
    overviewCache.set(cacheKey, { at: Date.now(), value });
    return value;
  })();
  overviewPromises.set(cacheKey, request);
  try { return await request; }
  finally { if (overviewPromises.get(cacheKey) === request) overviewPromises.delete(cacheKey); }
}
export async function writeNetworkEvent(vaultId, eventType, details = {}) {
  const { error } = await appTable("network_events").insert({ vault_id: vaultId, event_type: eventType, details }); if (error) throw error;
}
export async function writeSnapshot(vaultId, snapshot) {
  const values = { vault_id: vaultId, active_nodes: snapshot.activeNodes, verified_capacity_bytes: snapshot.verifiedCapacity, used_bytes: snapshot.usedBytes, resilient_bytes: snapshot.resilientBytes || 0 };
  const { error } = await appTable("network_snapshots").insert(values); if (error) throw error;
}
