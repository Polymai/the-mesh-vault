import { appTable, appConfig, currentAccessToken, supabase } from "./supabase.js";

const MESH_VIEW_NODE_LIMIT = 60;

export async function getPeerIceConfig(timeoutMs = 15000) {
  const accessToken = await currentAccessToken();
  if (!accessToken) throw new Error("Sign in is required to connect this device.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${appConfig.functionsBaseUrl}/app717-meshvault-api`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: appConfig.anonKey },
      body: JSON.stringify({ action: "turn-credentials" }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not load peer connection settings.");
    return result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Peer connection settings timed out.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function loadNetworkOverview() {
  const cutoff = new Date(Date.now() - 120000).toISOString();
  // The node list here is a bounded sample for rendering only - it is never
  // the source of the activeNodes/verifiedCapacity totals below, so those
  // stay honest regardless of how many nodes actually exist network-wide.
  let nodesQuery = appTable("nodes").select("id,vault_id,device_public_key,failure_domain_id,device_label,status,reliability_score,survival_mode,lifecycle_state,lease_expires_at,uptime_seconds,wake_lock_active,buddy_node_ids,last_handoff_at,capacity_bytes,used_bytes,country_code,region_code,network_domain_hash,location_source,location_updated_at,last_seen_at").gte("last_seen_at", cutoff).order("last_seen_at", { ascending: false }).limit(MESH_VIEW_NODE_LIMIT);
  let [nodesResult, eventsResult, snapshotsResult, totalsResult] = await Promise.all([
    nodesQuery,
    appTable("network_events").select("*").order("created_at", { ascending: false }).limit(12),
    appTable("network_snapshots").select("*").gte("captured_at", new Date(Date.now() - 86400000).toISOString()).order("captured_at"),
    supabase.schema("app717_meshvault").rpc("network_totals").maybeSingle(),
  ]);
  if (nodesResult.error && /country_code|region_code|network_domain_hash|location_source|survival_mode|lifecycle_state|lease_expires_at|uptime_seconds|wake_lock_active|buddy_node_ids|last_handoff_at/i.test(`${nodesResult.error.message || ""} ${nodesResult.error.details || ""}`)) nodesResult = await appTable("nodes").select("id,vault_id,device_public_key,failure_domain_id,device_label,status,reliability_score,capacity_bytes,used_bytes,last_seen_at").gte("last_seen_at", cutoff).order("last_seen_at", { ascending: false }).limit(MESH_VIEW_NODE_LIMIT);
  if (nodesResult.error) throw nodesResult.error; if (eventsResult.error) throw eventsResult.error; if (snapshotsResult.error) throw snapshotsResult.error;
  const nodes = nodesResult.data || []; const totals = totalsResult.data || {};
  return {
    nodes, events: eventsResult.data || [], snapshots: snapshotsResult.data || [],
    activeNodes: Number(totals.active_nodes || 0),
    verifiedCapacity: Number(totals.total_capacity_bytes || 0),
    usedBytes: Number(totals.total_used_bytes || 0),
  };
}
export async function writeNetworkEvent(vaultId, eventType, details = {}) {
  const { error } = await appTable("network_events").insert({ vault_id: vaultId, event_type: eventType, details }); if (error) throw error;
}
export async function writeSnapshot(vaultId, snapshot) {
  const values = { vault_id: vaultId, active_nodes: snapshot.activeNodes, verified_capacity_bytes: snapshot.verifiedCapacity, used_bytes: snapshot.usedBytes, resilient_bytes: snapshot.resilientBytes || 0 };
  const { error } = await appTable("network_snapshots").insert(values); if (error) throw error;
}
