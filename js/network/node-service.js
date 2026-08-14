import { appTable, currentAuthUserId } from "../services/supabase.js";
import { registerProvider, onPresence, markProviderStatus, isProviderUp, discoverPeers, publishPresence, setCoordinationMode } from "./providers/provider-registry.js";
import { PROVIDER_KINDS } from "./providers/provider-types.js";
import { supabaseBootstrapProvider } from "./providers/supabase-bootstrap-provider.js";
import { localPeerBootstrapProvider } from "./providers/local-peer-bootstrap-provider.js";
import { inviteLinkBootstrapProvider } from "./providers/invite-link-bootstrap-provider.js";
import { anchorPeerBootstrapProvider, configureAnchorPeerProvider } from "./providers/anchor-peer-bootstrap-provider.js";
import { backboneSeedProvider, backboneSeedStatus, backboneStorageProtocol, configureBackboneSeedProvider, disconnectBackboneSeeds } from "./providers/backbone-seed-provider.js";
import { configurePeers, connectPeer, closePeers, broadcastGossip, connectedProtocols, measureConnectedPeers, registerExternalProtocol } from "./peer-manager.js";
import { setContributionQuota, storageEstimate, putShard, getShard, deleteShard, clearShards } from "../storage/fragment-store.js";
import { hashHex } from "../security/signing.js";
import { upsertPeer, updatePeerCapacity, recordManifestAnnouncement, recordFragmentAnnouncement, holdersForManifest, holdersForFragment, getPeer } from "./peer-registry.js";
import { getLocalManifest } from "./manifest-discovery.js";
import { announceHeldFragment } from "./fragment-discovery.js";
import { buildGossipMessage, GOSSIP_KINDS } from "./gossip.js";
import { recordTopologyObservation, clearTopologyObservations } from "./topology-registry.js";
import {
  configureAnchorService, stopAnchorService, anchorCapabilities, nodeControlCapabilities, acceptControlObject, answerControlQuery,
  acceptManifestReplica, receiveRelayedSignal, publishControlObject, replicatePendingControlObjects, anchorStatus,
} from "./anchor-service.js";
import { queueShardRepair, refreshPhysicalStorageTotals } from "../services/segment-service.js";
import {
  acknowledgeShardDeletion, acknowledgeLifecycleShardDeletion,
  processDistributedDeletionOrders, processPendingLocalDeletions,
} from "../services/deletion-service.js";
import {
  COORDINATION_MODES, evaluateCoordination, heartbeatIntervalMs, isHealthyAnchor, isHealthyControlParticipant, isHealthyBackbone,
  jitteredInterval, selectAnchorAssignments, shouldWriteSupabaseHeartbeat,
} from "./coordination-policy.js";
import { publishRepairAdvisory } from "./distributed-repair.js";

let heartbeat = null; let bootstrapReconnect = null; let bootstrapConnecting = false;
let activeNode = null; let providersRegistered = false; let deviceSigner = null; let pendingNodeLabel = null;
let anchorAssignments = { primary: [], reserve: [] };
let coordinationState = evaluateCoordination({}, { anchorCount: 0, supabaseUp: true });
let lastSupabaseHeartbeatAt = 0;
let lastBackboneDiscoveryAt = 0;
let supabaseFallbackOpened = false;
const incomingShardWrites = new Map();
const outgoingFragmentRequests = new Map();

