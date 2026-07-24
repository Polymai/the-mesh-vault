import { appTable, currentAuthUserId } from "../services/supabase.js";
import { registerProvider, onPresence, markProviderStatus, isProviderUp, discoverPeers, publishPresence } from "./providers/provider-registry.js";
import { PROVIDER_KINDS } from "./providers/provider-types.js";
import { supabaseBootstrapProvider } from "./providers/supabase-bootstrap-provider.js";
import { localPeerBootstrapProvider } from "./providers/local-peer-bootstrap-provider.js";
import { inviteLinkBootstrapProvider } from "./providers/invite-link-bootstrap-provider.js";
import { anchorPeerBootstrapProvider, configureAnchorPeerProvider } from "./providers/anchor-peer-bootstrap-provider.js";
import { configurePeers, connectPeer, closePeers, broadcastGossip, connectedProtocols, measureConnectedPeers } from "./peer-manager.js";
import { setContributionQuota, storageEstimate, putShard, getShard, deleteShard, clearShards } from "../storage/fragment-store.js";
import { hashHex } from "../security/signing.js";
import { upsertPeer, updatePeerCapacity, recordManifestAnnouncement, recordFragmentAnnouncement, holdersForManifest, holdersForFragment, getPeer } from "./peer-registry.js";
import { getLocalManifest } from "./manifest-discovery.js";
import { announceHeldFragment } from "./fragment-discovery.js";
import { buildGossipMessage, GOSSIP_KINDS } from "./gossip.js";
import { recordTopologyObservation, clearTopologyObservations } from "./topology-registry.js";
import {
  configureAnchorService, stopAnchorService, anchorCapabilities, acceptControlObject, answerControlQuery,
  acceptManifestReplica, receiveRelayedSignal, publishControlObject, replicatePendingControlObjects, anchorStatus,
} from "./anchor-service.js";
import { queueShardRepair, refreshPhysicalStorageTotals } from "../services/segment-service.js";
import { acknowledgeShardDeletion, acknowledgeLifecycleShardDeletion, processPendingLocalDeletions } from "../services/deletion-service.js";

let heartbeat = null; let bootstrapReconnect = null; let bootstrapConnecting = false;
let activeNode = null; let providersRegistered = false; let deviceSigner = null;
const incomingShardWrites = new Map();

function connectSupabaseInBackground(nodeId) {
  if (!nodeId || bootstrapConnecting || activeNode?.id !== nodeId) return;
  clearTimeout(bootstrapReconnect); bootstrapReconnect = null; bootstrapConnecting = true;
  supabaseBootstrapProvider.connectNode(nodeId).then(async () => {
    if (activeNode?.id !== nodeId) return;
    markProviderStatus(supabaseBootstrapProvider.name, true);
    const remoteDiscoveries = await discoverPeers().catch(() => []);
    connectPresenceEntries(remoteDiscoveries.flatMap((entry) => entry.result || []), nodeId);
    await publishPresence().catch(() => {});
  }).catch(() => {
    markProviderStatus(supabaseBootstrapProvider.name, false);
    if (activeNode?.id === nodeId) bootstrapReconnect = window.setTimeout(() => connectSupabaseInBackground(nodeId), 30000);
  }).finally(() => { bootstrapConnecting = false; });
}

