import { supabase, appTable } from "../../services/supabase.js";

let signalChannel = null;
let signalTopic = null;
let signalPollTimer = null;
let currentNodeId = null;
let realtimeEnabled = true;
let realtimeConnected = false;
let legacySchema = false;
const signalListeners = new Set();
const presenceListeners = new Set();
const seenSignalIds = new Set();
let realtimeSignalObserved = false;
let signalBurstUntil = 0;

const SIGNAL_BURST_MS = 15000;
const SIGNAL_BURST_POLL_MS = 750;
const SIGNAL_FALLBACK_POLL_MS = 5000;
const SIGNAL_MAX_POLL_MS = 30000;
let signalFallbackDelay = SIGNAL_FALLBACK_POLL_MS;
let cachedPresenceEntries = [];
let cachedPresenceAt = 0;
const PRESENCE_CACHE_MS = 10000;

function rememberSignal(id) {
  if (!id || seenSignalIds.has(id)) return false;
  seenSignalIds.add(id);
  if (seenSignalIds.size > 512) seenSignalIds.delete(seenSignalIds.values().next().value);
  return true;
}

function deliverSignalRow(row, { realtime = false } = {}) {
  if (!row || row.recipient_node_id !== currentNodeId || new Date(row.expires_at).getTime() <= Date.now() || !rememberSignal(row.id)) return;
  if (realtime) { realtimeSignalObserved = true; clearTimeout(signalPollTimer); signalPollTimer = null; }
  const signal = { fromNodeId: row.sender_node_id, toNodeId: row.recipient_node_id, type: row.kind, payload: row.payload, sentAt: new Date(row.created_at).getTime() };
  signalListeners.forEach((listener) => { try { listener(signal); } catch {} });
  appTable("signals").delete().eq("id", row.id).then(() => {});
}

function deliverBroadcast(payload) {
  const row = payload?.payload || payload;
  if (!row || row.toNodeId !== currentNodeId || !rememberSignal(row.signalId || row.id)) return;
  realtimeSignalObserved = true;
  clearTimeout(signalPollTimer); signalPollTimer = null;
  signalListeners.forEach((listener) => {
    try { listener({ fromNodeId: row.fromNodeId, toNodeId: row.toNodeId, type: row.type, payload: row.payload, sentAt: Number(row.sentAt) || Date.now() }); }
    catch {}
  });
}

async function pollSignalsOnce() {
  if (!currentNodeId || realtimeSignalObserved) return;
  const { data, error } = await appTable("signals")
    .select("id,sender_node_id,recipient_node_id,kind,payload,expires_at,created_at")
    .eq("recipient_node_id", currentNodeId)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(64);
  if (error) throw error;
  (data || []).forEach((row) => deliverSignalRow(row));
}

function scheduleSignalPoll(immediate = false) {
  clearTimeout(signalPollTimer); signalPollTimer = null;
  if (!currentNodeId || realtimeSignalObserved || !realtimeEnabled) return;
  const delay = immediate ? 0 : Date.now() < signalBurstUntil ? SIGNAL_BURST_POLL_MS : signalFallbackDelay;
  signalPollTimer = setTimeout(async () => {
    await pollSignalsOnce().catch(() => {});
    if (Date.now() >= signalBurstUntil) signalFallbackDelay = Math.min(SIGNAL_MAX_POLL_MS, Math.round(signalFallbackDelay * 1.6));
    scheduleSignalPoll();
  }, delay);
}

function startSignalBurst() {
  if (realtimeSignalObserved) return;
  signalBurstUntil = Math.max(signalBurstUntil, Date.now() + SIGNAL_BURST_MS);
  signalFallbackDelay = SIGNAL_FALLBACK_POLL_MS;
  scheduleSignalPoll(true);
}