function coordinationConfig() { return window.__DATA__?.coordination || {}; }
function meshFirstMode() {
  return [COORDINATION_MODES.HYBRID, COORDINATION_MODES.ANCHOR_PRIMARY, COORDINATION_MODES.MESH_DEGRADED].includes(coordinationState.mode);
}
async function discoverForCoordination({ force = false, forceBackbone = false } = {}) {
  const config = coordinationConfig();
  const backboneDue = forceBackbone || !meshFirstMode()
    || Date.now() - lastBackboneDiscoveryAt >= Number(config.backboneDiscoveryRefreshMs || 600000);
  const results = await discoverPeers({
    minimumCandidates: backboneDue ? Number(config.minimumPeerCandidates || 8) : 1,
    force,
    requireProvider: null,
    // A Backbone refresh is still mesh traffic. Supabase is deliberately
    // excluded until the delayed fallback connection has actually opened.
    excludeProviders: supabaseFallbackOpened ? [] : [supabaseBootstrapProvider.name],
  }).catch(() => []);
  if (results.some((entry) => entry.provider === backboneSeedProvider.name)) lastBackboneDiscoveryAt = Date.now();
  return results;
}
async function publishMeshPresence() {
  // Cold-start peers must be visible to verified Backbone seeds before the
  // optional Supabase fallback is opened.
  return publishPresence({
    excludeProviders: supabaseFallbackOpened ? [] : [supabaseBootstrapProvider.name],
  }).catch(() => []);
}
function connectedAnchorCount() {
  return connectedProtocols().filter((peer) => isHealthyAnchor({ ...getPeer(peer.nodeId), nodeId: peer.nodeId })).length;
}
function connectedParticipantCount() {
  return connectedProtocols().filter((peer) => isHealthyControlParticipant({ ...getPeer(peer.nodeId), nodeId: peer.nodeId })).length;
}
function connectedBackboneCount() {
  return connectedProtocols().filter((peer) => isHealthyBackbone({ ...getPeer(peer.nodeId), nodeId: peer.nodeId })).length + backboneSeedStatus().connected;
}
function scheduleHeartbeat() {
  clearTimeout(heartbeat);
  if (!activeNode) { heartbeat = null; return; }
  const enabled = !!activeNode.survival_mode;
  const base = heartbeatIntervalMs(coordinationState.mode, enabled, coordinationConfig());
  heartbeat = window.setTimeout(async () => {
    await heartbeatNode().catch(() => {});
    scheduleHeartbeat();
  }, jitteredInterval(base, Math.random, coordinationConfig()));
}
async function refreshCoordinationMode() {
  const anchor = await anchorStatus().catch(() => ({ enabled: false }));
  const next = evaluateCoordination(coordinationState, {
    anchorCount: connectedAnchorCount(),
    participantCount: connectedParticipantCount(),
    backboneCount: connectedBackboneCount(),
    supabaseUp: isProviderUp(supabaseBootstrapProvider.name),
  }, coordinationConfig());
  const changed = next.mode !== coordinationState.mode;
  coordinationState = next;
  setCoordinationMode(next.mode);
  const needsRealtime = [COORDINATION_MODES.SUPABASE_PRIMARY, COORDINATION_MODES.HYBRID].includes(next.mode);
  await supabaseBootstrapProvider.setRealtimeEnabled(needsRealtime).catch(() => {});
  if (changed) {
    scheduleHeartbeat();
    window.dispatchEvent(new CustomEvent("meshvault:coordination-status", { detail: coordinationStatus() }));
  }
  return next;
}

function connectSupabaseInBackground(nodeId) {
  if (!nodeId || bootstrapConnecting || activeNode?.id !== nodeId) return;
  clearTimeout(bootstrapReconnect); bootstrapReconnect = null; bootstrapConnecting = true;
  supabaseBootstrapProvider.connectNode(nodeId).then(async () => {
    if (activeNode?.id !== nodeId) return;
    markProviderStatus(supabaseBootstrapProvider.name, true);
    supabaseFallbackOpened = true;
    await refreshCoordinationMode();
    const remoteDiscoveries = await discoverForCoordination().catch(() => []);
    connectPresenceEntries(remoteDiscoveries.flatMap((entry) => entry.result || []), nodeId);
    await publishMeshPresence();
  }).catch(() => {
    markProviderStatus(supabaseBootstrapProvider.name, false);
    refreshCoordinationMode().catch(() => {});
    if (activeNode?.id === nodeId) bootstrapReconnect = window.setTimeout(() => connectSupabaseInBackground(nodeId), 30000);
  }).finally(() => { bootstrapConnecting = false; });
}

async function connectFallbackAfterMeshAttempt(nodeId) {
  const delay = Math.max(0, Number(coordinationConfig().supabaseColdStartDelayMs || 5000));
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  if (activeNode?.id !== nodeId) return;
  if (connectedParticipantCount() >= Number(coordinationConfig().minimumMeshParticipants || 2)
    || connectedBackboneCount() >= Number(coordinationConfig().minimumBackbonePeers || 1)) {
    await refreshCoordinationMode();
    return;
  }
  connectSupabaseInBackground(nodeId);
}