function ensureProvidersRegistered() {
  if (providersRegistered) return; providersRegistered = true;
  registerProvider(PROVIDER_KINDS.PEER_DISCOVERY, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.SIGNALING, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PRESENCE, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.MANIFEST_DISCOVERY, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.FRAGMENT_DISCOVERY, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PEER_DISCOVERY, supabaseBootstrapProvider);
  registerProvider(PROVIDER_KINDS.SIGNALING, supabaseBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PRESENCE, supabaseBootstrapProvider);
  registerProvider(PROVIDER_KINDS.MANIFEST_DISCOVERY, supabaseBootstrapProvider);
  registerProvider(PROVIDER_KINDS.FRAGMENT_DISCOVERY, supabaseBootstrapProvider);
  registerProvider(PROVIDER_KINDS.NETWORK_STATS, supabaseBootstrapProvider);
  registerProvider(PROVIDER_KINDS.ACCOUNT_DISCOVERY, supabaseBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PEER_DISCOVERY, localPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PRESENCE, localPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PEER_DISCOVERY, inviteLinkBootstrapProvider);
}
async function handleGossipMessage(_peer, message) {
  if (message.kind === GOSSIP_KINDS.PEER_ANNOUNCE) {
    upsertPeer({ peerId: message.payload.nodeId, devicePublicKey: message.senderPublicKey, protocolVersion: message.payload.protocolVersion, capacityBytes: message.payload.capacityBytes, usedBytes: message.payload.usedBytes, countryCode: message.payload.countryCode, regionCode: message.payload.regionCode, networkDomainHash: message.payload.networkDomainHash, capabilities: message.payload.capabilities || [], reliabilityScore: message.payload.reliabilityScore, survivalMode: message.payload.survivalMode, leaseExpiresAt: message.payload.leaseExpiresAt, uptimeSeconds: message.payload.uptimeSeconds, buddyNodeIds: message.payload.buddyNodeIds || [], trustStatus: "gossiped" });
    if (message.payload.capabilities?.includes("anchor-control-v1")) await publishControlObject("peer", "active", { ...message.payload, devicePublicKey: message.senderPublicKey, observedAt: message.timestamp, expiresAt: message.expiresAt }, Math.max(10000, message.expiresAt - Date.now())).catch(() => {});
  }
  if (message.kind === GOSSIP_KINDS.CAPACITY_CHANGE) updatePeerCapacity(message.payload.nodeId, message.payload.capacityBytes, message.payload.usedBytes);
  if (message.kind === GOSSIP_KINDS.MANIFEST_AVAILABILITY) recordManifestAnnouncement(message.payload.manifestId, message.payload.nodeId);
  if (message.kind === GOSSIP_KINDS.FRAGMENT_AVAILABILITY) recordFragmentAnnouncement(message.payload.shardHash, message.payload.nodeId);
  if (message.kind === GOSSIP_KINDS.TOPOLOGY_ANNOUNCE) recordTopologyObservation({ nodeId: message.payload.nodeId, devicePublicKey: message.senderPublicKey, connectedNodeIds: message.payload.connectedNodeIds, observedAt: message.timestamp });
  if (message.kind === GOSSIP_KINDS.MANIFEST_REQUEST && deviceSigner && activeNode) {
    const local = await getLocalManifest(message.payload.manifestId);
    if (local) broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.MANIFEST_AVAILABILITY, { manifestId: message.payload.manifestId, nodeId: activeNode.id }));
  }
  if (message.kind === GOSSIP_KINDS.FRAGMENT_REQUEST && deviceSigner && activeNode) {
    if (await hasShardSafe(message.payload.shardHash)) broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.FRAGMENT_AVAILABILITY, { shardHash: message.payload.shardHash, nodeId: activeNode.id }));
  }
}
async function announceTopology() {
  if (!deviceSigner || !activeNode) return;
  const connectedNodeIds = connectedProtocols().map((peer) => peer.nodeId);
  recordTopologyObservation({ nodeId: activeNode.id, devicePublicKey: deviceSigner.publicKey, connectedNodeIds });
  if (connectedNodeIds.length) broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.TOPOLOGY_ANNOUNCE, { nodeId: activeNode.id, connectedNodeIds }));
}
async function announcePresence() {
  if (!deviceSigner || !activeNode) return;
  broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.PEER_ANNOUNCE, { nodeId: activeNode.id, nodeName: activeNode.device_label, protocolVersion: 1, capabilities: anchorCapabilities(), capacityBytes: Number(activeNode.capacity_bytes) || 0, usedBytes: Number(activeNode.used_bytes) || 0, countryCode: activeNode.country_code || null, regionCode: activeNode.region_code || null, networkDomainHash: activeNode.network_domain_hash || null, reliabilityScore: activeNode.reliability_score ?? null, survivalMode: !!activeNode.survival_mode, leaseExpiresAt: activeNode.lease_expires_at || null, uptimeSeconds: activeNode.uptime_seconds ?? null, buddyNodeIds: activeNode.buddy_node_ids || [] }));
}
async function hasShardSafe(shardHash) { try { return !!(await getShard(shardHash)); } catch { return false; } }
async function storeIncomingShard(shardHash, bytes, expectedHash) {
  const previous = incomingShardWrites.get(shardHash) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const existing = await getShard(shardHash).catch(() => null);
    if (existing && (await hashHex(existing)) === expectedHash) return;
    await putShard(shardHash, bytes);
    const stored = await getShard(shardHash);
    if (!stored || (await hashHex(stored)) !== expectedHash) {
      await deleteShard(shardHash).catch(() => {});
      throw new Error("Stored shard verification failed.");
    }
    await announceHeldFragment(shardHash, activeNode?.id).catch(() => {});
  });
  incomingShardWrites.set(shardHash, operation);
  try { await operation; }
  finally { if (incomingShardWrites.get(shardHash) === operation) incomingShardWrites.delete(shardHash); }
}
function deviceLabel(fallback) { const platform = navigator.userAgentData?.platform || navigator.platform || "Browser"; return (fallback || `${platform} · ${navigator.userAgent.includes("Mobile") ? "Mobile" : "Browser"}`).slice(0, 80); }

