import { supabase } from "../../services/supabase.js";
import { byteLength, recordDataFlow } from "../../observability/data-flow-log.js";
import { currentPatientZeroResponderKey, loadPatientZeroAuthorityBundle } from "../patient-zero-authority-chain.js";

let signalChannel = null;
let signalTopic = null;
let currentNodeId = null;
let realtimeEnabled = true;
let realtimeConnected = false;
let backendIncompatible = false;
const signalListeners = new Set();
const presenceListeners = new Set();
const seenSignalIds = new Set();
let realtimeSignalObserved = false;
let cachedPresenceEntries = [];
let cachedPresenceAt = 0;
let presencePromise = null;
const PRESENCE_CACHE_MS = Math.max(60000, Number(globalThis.window?.__DATA__?.coordination?.discoveryCacheMs || 300000));

function bootstrapAuthorityKeys() {
  const current = currentPatientZeroResponderKey();
  return /^[A-Za-z0-9_-]{43}$/.test(current) ? [current] : [];
}

function rememberSignal(id) {
  if (!id || seenSignalIds.has(id)) return false;
  seenSignalIds.add(id);
  if (seenSignalIds.size > 512) seenSignalIds.delete(seenSignalIds.values().next().value);
  return true;
}

function deliverBroadcast(payload) {
  const row = payload?.payload || payload;
  if (!row || row.toNodeId !== currentNodeId || !rememberSignal(row.signalId || row.id)) return;
  recordDataFlow({ route: "supabase", direction: "in", kind: "Peer signal", bytes: byteLength(JSON.stringify(row)), counterparty: "Supabase", transport: "Realtime" });
  realtimeSignalObserved = true;
  signalListeners.forEach((listener) => {
    try { listener({ signalId: row.signalId || row.id || null, fromNodeId: row.fromNodeId, toNodeId: row.toNodeId, type: row.type, payload: row.payload, sentAt: Number(row.sentAt) || Date.now() }); }
    catch {}
  });
}


async function publishPresenceOnce({ force = false } = {}) {
  // Empty is also a valid discovery result. Caching it prevents the UI and
  // coordination refreshes from turning a bounded cold start into polling.
  if (!force && cachedPresenceAt && Date.now() - cachedPresenceAt < PRESENCE_CACHE_MS) {
    presenceListeners.forEach((listener) => { try { listener(cachedPresenceEntries); } catch {} });
    return cachedPresenceEntries;
  }
  if (!force && presencePromise) return presencePromise;
  const request = (async () => {
  await loadPatientZeroAuthorityBundle().catch(() => null);
  const authorityPublicKeys = bootstrapAuthorityKeys();
  if (!authorityPublicKeys.length) throw new Error("No Patient Zero public key is configured for cold start.");
  let { data, error } = await supabase.schema("app717_meshvault").rpc("discover_bootstrap_gateways", {
    p_node_id: currentNodeId,
    p_device_public_keys: authorityPublicKeys,
    p_limit: 3,
  });
  if (error) {
    backendIncompatible = true;
    throw new Error("Supabase coordination has not been provisioned for TheMeshVault protocol v3.");
  }
  backendIncompatible = false;
  const entries = (data || []).filter((row) => authorityPublicKeys.includes(String(row.device_public_key || ""))
    && Number(row.coordination_protocol_version) === 3).map((row) => {
    const survivalMode = !!row.survival_mode;
    const leaseExpiresAt = row.lease_expires_at || null;
    const anchorProtocolVersion = Number(row.anchor_protocol_version || 0);
    const anchorHealthy = anchorProtocolVersion === 3 && survivalMode && (!leaseExpiresAt || Date.parse(leaseExpiresAt) > Date.now());
    return {
      nodeId: row.id, nodeName: row.device_label, devicePublicKey: row.device_public_key,
      protocolVersion: 3,
      failureDomainId: row.failure_domain_id, capacityBytes: Number(row.capacity_bytes), usedBytes: Number(row.used_bytes),
      reliabilityScore: Number(row.reliability_score ?? 0.5), survivalMode, leaseExpiresAt,
      anchorProtocolVersion,
      anchorControlCapacityBytes: Number(row.anchor_control_capacity_bytes || 0),
      anchorControlUsedBytes: Number(row.anchor_control_used_bytes || 0),
      anchorConnectedNodes: Number(row.anchor_connected_nodes || 0),
      countryCode: row.country_code || null, regionCode: row.region_code || null, networkDomainHash: row.network_domain_hash || null,
      backboneUrl: /^wss:\/\//i.test(row.backbone_url || "") ? row.backbone_url : null,
      backbonePublicKey: row.backbone_public_key || null,
      capabilities: ["mesh-control-lite-v3", ...(anchorHealthy ? ["mesh-backbone-v3", "anchor-control-v3"] : []),
        ...(/^wss:\/\//i.test(row.backbone_url || "") && row.backbone_public_key ? ["backbone-storage-v3"] : [])],
    };
  });
  cachedPresenceEntries = entries;
  cachedPresenceAt = Date.now();
  presenceListeners.forEach((listener) => { try { listener(entries); } catch {} });
  return entries;
  })();
  presencePromise = request;
  try { return await request; }
  finally { if (presencePromise === request) presencePromise = null; }
}
function stopFallbacks() {
  // Protocol v3 has no database-polling signaling fallback. Anchors are the
  // independent fallback when Supabase Realtime is unavailable.
}

async function closeRealtimeChannel() {
  realtimeConnected = false;
  if (signalChannel) await supabase.removeChannel(signalChannel).catch(() => {});
  signalChannel = null;
}

async function connectRealtimeChannel() {
  if (!currentNodeId || !realtimeEnabled) return false;
  await closeRealtimeChannel();
  const { data, error } = await supabase.schema("app717_meshvault").rpc("get_node_signal_topic", { p_node_id: currentNodeId });
  if (error || !/^[0-9a-f]{64}$/.test(String(data || ""))) {
    backendIncompatible = true;
    throw new Error("Supabase signaling has not been provisioned for TheMeshVault protocol v3.");
  }
  signalTopic = `mesh-signal:${data}`;
  const channel = supabase.channel(signalTopic, { config: { private: false } })
    .on("broadcast", { event: "signal" }, deliverBroadcast);
  signalChannel = channel;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      realtimeConnected = false;
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
        realtimeConnected = false; realtimeSignalObserved = false; clearTimeout(timer); resolve(false);
      }
    });
  });
}