function ensureProvidersRegistered() {
  if (providersRegistered) return; providersRegistered = true;
  registerProvider(PROVIDER_KINDS.PEER_DISCOVERY, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.SIGNALING, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PRESENCE, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.MANIFEST_DISCOVERY, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.FRAGMENT_DISCOVERY, anchorPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PEER_DISCOVERY, backboneSeedProvider);
  registerProvider(PROVIDER_KINDS.SIGNALING, backboneSeedProvider);
  registerProvider(PROVIDER_KINDS.PRESENCE, backboneSeedProvider);
  registerProvider(PROVIDER_KINDS.MANIFEST_DISCOVERY, backboneSeedProvider);
  registerProvider(PROVIDER_KINDS.FRAGMENT_DISCOVERY, backboneSeedProvider);
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
    upsertPeer({ peerId: message.payload.nodeId, nodeName: message.payload.nodeName, devicePublicKey: message.senderPublicKey, protocolVersion: message.payload.protocolVersion, capacityBytes: message.payload.capacityBytes, usedBytes: message.payload.usedBytes, countryCode: message.payload.countryCode, regionCode: message.payload.regionCode, networkDomainHash: message.payload.networkDomainHash, failureDomainId: message.payload.failureDomainId, capabilities: message.payload.capabilities || [], reliabilityScore: message.payload.reliabilityScore, survivalMode: message.payload.survivalMode, leaseExpiresAt: message.payload.leaseExpiresAt, uptimeSeconds: message.payload.uptimeSeconds, buddyNodeIds: message.payload.buddyNodeIds || [], anchorProtocolVersion: message.payload.anchorProtocolVersion, anchorControlCapacityBytes: message.payload.anchorControlCapacityBytes, anchorControlUsedBytes: message.payload.anchorControlUsedBytes, anchorConnectedNodes: message.payload.anchorConnectedNodes, coordinationMode: message.payload.coordinationMode, trustStatus: "gossiped" });
    // The sender publishes its own signed presence record. Re-signing every
    // received announcement here created an N x N stream of control records.
  }
  if (message.kind === GOSSIP_KINDS.CAPACITY_CHANGE) updatePeerCapacity(message.payload.nodeId, message.payload.capacityBytes, message.payload.usedBytes);
  if (message.kind === GOSSIP_KINDS.MANIFEST_AVAILABILITY) recordManifestAnnouncement(message.payload.manifestId, message.payload.nodeId);
  if (message.kind === GOSSIP_KINDS.FRAGMENT_AVAILABILITY) recordFragmentAnnouncement(message.payload.shardHash, message.payload.nodeId);
  if (message.kind === GOSSIP_KINDS.TOPOLOGY_ANNOUNCE) recordTopologyObservation({ nodeId: message.payload.nodeId, devicePublicKey: message.senderPublicKey, connectedNodeIds: message.payload.connectedNodeIds, observedAt: message.timestamp });
  if (message.kind === GOSSIP_KINDS.REPAIR_REQUEST && message.payload?.vaultId && message.payload?.shardId) {
    await publishControlObject("repair-request", "open", message.payload, 1800000).catch(() => {});
    window.dispatchEvent(new CustomEvent("meshvault:repair-advisory", { detail: message.payload }));
  }
  if (message.kind === GOSSIP_KINDS.MANIFEST_REQUEST && deviceSigner && activeNode) {
    const local = await getLocalManifest(message.payload.manifestId);
    if (local) broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.MANIFEST_AVAILABILITY, { manifestId: message.payload.manifestId, nodeId: activeNode.id }));
  }
  if (message.kind === GOSSIP_KINDS.FRAGMENT_REQUEST && deviceSigner && activeNode) {
    if (await hasShardSafe(message.payload.shardHash)) broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.FRAGMENT_AVAILABILITY, { shardHash: message.payload.shardHash, nodeId: activeNode.id }));
  }
}
async function announceRepairNeed(event) {
  const request = event?.detail;
  if (!deviceSigner || !activeNode || !request?.vaultId || !request?.shardId) return;
  const payload = { ...request, sourceNodeId: activeNode.id, expiresAt: Date.now() + 1800000 };
  await publishRepairAdvisory(payload).catch(() => {});
  try { broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.REPAIR_REQUEST, payload, { expiresInMs: 1800000 })); } catch {}
}
async function announceTopology() {
  if (!deviceSigner || !activeNode) return;
  const connectedNodeIds = connectedProtocols().map((peer) => peer.nodeId);
  recordTopologyObservation({ nodeId: activeNode.id, devicePublicKey: deviceSigner.publicKey, connectedNodeIds });
  if (connectedNodeIds.length) broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.TOPOLOGY_ANNOUNCE, { nodeId: activeNode.id, connectedNodeIds }));
}
async function announcePresence() {
  if (!deviceSigner || !activeNode) return;
  const anchor = await anchorStatus().catch(() => ({ enabled: false }));
  broadcastGossip(await buildGossipMessage(deviceSigner, GOSSIP_KINDS.PEER_ANNOUNCE, {
    nodeId: activeNode.id, nodeName: activeNode.device_label, protocolVersion: 3,
    capabilities: nodeControlCapabilities(), capacityBytes: Number(activeNode.capacity_bytes) || 0,
    usedBytes: Number(activeNode.used_bytes) || 0, countryCode: activeNode.country_code || null,
    regionCode: activeNode.region_code || null, networkDomainHash: activeNode.network_domain_hash || null,
    failureDomainId: activeNode.failure_domain_id || null, reliabilityScore: activeNode.reliability_score ?? null,
    survivalMode: !!activeNode.survival_mode, leaseExpiresAt: activeNode.lease_expires_at || null,
    uptimeSeconds: activeNode.uptime_seconds ?? null, buddyNodeIds: activeNode.buddy_node_ids || [],
    anchorProtocolVersion: anchor.enabled ? Number(window.__DATA__?.anchor?.protocolVersion || 3) : 0,
    anchorControlCapacityBytes: anchor.enabled ? Number(anchor.cacheLimitBytes || 0) : 0,
    anchorControlUsedBytes: anchor.enabled ? Number(anchor.bytesUsed || 0) : 0,
    anchorConnectedNodes: anchor.enabled ? Number(anchor.servedPeers || 0) : 0,
    coordinationMode: coordinationState.mode,
  }));
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
  const unique = Array.from(new Map((entries || []).map((entry) => [entry?.nodeId || entry?.peerId, entry])).values()).filter(Boolean);
  anchorAssignments = selectAnchorAssignments(unique, ownNodeId, coordinationConfig());
  const primaryIds = new Set(anchorAssignments.primary.map((entry) => entry.nodeId || entry.peerId));
  const reserveIds = new Set(anchorAssignments.reserve.map((entry) => entry.nodeId || entry.peerId));
  const ordinary = unique.filter((entry) => {
    const id = entry?.nodeId || entry?.peerId;
    return id && id !== ownNodeId && !primaryIds.has(id) && !reserveIds.has(id);
  });
  const selected = [...anchorAssignments.primary, ...ordinary].slice(0, coordinationConfig().maximumPeerConnections || 12);
  const candidates = new Set();
  for (const entry of [...selected, ...anchorAssignments.reserve]) {
    const nodeId = entry?.nodeId || entry?.peerId;
    if (!nodeId || nodeId === ownNodeId || candidates.has(nodeId)) continue;
    if (Number(entry.protocolVersion || 0) < 3) continue;
    candidates.add(nodeId);
    upsertPeer({
      peerId: nodeId,
      nodeName: entry.nodeName,
      devicePublicKey: entry.devicePublicKey,
      protocolVersion: entry.protocolVersion,
      capacityBytes: Number(entry.capacityBytes) || 0,
      usedBytes: Number(entry.usedBytes) || 0,
      countryCode: entry.countryCode || null,
      regionCode: entry.regionCode || null,
      networkDomainHash: entry.networkDomainHash || null,
      failureDomainId: entry.failureDomainId || null,
      capabilities: entry.capabilities || [],
      reliabilityScore: entry.reliabilityScore,
      survivalMode: entry.survivalMode,
      leaseExpiresAt: entry.leaseExpiresAt,
      anchorProtocolVersion: entry.anchorProtocolVersion,
      anchorControlCapacityBytes: entry.anchorControlCapacityBytes,
      anchorControlUsedBytes: entry.anchorControlUsedBytes,
      anchorConnectedNodes: entry.anchorConnectedNodes,
      coordinationMode: entry.coordinationMode,
      trustStatus: entry.source || "discovered",
    });
    const external = backboneStorageProtocol(entry);
    if (external) registerExternalProtocol(nodeId, external, { ...entry, devicePublicKey: entry.devicePublicKey || null, quality: external.metrics?.() || null });
    else if (!reserveIds.has(nodeId)) connectPeer(nodeId).catch(() => {});
  }
  window.dispatchEvent(new CustomEvent("meshvault:anchor-assignments", { detail: {
    primaryNodeIds: Array.from(primaryIds), reserveNodeIds: Array.from(reserveIds),
  } }));
}