async function publishPresenceOnce({ force = false } = {}) {
  if (!force && cachedPresenceEntries.length && Date.now() - cachedPresenceAt < PRESENCE_CACHE_MS) {
    presenceListeners.forEach((listener) => { try { listener(cachedPresenceEntries); } catch {} });
    return cachedPresenceEntries;
  }
  let { data, error } = await supabase.schema("app717_meshvault").rpc("discover_node_candidates", { p_node_id: currentNodeId, p_limit: 24 });
  if (error) {
    legacySchema = true;
    const cutoff = new Date(Date.now() - 120000).toISOString();
    ({ data, error } = await appTable("nodes").select("id,device_public_key,device_label,failure_domain_id,status,last_seen_at,capacity_bytes,used_bytes,reliability_score,survival_mode,lease_expires_at,country_code,region_code,network_domain_hash").eq("status", "online").gte("last_seen_at", cutoff).order("last_seen_at", { ascending: false }).limit(24));
  }
  if (error) throw error;
  const entries = (data || []).map((row) => {
    const survivalMode = !!row.survival_mode;
    const leaseExpiresAt = row.lease_expires_at || null;
    const anchorProtocolVersion = row.anchor_protocol_version == null
      ? (survivalMode ? 1 : 0)
      : Number(row.anchor_protocol_version);
    const anchorHealthy = anchorProtocolVersion > 0 && survivalMode && (!leaseExpiresAt || Date.parse(leaseExpiresAt) > Date.now());
    return {
      nodeId: row.id, nodeName: row.device_label, devicePublicKey: row.device_public_key,
      failureDomainId: row.failure_domain_id, capacityBytes: Number(row.capacity_bytes), usedBytes: Number(row.used_bytes),
      reliabilityScore: Number(row.reliability_score ?? 0.5), survivalMode, leaseExpiresAt,
      anchorProtocolVersion,
      anchorControlCapacityBytes: Number(row.anchor_control_capacity_bytes || 0),
      anchorControlUsedBytes: Number(row.anchor_control_used_bytes || 0),
      anchorConnectedNodes: Number(row.anchor_connected_nodes || 0),
      countryCode: row.country_code || null, regionCode: row.region_code || null, networkDomainHash: row.network_domain_hash || null,
      capabilities: anchorHealthy ? ["anchor-control-v1"] : [],
    };
  });
  cachedPresenceEntries = entries;
  cachedPresenceAt = Date.now();
  presenceListeners.forEach((listener) => { try { listener(entries); } catch {} });
  return entries;
}
function stopFallbacks() {
  clearTimeout(signalPollTimer); signalPollTimer = null;
}

async function closeRealtimeChannel() {
  realtimeConnected = false;
  if (signalChannel) await supabase.removeChannel(signalChannel).catch(() => {});
  signalChannel = null;
}

async function connectRealtimeChannel() {
  if (!currentNodeId || !realtimeEnabled) return false;
  await closeRealtimeChannel();
  if (!legacySchema) {
    const { data, error } = await supabase.schema("app717_meshvault").rpc("get_node_signal_topic", { p_node_id: currentNodeId });
    if (error || !/^[0-9a-f]{64}$/.test(String(data || ""))) legacySchema = true;
    else signalTopic = `mesh-signal:${data}`;
  }
  const channel = supabase.channel(signalTopic || `node:${currentNodeId}`, { config: { private: false } })
    .on("broadcast", { event: "signal" }, deliverBroadcast);
  if (legacySchema) {
    channel.on("postgres_changes", { event: "INSERT", schema: "app717_meshvault", table: "signals", filter: `recipient_node_id=eq.${currentNodeId}` }, ({ new: row }) => {
      deliverSignalRow(row, { realtime: true });
    });
  }
  signalChannel = channel;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      realtimeConnected = false;
      startSignalBurst();
      resolve(false);
    }, 8000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        realtimeConnected = true;
        // A subscribed recipient channel is the primary signaling transport.
        // Database polling is only a compatibility/failure fallback.
        realtimeSignalObserved = true;
        stopFallbacks();
        resolve(true);
      }
      if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        realtimeConnected = false; realtimeSignalObserved = false; startSignalBurst(); clearTimeout(timer); resolve(false);
      }
    });
  });
}