export const supabaseBootstrapProvider = {
  name: "supabase",
  async discoverPeers({ force = false } = {}) {
    const entries = await publishPresenceOnce({ force });
    return entries.filter((entry) => entry.nodeId !== currentNodeId).map((entry) => ({
      ...entry,
      peerId: entry.nodeId,
      source: "supabase",
    }));
  },
  async connectNode(nodeId, { discover = true } = {}) {
    stopFallbacks(); seenSignalIds.clear(); realtimeSignalObserved = false;
    currentNodeId = nodeId;
    const connected = realtimeEnabled ? await connectRealtimeChannel() : false;
    // Subscribe before discovering candidates. Otherwise offers can be sent
    // while answers addressed back to this node still have no listener.
    // Patient Zero only needs the addressed signaling listener. It must not
    // repeatedly search for itself through the first-contact service.
    if (discover) await publishPresenceOnce();
    return { realtimeConnected: connected, backendIncompatible };
  },
  async setRealtimeEnabled(enabled) {
    realtimeEnabled = !!enabled;
    if (!realtimeEnabled) { stopFallbacks(); await closeRealtimeChannel(); return false; }
    if (!realtimeConnected) return connectRealtimeChannel();
    return true;
  },
  realtimeStatus() { return { enabled: realtimeEnabled, connected: realtimeConnected, backendIncompatible }; },
  async disconnectNode() {
    stopFallbacks(); currentNodeId = null; signalTopic = null; cachedPresenceEntries = []; cachedPresenceAt = 0; presencePromise = null; realtimeSignalObserved = false; seenSignalIds.clear();
    await closeRealtimeChannel();
  },
  async sendSignal({ signalId: suppliedSignalId, fromNodeId, toNodeId, type, payload }) {
    if (!toNodeId || !["offer", "answer", "ice", "hello"].includes(type)) throw new Error("Invalid signaling message.");
    if (!fromNodeId || fromNodeId === toNodeId) return false;
    const signalId = suppliedSignalId || crypto.randomUUID();
    const { data: sent, error: rpcError } = await supabase.schema("app717_meshvault").rpc("send_mesh_signal", {
      p_sender_node_id: fromNodeId, p_recipient_node_id: toNodeId, p_kind: type,
      p_payload: { signalId, fromNodeId, toNodeId, type, payload, sentAt: Date.now() },
    });
    if (rpcError) {
      backendIncompatible = /protocol|function|schema|column/i.test(`${rpcError.message || ""} ${rpcError.details || ""}`);
      return false;
    }
    return sent === true;
  },
  onSignal(handler) { signalListeners.add(handler); return () => signalListeners.delete(handler); },
  async publishPresence() {
    // Supabase has no presence broadcast in protocol v3. Replaying the cached
    // candidate set is sufficient; querying discovery here multiplied every
    // ordinary mesh heartbeat into another database read.
    if (cachedPresenceEntries.length) presenceListeners.forEach((listener) => { try { listener(cachedPresenceEntries); } catch {} });
    return cachedPresenceEntries;
  },
  onPresence(handler) { presenceListeners.add(handler); return () => presenceListeners.delete(handler); },
};
