import { supabase, appTable } from "../../services/supabase.js";

let signalChannel = null;
let presenceTimer = null;
let presenceInterval = null;
let signalPollTimer = null;
let currentNodeId = null;
const signalListeners = new Set();
const presenceListeners = new Set();
const seenSignalIds = new Set();
let realtimeSignalObserved = false;
let signalBurstUntil = 0;

const PRESENCE_POLL_MS = 20000;
const SIGNAL_BURST_MS = 30000;
const SIGNAL_BURST_POLL_MS = 750;
const SIGNAL_FALLBACK_POLL_MS = 5000;

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
  if (!currentNodeId || realtimeSignalObserved) return;
  const delay = immediate ? 0 : Date.now() < signalBurstUntil ? SIGNAL_BURST_POLL_MS : SIGNAL_FALLBACK_POLL_MS;
  signalPollTimer = setTimeout(async () => { await pollSignalsOnce().catch(() => {}); scheduleSignalPoll(); }, delay);
}

function startSignalBurst() {
  if (realtimeSignalObserved) return;
  signalBurstUntil = Math.max(signalBurstUntil, Date.now() + SIGNAL_BURST_MS);
  scheduleSignalPoll(true);
}

async function publishPresenceOnce() {
  const cutoff = new Date(Date.now() - 120000).toISOString();
  const { data, error } = await supabase.from("nodes").select("id,device_public_key,status,last_seen_at,capacity_bytes,used_bytes").eq("status", "online").gte("last_seen_at", cutoff).order("last_seen_at", { ascending: false }).limit(24);
  if (error) throw error;
  const entries = (data || []).map((row) => ({ nodeId: row.id, devicePublicKey: row.device_public_key, capacityBytes: Number(row.capacity_bytes), usedBytes: Number(row.used_bytes) }));
  if (entries.some((entry) => entry.nodeId !== currentNodeId)) startSignalBurst();
  presenceListeners.forEach((listener) => { try { listener(entries); } catch {} });
  return entries;
}
function schedulePresence() { clearTimeout(presenceTimer); presenceTimer = setTimeout(() => publishPresenceOnce().catch(() => {}), 120); }
function startPresenceFallback() { clearInterval(presenceInterval); presenceInterval = setInterval(() => publishPresenceOnce().catch(() => {}), PRESENCE_POLL_MS); }
function stopFallbacks() {
  clearTimeout(presenceTimer); presenceTimer = null;
  clearInterval(presenceInterval); presenceInterval = null;
  clearTimeout(signalPollTimer); signalPollTimer = null;
}

export const supabaseBootstrapProvider = {
  name: "supabase",
  async discoverPeers() {
    const entries = await publishPresenceOnce();
    return entries.filter((entry) => entry.nodeId !== currentNodeId).map((entry) => ({ peerId: entry.nodeId, devicePublicKey: entry.devicePublicKey, source: "supabase" }));
  },
  async connectNode(nodeId) {
    stopFallbacks(); seenSignalIds.clear(); realtimeSignalObserved = false; signalBurstUntil = 0;
    currentNodeId = nodeId;
    if (signalChannel) await supabase.removeChannel(signalChannel);
    signalChannel = supabase.channel(`app717_meshvault:storage:${nodeId}`)
      .on("postgres_changes", { event: "INSERT", schema: "app717_meshvault", table: "signals", filter: `recipient_node_id=eq.${nodeId}` }, ({ new: row }) => {
        deliverSignalRow(row, { realtime: true });
      })
      .on("postgres_changes", { event: "*", schema: "app717_meshvault", table: "nodes" }, schedulePresence);
    const realtimeConnected = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      signalChannel.subscribe((status) => {
        if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(true); }
        if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) { realtimeSignalObserved = false; startSignalBurst(); clearTimeout(timer); resolve(false); }
      });
    });
    startPresenceFallback();
    await publishPresenceOnce();
    return { realtimeConnected };
  },
  async disconnectNode() {
    stopFallbacks(); currentNodeId = null; realtimeSignalObserved = false; seenSignalIds.clear();
    if (signalChannel) await supabase.removeChannel(signalChannel);
    signalChannel = null;
  },
  async sendSignal({ fromNodeId, toNodeId, type, payload }) {
    if (!toNodeId || !["offer", "answer", "ice", "hello"].includes(type)) throw new Error("Invalid signaling message.");
    if (!fromNodeId || fromNodeId === toNodeId) return false;
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