export const supabaseBootstrapProvider = {
  name: "supabase",
  async discoverPeers() {
    const entries = await publishPresenceOnce();
    return entries.filter((entry) => entry.nodeId !== currentNodeId).map((entry) => ({
      ...entry,
      peerId: entry.nodeId,
      source: "supabase",
    }));
  },
  async connectNode(nodeId) {
    stopFallbacks(); seenSignalIds.clear(); realtimeSignalObserved = false; signalBurstUntil = 0;
    currentNodeId = nodeId;
    await publishPresenceOnce({ force: true });
    const connected = realtimeEnabled ? await connectRealtimeChannel() : false;
    return { realtimeConnected: connected, legacySchema };
  },
  async setRealtimeEnabled(enabled) {
    realtimeEnabled = !!enabled;
    if (!realtimeEnabled) { stopFallbacks(); await closeRealtimeChannel(); return false; }
    if (!realtimeConnected) return connectRealtimeChannel();
    return true;
  },
  realtimeStatus() { return { enabled: realtimeEnabled, connected: realtimeConnected, legacySchema }; },
  async disconnectNode() {
    stopFallbacks(); currentNodeId = null; signalTopic = null; cachedPresenceEntries = []; cachedPresenceAt = 0; realtimeSignalObserved = false; seenSignalIds.clear();
    await closeRealtimeChannel();
  },
  async sendSignal({ fromNodeId, toNodeId, type, payload }) {
    if (!toNodeId || !["offer", "answer", "ice", "hello"].includes(type)) throw new Error("Invalid signaling message.");
    if (!fromNodeId || fromNodeId === toNodeId) return false;
    const signalId = crypto.randomUUID();
    const { data: sent, error: rpcError } = await supabase.schema("app717_meshvault").rpc("send_mesh_signal", {
      p_sender_node_id: fromNodeId, p_recipient_node_id: toNodeId, p_kind: type,
      p_payload: { signalId, fromNodeId, toNodeId, type, payload, sentAt: Date.now() },
    });
    if (!rpcError) return sent === true;
    legacySchema = true;
    const cutoff = new Date(Date.now() - 120000).toISOString();
    const { data: recipient, error: recipientError } = await appTable("nodes").select("id,survival_mode,lease_expires_at").eq("id", toNodeId).eq("status", "online").gte("last_seen_at", cutoff).maybeSingle();
    if (recipientError || !recipient) return false;
    if (recipient.survival_mode && (!recipient.lease_expires_at || Date.parse(recipient.lease_expires_at) <= Date.now())) return false;
    const { error } = await appTable("signals").insert({ sender_node_id: fromNodeId, recipient_node_id: toNodeId, kind: type, payload, expires_at: new Date(Date.now() + 60000).toISOString() });
    // A recipient can disappear after presence discovery but before this
    // insert reaches Postgres. That peer-specific RLS rejection must not mark
    // the whole bootstrap provider unavailable for every other live peer.
    if (error) return false;
    return true;
  },
  onSignal(handler) { signalListeners.add(handler); return () => signalListeners.delete(handler); },
  async publishPresence() { return publishPresenceOnce(); },
  onPresence(handler) { presenceListeners.add(handler); return () => presenceListeners.delete(handler); },
  async lookupManifest(manifestId) {
    const { data, error } = await appTable("encrypted_manifest_cache").select("*").eq("manifest_id", manifestId).maybeSingle();
    if (error || !data) return null;
    return { manifestId: data.manifest_id, vaultId: data.vault_id, ownerPublicKey: data.owner_public_key, ...data.encrypted_manifest, manifestHash: data.manifest_hash, signature: data.signature, manifestFormatVersion: data.protocol_version };
  },
  async announceManifest(manifestEnvelope) {
    const { manifestId, vaultId, ownerPublicKey, manifestFormatVersion, manifestHash, signature, ...rest } = manifestEnvelope;
    const { error } = await appTable("encrypted_manifest_cache").upsert(
      { manifest_id: manifestId, vault_id: vaultId, owner_public_key: ownerPublicKey, encrypted_manifest: rest, manifest_hash: manifestHash, signature, protocol_version: manifestFormatVersion },
      { onConflict: "manifest_id", ignoreDuplicates: true },
    );
    if (error) throw error;
  },
  async lookupFragmentLocations(shardHash) {
    const { data, error } = await appTable("fragment_location_cache").select("node_id,announced_at").eq("shard_hash", shardHash).order("announced_at", { ascending: false }).limit(10);
    if (error) return [];
    return (data || []).map((row) => ({ nodeId: row.node_id, announcedAt: new Date(row.announced_at).getTime(), source: "supabase" }));
  },
  async announceFragmentLocation(shardHash, nodeId) {
    const { error } = await appTable("fragment_location_cache").upsert({ shard_hash: shardHash, node_id: nodeId, announced_at: new Date().toISOString() }, { onConflict: "shard_hash,node_id" });
    if (error) throw error;
  },
  async getNetworkStats() {
    const { data, error } = await appTable("network_snapshots").select("*").order("captured_at", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return { activeNodes: data.active_nodes, verifiedCapacityBytes: Number(data.verified_capacity_bytes), usedBytes: Number(data.used_bytes), resilientBytes: Number(data.resilient_bytes), capturedAt: data.captured_at, source: "supabase" };
  },
  async discoverAccount(vaultId) {
    const { data, error } = await appTable("account_links").select("*").eq("vault_id", vaultId).maybeSingle();
    if (error || !data) return null;
    return { vaultId: data.vault_id, authUserId: data.auth_user_id, linkedAt: data.linked_at, notificationPrefs: data.notification_prefs };
  },
};