export async function activateNode(deviceIdentity, vaultId, capacityBytes, iceServers = [], locationHint = null, { transient = false, transientCacheBytes = 0 } = {}) {
  ensureProvidersRegistered();
  deviceSigner = { publicKey: deviceIdentity.devicePublicKey, algorithm: deviceIdentity.algorithm, sign: deviceIdentity.sign };
  setContributionQuota(transient ? Math.max(0, Number(transientCacheBytes) || 0) : capacityBytes);
  const storedId = `${window.__DATA__.appStoragePrefix}nodeId`; const knownId = localStorage.getItem(storedId);
  const authUserId = await currentAuthUserId();
  const estimate = await storageEstimate();
  const baseValues = { vault_id: vaultId || null, supabase_auth_id: authUserId, device_public_key: deviceIdentity.devicePublicKey, device_label: deviceLabel(deviceIdentity.label), failure_domain_id: `browser-profile:${deviceIdentity.deviceId}`, status: capacityBytes > 0 || transient ? "online" : "paused", capacity_bytes: capacityBytes, used_bytes: Math.min(capacityBytes, estimate.usage || 0), last_seen_at: new Date().toISOString() };
  const protocolValues = { coordination_protocol_version: 3 };
  const locationValues = locationHint ? { country_code: locationHint.countryCode || null, region_code: locationHint.regionCode || null, network_domain_hash: locationHint.networkDomainHash || null, location_source: locationHint.source || "unknown", location_updated_at: locationHint.observedAt || new Date().toISOString() } : {};
  const persist = async (payload) => { const query = knownId ? appTable("nodes").update(payload).eq("id", knownId).eq("supabase_auth_id", authUserId) : appTable("nodes").insert(payload); let result = await query.select().maybeSingle(); if (!result.data && knownId && !result.error) result = await appTable("nodes").insert({ id: knownId, ...payload }).select().single(); return result; };
  let { data, error } = await persist({ ...baseValues, ...locationValues, ...protocolValues }).catch((persistError) => ({ data: null, error: persistError }));
  if (error && /coordination_protocol_version/i.test(`${error.message || ""} ${error.details || ""}`)) throw new Error("This coordination backend has not been upgraded to protocol v3.");
  if (error && /country_code|region_code|network_domain_hash|location_source|location_updated_at/i.test(`${error.message || ""} ${error.details || ""}`)) ({ data, error } = await persist({ ...baseValues, ...protocolValues }).catch((persistError) => ({ data: null, error: persistError })));
  if (!error && data) lastSupabaseHeartbeatAt = Date.now();
  if (error || !data) data = { id: knownId || crypto.randomUUID(), ...baseValues, ...locationValues, ...protocolValues, coordination_status: "local-only" };
  const latestDeviceLabel = deviceLabel(pendingNodeLabel || deviceIdentity.label);
  if (data.device_label !== latestDeviceLabel) {
    data.device_label = latestDeviceLabel;
    if (!error) appTable("nodes").update({ device_label: latestDeviceLabel }).eq("id", data.id).catch(() => {});
  }
  activeNode = data; activeNode._lifecycleController = new AbortController(); localStorage.setItem(storedId, data.id);
  const presencePayload = () => activeNode ? { nodeId: activeNode.id, nodeName: activeNode.device_label, devicePublicKey: deviceIdentity.devicePublicKey, protocolVersion: 3, capabilities: nodeControlCapabilities(), capacityBytes: Number(activeNode.capacity_bytes) || 0, usedBytes: Number(activeNode.used_bytes) || 0, countryCode: activeNode.country_code || null, regionCode: activeNode.region_code || null, networkDomainHash: activeNode.network_domain_hash || null, failureDomainId: activeNode.failure_domain_id || null, reliabilityScore: activeNode.reliability_score ?? null, survivalMode: !!activeNode.survival_mode, leaseExpiresAt: activeNode.lease_expires_at || null, uptimeSeconds: activeNode.uptime_seconds ?? null, buddyNodeIds: activeNode.buddy_node_ids || [], anchorProtocolVersion: anchorCapabilities().length ? Number(window.__DATA__?.anchor?.protocolVersion || 3) : 0, coordinationMode: coordinationState.mode } : null;
  configureAnchorPeerProvider({ getPresencePayload: presencePayload });
  configureBackboneSeedProvider({ nodeId: data.id, signer: deviceSigner, getPresencePayload: presencePayload });
  await configureAnchorService({ nodeId: data.id, deviceIdentity, getPeers: connectedProtocols, peerInfo: getPeer, getCoordinationStatus: coordinationStatus });
  configurePeers({
    fromNodeId: data.id, iceServers, onState: (nodeId, status) => {
      window.dispatchEvent(new CustomEvent("meshvault:peer-state", { detail: { nodeId, status } }));
      refreshCoordinationMode().catch(() => {});
      if (["connected", "disconnected", "failed", "closed", "timed-out"].includes(status)) announceTopology().catch(() => {});
      // Presence and control replication are useful after a channel opens,
      // not for every intermediate ICE state transition.
      if (status === "connected") {
        announcePresence().catch(() => {});
        replicatePendingControlObjects().catch(() => {});
      }
    },
    isAnchor: () => anchorCapabilities().length > 0,
    protocolHandlers: {
      onShard: storeIncomingShard,
      onProofRequest: (shardHash) => getShard(shardHash),
    },
    onFragmentRequest: async (peer, shardHash, requestId) => {
      const key = requestId ? `${peer.nodeId}:${requestId}` : null;
      const controller = new AbortController();
      if (key) outgoingFragmentRequests.set(key, controller);
      try {
        const bytes = await getShard(shardHash);
        if (bytes) await peer.protocol.sendShard(shardHash, bytes, await hashHex(bytes), undefined, { signal: controller.signal });
      } catch {}
      finally { if (key) outgoingFragmentRequests.delete(key); }
    },
    onFragmentRequestCancel: (peer, requestId) => {
      const key = requestId ? `${peer.nodeId}:${requestId}` : null;
      if (!key) return;
      outgoingFragmentRequests.get(key)?.abort(new DOMException("Requester has enough shards", "AbortError"));
      outgoingFragmentRequests.delete(key);
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
  // A persisted Backbone setting must renew its sparse discovery lease after
  // every restart; otherwise it looks ordinary until the next long heartbeat.
  if (anchorCapabilities().length) await heartbeatNode({ forceSupabase: true }).catch(() => {});
  window.addEventListener("meshvault:backbone-shard", async (event) => {
    const detail = event.detail || {};
    if (!detail.bytes || !detail.shardHash) return;
    window.dispatchEvent(new CustomEvent("meshvault:shard-pulse", { detail: { fromNodeId: detail.fromNodeId, toNodeId: data.id, shardHash: detail.shardHash } }));
    await storeIncomingShard(detail.shardHash, detail.bytes, detail.shardHash).catch(() => {});
  }, { signal: activeNode._lifecycleController?.signal });
  activeNode._unsubscribePresence = onPresence((entries) => connectPresenceEntries(entries, data.id));
  await processPendingLocalDeletions(data.id).catch(() => {});
  await processDistributedDeletionOrders(data.id).catch(() => {});
  const discoveries = await discoverPeers({ minimumCandidates: 1, force: true, excludeProviders: [supabaseBootstrapProvider.name] }).catch(() => []);
  connectPresenceEntries(discoveries.flatMap((entry) => entry.result || []), data.id);
  await refreshCoordinationMode();
  await publishMeshPresence();
  connectFallbackAfterMeshAttempt(data.id).catch(() => {});
  scheduleHeartbeat();
  window.addEventListener("meshvault:anchor-status", refreshCoordinationMode);
  window.addEventListener("meshvault:repair-needed", announceRepairNeed);
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
  const available = connectedProtocols().find((peer) => peer.nodeId === nodeId);
  if (available?.protocol) return available;
  await connectPeer(nodeId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = connectedProtocols().find((peer) => peer.nodeId === nodeId);
    if (connected?.protocol) return connected;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Peer connection did not become ready in time.");
}
export async function heartbeatNode({ forceSupabase = false } = {}) {
  if (!activeNode) return;
  await refreshCoordinationMode();
  const estimate = await storageEstimate();
  const usedBytes = Math.min(activeNode.capacity_bytes, estimate.usage || 0);
  activeNode.used_bytes = usedBytes;
  const anchor = await anchorStatus().catch(() => ({ enabled: false }));
  const now = new Date();
  const coreValues = { last_seen_at: now.toISOString(), status: activeNode.status, used_bytes: usedBytes };
  if (anchor.enabled) coreValues.lease_expires_at = new Date(now.getTime() + Number(coordinationConfig().supabaseBackboneLeaseMs || 900000)).toISOString();
  const coordinationValues = {
    coordination_protocol_version: 3,
    anchor_protocol_version: anchor.enabled ? Number(window.__DATA__?.anchor?.protocolVersion || 3) : 0,
    anchor_control_capacity_bytes: anchor.enabled ? Number(anchor.cacheLimitBytes || 0) : 0,
    anchor_control_used_bytes: anchor.enabled ? Number(anchor.bytesUsed || 0) : 0,
    anchor_connected_nodes: anchor.enabled ? Number(anchor.servedPeers || 0) : 0,
    anchor_observed_capacity_bytes: anchor.enabled ? Number(anchor.observedCapacityBytes || 0) : 0,
    anchor_observed_used_bytes: anchor.enabled ? Number(anchor.observedUsedBytes || 0) : 0,
    coordination_mode: coordinationState.mode,
    last_anchor_report_at: anchor.enabled ? now.toISOString() : null,
  };
  const survivalValues = {
    survival_mode: !!activeNode.survival_mode,
    lifecycle_state: activeNode.lifecycle_state || (anchor.enabled ? "serving" : "stopped"),
    lease_expires_at: anchor.enabled ? coreValues.lease_expires_at : null,
    session_started_at: activeNode.session_started_at || null,
    uptime_seconds: Math.max(0, Math.floor(Number(activeNode.uptime_seconds) || 0)),
    reliability_score: Math.max(0, Math.min(1, Number(activeNode.reliability_score) || 0)),
    wake_lock_active: !!activeNode.wake_lock_active,
    buddy_node_ids: (activeNode.buddy_node_ids || []).slice(0, 4),
    last_handoff_at: activeNode.last_handoff_at || null,
  };
  Object.assign(activeNode, coreValues);
  const writeBackbone = forceSupabase || shouldWriteSupabaseHeartbeat(
    coordinationState.mode,
    !!anchor.enabled,
    lastSupabaseHeartbeatAt,
    now.getTime(),
    coordinationConfig(),
  );
  if (writeBackbone) {
    let supabaseReachable = false;
    try {
      let result = await appTable("nodes").update({ ...coreValues, ...survivalValues, ...coordinationValues }).eq("id", activeNode.id);
      if (result.error) result = await appTable("nodes").update(coreValues).eq("id", activeNode.id);
      supabaseReachable = !result.error;
    } catch {}
    if (supabaseReachable) lastSupabaseHeartbeatAt = now.getTime();
    markProviderStatus(supabaseBootstrapProvider.name, supabaseReachable);
    if (!supabaseReachable) connectSupabaseInBackground(activeNode.id);
  }
  await refreshCoordinationMode();
  const discoveries = await discoverForCoordination().catch(() => []);
  connectPresenceEntries(discoveries.flatMap((entry) => entry.result || []), activeNode.id);
  await Promise.all([publishMeshPresence(), measureConnectedPeers().catch(() => []), replicatePendingControlObjects().catch(() => 0)]);
  await processDistributedDeletionOrders(activeNode.id).catch(() => {});
  await announceTopology();
  await announcePresence();
}
export async function refreshNodePeers() {
  if (!activeNode) return 0;
  await refreshCoordinationMode();
  if (!meshFirstMode() && !isProviderUp(supabaseBootstrapProvider.name)) connectSupabaseInBackground(activeNode.id);
  const discoveries = await discoverForCoordination().catch(() => []);
  connectPresenceEntries(discoveries.flatMap((entry) => entry.result || []), activeNode.id);
  await publishMeshPresence();
  await announceTopology().catch(() => {});
  await announcePresence().catch(() => {});
  return connectedProtocols().length;
}
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
  // Survival metrics change every 30 seconds. Merge them into the next
  // already-scheduled heartbeat rather than opening a second write stream.
  return values;
}
export async function setNodePaused(paused) { if (!activeNode) return; activeNode.status = paused ? "paused" : "online"; try { await appTable("nodes").update({ status: activeNode.status, last_seen_at: new Date().toISOString() }).eq("id", activeNode.id); } catch {} await announcePresence().catch(() => {}); }
export async function updateNodeCapacity(bytes) { if (!activeNode) return; const capacity = Math.max(0, Number(bytes) || 0); setContributionQuota(capacity); activeNode.capacity_bytes = capacity; activeNode.used_bytes = Math.min(activeNode.used_bytes, capacity); activeNode.status = capacity ? activeNode.status : "paused"; try { await appTable("nodes").update({ capacity_bytes: capacity, used_bytes: activeNode.used_bytes, status: activeNode.status }).eq("id", activeNode.id); } catch {} await announcePresence().catch(() => {}); }
export async function updateNodeLabel(label) {
  pendingNodeLabel = String(label || "Browser node").trim().slice(0, 80) || "Browser node";
  if (!activeNode) return pendingNodeLabel;
  activeNode.device_label = pendingNodeLabel;
  try { await appTable("nodes").update({ device_label: activeNode.device_label }).eq("id", activeNode.id); } catch {}
  await announcePresence().catch(() => {});
  return activeNode.device_label;
}
export async function pauseNode() {
  if (heartbeat) clearTimeout(heartbeat); heartbeat = null;
  if (bootstrapReconnect) clearTimeout(bootstrapReconnect); bootstrapReconnect = null;
  for (const controller of outgoingFragmentRequests.values()) controller.abort(new DOMException("Node paused", "AbortError"));
  outgoingFragmentRequests.clear();
  const stoppingNode = activeNode; activeNode = null;
  lastSupabaseHeartbeatAt = 0;
  lastBackboneDiscoveryAt = 0;
  supabaseFallbackOpened = false;
  if (stoppingNode) { stoppingNode._lifecycleController?.abort(); stoppingNode._unsubscribePresence?.(); try { await appTable("nodes").update({ status: "offline", lifecycle_state: "stopped", lease_expires_at: new Date().toISOString(), wake_lock_active: false, last_seen_at: new Date().toISOString() }).eq("id", stoppingNode.id); } catch { try { await appTable("nodes").update({ status: "offline", last_seen_at: new Date().toISOString() }).eq("id", stoppingNode.id); } catch {} } }
  window.removeEventListener("meshvault:anchor-status", refreshCoordinationMode);
  window.removeEventListener("meshvault:repair-needed", announceRepairNeed);
  await stopAnchorService(); closePeers(); clearTopologyObservations(); await disconnectBackboneSeeds(); await supabaseBootstrapProvider.disconnectNode().catch(() => {});
}
export async function clearLocalNodeStorage() {
  await setNodePaused(true);
  // Never erase content-addressed bytes without a persisted node identity: the
  // mesh would otherwise keep reporting its placements as verified. Requiring
  // the node to be active lets us record loss before touching OPFS/IndexedDB.
  if (!activeNode?.id) throw new Error("Start this node before clearing its shared storage.");
  const { data: placements, error } = await appTable("shard_placements")
    .select("id,vault_id,shard_id,role,status,deletion_authorization,segment_shards(shard_hash)")
    .eq("node_id", activeNode.id)
    .in("status", ["pending", "stored", "verified", "suspect", "unavailable", "surplus", "retiring", "deleting"]);
  if (error) throw new Error("The mesh could not safely record that these local shards are being removed.");
  const lifecycleRows = (placements || []).filter((placement) => ["retiring", "deleting"].includes(placement.status));
  for (const placement of lifecycleRows) {
    const shardHash = placement.segment_shards?.shard_hash;
    if (!shardHash) continue;
    if (placement.deletion_authorization) {
      await acknowledgeShardDeletion(activeNode.id, shardHash, placement.deletion_authorization).catch(() => false);
    } else {
      await acknowledgeLifecycleShardDeletion(activeNode.id, shardHash).catch(() => false);
    }
  }
  const placementIds = (placements || [])
    .filter((placement) => !["retiring", "deleting"].includes(placement.status))
    .map((placement) => placement.id);
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
    if (placement.role === "durable" && !["retiring", "deleting"].includes(placement.status)) {
      await queueShardRepair(placement.vault_id, placement.shard_id).catch(() => {});
    }
  }
  return clearShards();
}
export function currentNode() { return activeNode; }
export function coordinationStatus() {
  return {
    ...coordinationState,
    targetAnchors: coordinationConfig().targetAnchors || 3,
    primaryAnchorNodeIds: anchorAssignments.primary.map((entry) => entry.nodeId || entry.peerId),
    reserveAnchorNodeIds: anchorAssignments.reserve.map((entry) => entry.nodeId || entry.peerId),
    supabaseRealtime: supabaseBootstrapProvider.realtimeStatus(),
    backboneSeeds: backboneSeedStatus(),
  };
}