function connectPresenceEntries(entries, ownNodeId) {
  const candidates = new Set();
  for (const entry of entries || []) {
    const nodeId = entry?.nodeId || entry?.peerId;
    if (!nodeId || nodeId === ownNodeId || candidates.has(nodeId)) continue;
    candidates.add(nodeId);
    connectPeer(nodeId).catch(() => {});
    if (candidates.size >= 14) break;
  }
}

export async function activateNode(deviceIdentity, vaultId, capacityBytes, iceServers = [], locationHint = null, { transient = false, transientCacheBytes = 0 } = {}) {
  ensureProvidersRegistered();
  deviceSigner = { publicKey: deviceIdentity.devicePublicKey, algorithm: deviceIdentity.algorithm, sign: deviceIdentity.sign };
  setContributionQuota(transient ? Math.max(0, Number(transientCacheBytes) || 0) : capacityBytes);
  const storedId = `${window.__DATA__.appStoragePrefix}nodeId`; const knownId = localStorage.getItem(storedId);
  const authUserId = await currentAuthUserId();
  const estimate = await storageEstimate();
  const baseValues = { vault_id: vaultId || null, supabase_auth_id: authUserId, device_public_key: deviceIdentity.devicePublicKey, device_label: deviceLabel(deviceIdentity.label), failure_domain_id: `browser-profile:${deviceIdentity.deviceId}`, status: capacityBytes > 0 || transient ? "online" : "paused", capacity_bytes: capacityBytes, used_bytes: Math.min(capacityBytes, estimate.usage || 0), last_seen_at: new Date().toISOString() };
  const locationValues = locationHint ? { country_code: locationHint.countryCode || null, region_code: locationHint.regionCode || null, network_domain_hash: locationHint.networkDomainHash || null, location_source: locationHint.source || "unknown", location_updated_at: locationHint.observedAt || new Date().toISOString() } : {};
  const persist = async (payload) => { const query = knownId ? appTable("nodes").update(payload).eq("id", knownId).eq("supabase_auth_id", authUserId) : appTable("nodes").insert(payload); let result = await query.select().maybeSingle(); if (!result.data && knownId && !result.error) result = await appTable("nodes").insert({ id: knownId, ...payload }).select().single(); return result; };
  let { data, error } = await persist({ ...baseValues, ...locationValues }).catch((persistError) => ({ data: null, error: persistError }));
  if (error && /country_code|region_code|network_domain_hash|location_source|location_updated_at/i.test(`${error.message || ""} ${error.details || ""}`)) ({ data, error } = await persist(baseValues).catch((persistError) => ({ data: null, error: persistError })));
  if (error || !data) data = { id: knownId || crypto.randomUUID(), ...baseValues, ...locationValues, coordination_status: "local-only" };
  activeNode = data; localStorage.setItem(storedId, data.id);
  configureAnchorPeerProvider({ getPresencePayload: () => activeNode ? { nodeId: activeNode.id, nodeName: activeNode.device_label, devicePublicKey: deviceIdentity.devicePublicKey, protocolVersion: 1, capabilities: anchorCapabilities(), capacityBytes: Number(activeNode.capacity_bytes) || 0, usedBytes: Number(activeNode.used_bytes) || 0, countryCode: activeNode.country_code || null, regionCode: activeNode.region_code || null, reliabilityScore: activeNode.reliability_score ?? null, survivalMode: !!activeNode.survival_mode, leaseExpiresAt: activeNode.lease_expires_at || null, uptimeSeconds: activeNode.uptime_seconds ?? null, buddyNodeIds: activeNode.buddy_node_ids || [] } : null });
  await configureAnchorService({ nodeId: data.id, deviceIdentity, getPeers: connectedProtocols, peerInfo: getPeer });
  configurePeers({
    fromNodeId: data.id, iceServers, onState: (nodeId, status) => { window.dispatchEvent(new CustomEvent("meshvault:peer-state", { detail: { nodeId, status } })); announceTopology().catch(() => {}); announcePresence().catch(() => {}); replicatePendingControlObjects().catch(() => {}); },
    protocolHandlers: {
      onShard: storeIncomingShard,
      onProofRequest: (shardHash) => getShard(shardHash),
    },
    onFragmentRequest: async (peer, shardHash) => {
      try { const bytes = await getShard(shardHash); if (bytes) await peer.protocol.sendShard(shardHash, bytes, await hashHex(bytes)); }
      catch {}
    },
    onFragmentDelete: async (_peer, shardHash, authorization) => {
      if (!activeNode?.id) return false;
      return authorization
        ? acknowledgeShardDeletion(activeNode.id, shardHash, authorization)
        : acknowledgeLifecycleShardDeletion(activeNode.id, shardHash);
    },
    onManifestRequest: (_peer, manifestId) => getLocalManifest(manifestId),
    onManifestReceived: (peer, _manifestId, envelope) => acceptManifestReplica(envelope, peer.nodeId),
    onControlPut: (peer, object) => acceptControlObject(object, peer.nodeId),
    onControlQuery: (_peer, query) => answerControlQuery(query),
    onRelaySignal: (peer, signal) => receiveRelayedSignal(signal, peer.nodeId),
    onGossip: handleGossipMessage,
  });
  activeNode._unsubscribePresence = onPresence((entries) => connectPresenceEntries(entries, data.id));
  await processPendingLocalDeletions(data.id).catch(() => {});
  connectSupabaseInBackground(data.id);
  const discoveries = await discoverPeers().catch(() => []);
  connectPresenceEntries(discoveries.flatMap((entry) => entry.result || []), data.id);
  await publishPresence().catch(() => {});
  heartbeat = window.setInterval(() => heartbeatNode().catch(() => {}), 30000);
  window.addEventListener("beforeunload", pauseNode, { once: true });
  return data;
}
export async function propagateManifestRequest(manifestId) {
  if (!deviceSigner || !activeNode) return [];
  broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.MANIFEST_REQUEST, { manifestId }));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const holderNodeIds = new Set(holdersForManifest(manifestId));
  const peers = [];
  for (const nodeId of holderNodeIds) { const peer = await connectToNode(nodeId).catch(() => null); if (peer) peers.push(peer); }
  return peers;
}
export async function propagateFragmentRequest(shardHash) {
  if (!deviceSigner || !activeNode) return [];
  broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.FRAGMENT_REQUEST, { shardHash }));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return Array.from(new Set(holdersForFragment(shardHash)));
}
export async function connectToNode(nodeId, timeoutMs = 15000) {
  await connectPeer(nodeId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = connectedProtocols().find((peer) => peer.nodeId === nodeId);
    if (connected?.protocol) return connected;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Peer connection did not become ready in time.");
}
export async function heartbeatNode() { if (!activeNode) return; if (!isProviderUp(supabaseBootstrapProvider.name)) connectSupabaseInBackground(activeNode.id); const estimate = await storageEstimate(); const usedBytes = Math.min(activeNode.capacity_bytes, estimate.usage || 0); activeNode.used_bytes = usedBytes; const anchor = await anchorStatus().catch(() => ({ enabled: false })); const now = new Date(); const heartbeatValues = { last_seen_at: now.toISOString(), status: activeNode.status, used_bytes: usedBytes }; if (anchor.enabled) heartbeatValues.lease_expires_at = new Date(now.getTime() + (window.__DATA__?.survival?.leaseMs || 90000)).toISOString(); try { await appTable("nodes").update(heartbeatValues).eq("id", activeNode.id); } catch {} await Promise.all([publishPresence().catch(() => {}), measureConnectedPeers().catch(() => []), replicatePendingControlObjects().catch(() => 0)]); await announceTopology(); await announcePresence(); }
export async function updateNodeSurvivalTelemetry(telemetry = {}) {
  if (!activeNode) return null;
  const values = {
    survival_mode: !!telemetry.enabled,
    lifecycle_state: String(telemetry.lifecycle || "stopped").slice(0, 32),
    lease_expires_at: telemetry.leaseExpiresAt || null,
    session_started_at: telemetry.sessionStartedAt || null,
    uptime_seconds: Math.max(0, Math.floor(Number(telemetry.uptimeSeconds) || 0)),
    reliability_score: Math.max(0, Math.min(1, Number(telemetry.reliabilityScore) || 0)),
    wake_lock_active: !!telemetry.wakeLockActive,
    buddy_node_ids: (telemetry.buddyNodeIds || []).slice(0, 4),
    last_handoff_at: telemetry.lastHandoffAt || null,
    last_seen_at: new Date().toISOString(),
  };
  Object.assign(activeNode, values);
  try {
    const { error } = await appTable("nodes").update(values).eq("id", activeNode.id);
    if (error) throw error;
  } catch {
    // The vault remains usable during a rolling schema deployment. A normal
    // heartbeat still keeps the legacy node row current until provisioning.
    try { await appTable("nodes").update({ reliability_score: values.reliability_score, last_seen_at: values.last_seen_at }).eq("id", activeNode.id); } catch {}
  }
  return values;
}
export async function setNodePaused(paused) { if (!activeNode) return; activeNode.status = paused ? "paused" : "online"; try { await appTable("nodes").update({ status: activeNode.status, last_seen_at: new Date().toISOString() }).eq("id", activeNode.id); } catch {} await announcePresence().catch(() => {}); }
export async function updateNodeCapacity(bytes) { if (!activeNode) return; const capacity = Math.max(0, Number(bytes) || 0); setContributionQuota(capacity); activeNode.capacity_bytes = capacity; activeNode.used_bytes = Math.min(activeNode.used_bytes, capacity); activeNode.status = capacity ? activeNode.status : "paused"; try { await appTable("nodes").update({ capacity_bytes: capacity, used_bytes: activeNode.used_bytes, status: activeNode.status }).eq("id", activeNode.id); } catch {} await announcePresence().catch(() => {}); }
export async function updateNodeLabel(label) { if (!activeNode) return; activeNode.device_label = String(label || "Browser node").trim().slice(0, 80); try { await appTable("nodes").update({ device_label: activeNode.device_label }).eq("id", activeNode.id); } catch {} await announcePresence().catch(() => {}); return activeNode.device_label; }
export async function pauseNode() {
  if (heartbeat) clearInterval(heartbeat); heartbeat = null;
  if (bootstrapReconnect) clearTimeout(bootstrapReconnect); bootstrapReconnect = null;
  const stoppingNode = activeNode; activeNode = null;
  if (stoppingNode) { stoppingNode._unsubscribePresence?.(); try { await appTable("nodes").update({ status: "offline", lifecycle_state: "stopped", lease_expires_at: new Date().toISOString(), wake_lock_active: false, last_seen_at: new Date().toISOString() }).eq("id", stoppingNode.id); } catch { try { await appTable("nodes").update({ status: "offline", last_seen_at: new Date().toISOString() }).eq("id", stoppingNode.id); } catch {} } }
  await stopAnchorService(); closePeers(); clearTopologyObservations(); await supabaseBootstrapProvider.disconnectNode().catch(() => {});
}
export async function clearLocalNodeStorage() {
  await setNodePaused(true);
  if (!activeNode?.id) return clearShards();
  const { data: placements, error } = await appTable("shard_placements")
    .select("id,vault_id,shard_id,role,segment_shards(shard_hash)")
    .eq("node_id", activeNode.id)
    .in("status", ["stored", "verified", "suspect", "unavailable", "surplus", "retiring"]);
  if (error) throw new Error("The mesh could not safely record that these local shards are being removed.");
  const placementIds = (placements || []).map((placement) => placement.id);
  if (placementIds.length) {
    const { error: updateError } = await appTable("shard_placements").update({ status: "unavailable", unavailable_since: new Date().toISOString() }).in("id", placementIds);
    if (updateError) throw new Error("The mesh could not safely mark these local shards unavailable.");
  }
  for (const placement of placements || []) {
    const shardHash = placement.segment_shards?.shard_hash;
    if (shardHash) {
      try { await appTable("fragment_location_cache").delete().eq("shard_hash", shardHash).eq("node_id", activeNode.id); }
      catch {}
    }
    if (placement.role === "durable") await queueShardRepair(placement.vault_id, placement.shard_id).catch(() => {});
  }
  return clearShards();
}
export function currentNode() { return activeNode; }
