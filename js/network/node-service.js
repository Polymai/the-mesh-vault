import { appTable, clearAnonymousSessionLocally, ensureAnonymousSession, supabase } from "../services/supabase.js";
import { registerProvider, onPresence, markProviderStatus, isProviderUp, discoverPeers, publishPresence, setCoordinationMode } from "./providers/provider-registry.js";
import { PROVIDER_KINDS } from "./providers/provider-types.js";
import { supabaseBootstrapProvider } from "./providers/supabase-bootstrap-provider.js";
import { localPeerBootstrapProvider } from "./providers/local-peer-bootstrap-provider.js";
import { inviteLinkBootstrapProvider } from "./providers/invite-link-bootstrap-provider.js";
import { anchorPeerBootstrapProvider, configureAnchorPeerProvider } from "./providers/anchor-peer-bootstrap-provider.js";
import { backboneSeedProvider, backboneSeedStatus, backboneStorageProtocol, configureBackboneSeedProvider, disconnectBackboneSeeds } from "./providers/backbone-seed-provider.js";
import { configurePeers, updatePeerIceServers, connectPeer, closePeers, broadcastGossip, connectedProtocol, connectedProtocols, measureConnectedPeers, registerExternalProtocol } from "./peer-manager.js";
import { setContributionQuota, storageEstimate, putShard, getShard, deleteShard, clearShards } from "../storage/fragment-store.js";
import { bytesToBase64Url, canonicalBytes, hashHex } from "../security/signing.js";
import { upsertPeer, updatePeerCapacity, recordManifestAnnouncement, recordFragmentAnnouncement, holdersForManifest, holdersForFragment, getPeer } from "./peer-registry.js";
import { getLocalManifest } from "./manifest-discovery.js";
import { announceHeldFragment } from "./fragment-discovery.js";
import { buildGossipMessage, GOSSIP_KINDS } from "./gossip.js";
import { recordTopologyObservation, clearTopologyObservations } from "./topology-registry.js";
import {
  configureAnchorService, stopAnchorService, anchorCapabilities, nodeControlCapabilities, acceptControlObject, answerControlQuery,
  acceptManifestReplica, receiveRelayedSignal, publishControlObject, replicatePendingControlObjects, anchorStatus,
} from "./anchor-service.js";
import {
  listContentSegments, queueShardRepair, refreshPhysicalStorageTotals,
  transitionShardPlacement,
} from "../services/segment-service.js";
import {
  acknowledgeShardDeletion, acknowledgeLifecycleShardDeletion,
  processDistributedDeletionOrders,
} from "../services/deletion-service.js";
import {
  COORDINATION_MODES, evaluateCoordination, heartbeatIntervalMs, isHealthyAnchor, isHealthyControlParticipant, isHealthyBackbone,
  jitteredInterval, selectAnchorAssignments,
} from "./coordination-policy.js";
import { publishRepairAdvisory } from "./distributed-repair.js";
import {
  closeSupabaseFallbackWindow, configureSupabaseBootstrapPolicy, markSupabaseBootstrapComplete,
  openSupabaseFallbackWindow, supabaseBootstrapState, supabaseProviderAllowed,
  setVerifiedMeshRoute, supabaseAutomaticFallbackEnabled,
  supabaseFallbackWindowOpen, withNodeRegistrationRecoveryRequest,
} from "./supabase-fallback-policy.js";
import { patientZeroOperatorEnabled } from "../platform/patient-zero-operator.js";
import { loadPatientZeroAuthorityBundle, patientZeroAuthorityState } from "./patient-zero-authority-chain.js";

let heartbeat = null; let fallbackCloseTimer = null; let bootstrapConnecting = false;
let activeNode = null; let providersRegistered = false; let deviceSigner = null; let pendingNodeLabel = null;
let anchorAssignments = { primary: [], reserve: [] };
let coordinationState = evaluateCoordination({}, { anchorCount: 0, supabaseUp: false });
let lastSupabaseHeartbeatAt = 0;
let lastBackboneDiscoveryAt = 0;
let supabaseFallbackOpened = false;
let supabaseDiscoveryPending = false;
let nodeRegistrationPromise = null;
let nodeRegistrationError = "";
let bootstrapRetirementPromise = null;
let fallbackIceConfigLoader = null;
let fallbackIceConfigPromise = null;
const incomingShardWrites = new Map();
const outgoingFragmentRequests = new Map();
const latestPeerAnnouncements = new Map();
const MAX_CACHED_PEER_ANNOUNCEMENTS = 128;

function coordinationConfig() { return window.__DATA__?.coordination || {}; }
function meshFirstMode() {
  return [COORDINATION_MODES.HYBRID, COORDINATION_MODES.ANCHOR_PRIMARY, COORDINATION_MODES.MESH_DEGRADED].includes(coordinationState.mode);
}
function verifiedMeshRouteAvailable() {
  return connectedParticipantCount() > 0 || connectedBackboneCount() > 0;
}
export function hasVerifiedMeshRoute() { return verifiedMeshRouteAvailable(); }
async function discoverForCoordination({ force = false, forceBackbone = false } = {}) {
  const config = coordinationConfig();
  const backboneDue = forceBackbone || !meshFirstMode()
    || Date.now() - lastBackboneDiscoveryAt >= Number(config.backboneDiscoveryRefreshMs || 600000);
  const results = await discoverPeers({
    minimumCandidates: backboneDue ? Number(config.minimumPeerCandidates || 8) : 1,
    force,
    requireProvider: null,
    // A Backbone refresh is mesh traffic. Supabase is excluded until the
    // bounded first-contact gate has actually opened for this app lifecycle.
    excludeProviders: supabaseDiscoveryPending ? [] : [supabaseBootstrapProvider.name],
  }).catch(() => []);
  supabaseDiscoveryPending = false;
  if (results.some((entry) => entry.provider === backboneSeedProvider.name)) lastBackboneDiscoveryAt = Date.now();
  return results;
}
async function publishMeshPresence() {
  // Publish to already-known mesh providers before opening first contact.
  return publishPresence({
    excludeProviders: [supabaseBootstrapProvider.name],
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
  const verifiedMeshRoute = setVerifiedMeshRoute(verifiedMeshRouteAvailable());
  const next = evaluateCoordination(coordinationState, {
    anchorCount: connectedAnchorCount(),
    participantCount: connectedParticipantCount(),
    backboneCount: connectedBackboneCount(),
    // Supabase can influence coordination only inside the bounded first-contact
    // window, or on the deployment's pinned Patient Zero listener.
    supabaseUp: supabaseProviderAllowed()
      && isProviderUp(supabaseBootstrapProvider.name),
  }, coordinationConfig());
  const changed = next.mode !== coordinationState.mode;
  coordinationState = next;
  setCoordinationMode(next.mode);
  // Patient Zero keeps a tiny signaling listener open so a disconnected cold
  // start can make first contact. Every ordinary node closes Supabase for the
  // rest of its active lifecycle after a verified mesh route is established.
  // Never let a render, focus refresh or coordination recalculation open the
  // hosted channel before the explicit first-contact transaction has
  // registered this node. connectSupabaseInBackground owns that transition.
  const needsRealtime = supabaseFallbackOpened && (
    supabaseBootstrapState().patientZeroListener
    || (!verifiedMeshRoute
      && [COORDINATION_MODES.SUPABASE_PRIMARY, COORDINATION_MODES.HYBRID].includes(next.mode))
  );
  await supabaseBootstrapProvider.setRealtimeEnabled(needsRealtime).catch(() => {});
  if (verifiedMeshRoute) {
    supabaseFallbackOpened = false;
    supabaseDiscoveryPending = false;
    closeSupabaseFallbackWindow();
  }
  if (changed) {
    scheduleHeartbeat();
    window.dispatchEvent(new CustomEvent("meshvault:coordination-status", { detail: coordinationStatus() }));
  }
  return next;
}

function activeNodeRegistrationValues(authUserId) {
  if (!activeNode) return null;
  return {
    // Patient Zero is a deployment bootstrap identity, not a member of one
    // user's vault. Linking this short-lived hosted row to a local-only vault
    // can fail its foreign key and would disclose an unnecessary association.
    vault_id: null,
    supabase_auth_id: authUserId,
    device_public_key: activeNode.device_public_key,
    device_label: activeNode.device_label,
    failure_domain_id: activeNode.failure_domain_id,
    status: activeNode.status,
    capacity_bytes: Number(activeNode.capacity_bytes) || 0,
    used_bytes: Number(activeNode.used_bytes) || 0,
    last_seen_at: new Date().toISOString(),
    coordination_protocol_version: 3,
    ...(activeNode.country_code || activeNode.region_code || activeNode.network_domain_hash ? {
      country_code: activeNode.country_code || null,
      region_code: activeNode.region_code || null,
      network_domain_hash: activeNode.network_domain_hash || null,
      location_source: activeNode.location_source || "unknown",
      location_updated_at: activeNode.location_updated_at || new Date().toISOString(),
    } : {}),
  };
}

function isNodeRegistrationConflict(error) {
  const detail = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`;
  return /23505|duplicate key|nodes_pkey/i.test(detail);
}

async function reclaimSupabaseNodeRegistration(nodeId, authUserId) {
  if (!deviceSigner?.publicKey || typeof deviceSigner.sign !== "function") {
    throw new Error("The local device identity is not ready to reclaim its node registration.");
  }
  const statement = {
    protocol: "themeshvault-node-registration-v3",
    action: "reclaim",
    nodeId,
    authUserId,
    devicePublicKey: deviceSigner.publicKey,
    issuedAt: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  };
  const signature = bytesToBase64Url(await deviceSigner.sign(canonicalBytes(statement)));
  const { data, error } = await withNodeRegistrationRecoveryRequest(() =>
    supabase.functions.invoke("app717-meshvault-api", {
      body: { action: "reclaim-node-registration", statement, signature, clientProtocolVersion: 3 },
    }));
  if (error || !data?.reclaimed || String(data?.nodeId || "") !== String(nodeId)) {
    let message = String(error?.message || data?.error || "The existing node registration could not be reclaimed.");
    const response = error?.context;
    if (response && typeof response.clone === "function") {
      try {
        const payload = await response.clone().json();
        message = String(payload?.error || payload?.message || message);
      } catch { /* Keep the SDK error when the response is not JSON. */ }
    }
    throw new Error(message);
  }
  return String(data.nodeId);
}

async function writeSupabaseNodeRegistration(nodeId, authUserId, values) {
  let result = await appTable("nodes").update(values)
    .eq("id", nodeId).eq("supabase_auth_id", authUserId)
    .select().maybeSingle();
  if (!result.data && !result.error) {
    result = await appTable("nodes").insert({ id: nodeId, ...values }).select().single();
  }
  if (isNodeRegistrationConflict(result.error)) {
    await reclaimSupabaseNodeRegistration(nodeId, authUserId);
    result = await appTable("nodes").update(values)
      .eq("id", nodeId).eq("supabase_auth_id", authUserId)
      .select().single();
  }
  return result;
}

async function ensurePatientZeroNodeRegistration() {
  // Patient Zero has a stable node address as well as a pinned signing key.
  // Never hide a registration failure by silently generating another UUID:
  // ordinary nodes would keep discovering the old address and no peer channel
  // could be completed. The signed reclaim endpoint owns this recovery path.
  return ensureSupabaseNodeRegistration();
}

async function ensureSupabaseNodeRegistration() {
  if (!activeNode) throw new Error("No local node is active.");
  if (activeNode._supabaseRegistered) return activeNode;
  if (nodeRegistrationPromise) return nodeRegistrationPromise;
  const registeringNodeId = activeNode.id;
  nodeRegistrationPromise = (async () => {
    nodeRegistrationError = "";
    const authUserId = (await ensureAnonymousSession({
      refreshIfExpiring: supabaseBootstrapState().patientZeroListener,
    }))?.user?.id || null;
    if (!authUserId || activeNode?.id !== registeringNodeId) throw new Error("The anonymous coordination session is not ready.");
    const values = activeNodeRegistrationValues(authUserId);
    let result = await writeSupabaseNodeRegistration(registeringNodeId, authUserId, values);
    if (result.error && /country_code|region_code|network_domain_hash|location_source|location_updated_at/i.test(`${result.error.message || ""} ${result.error.details || ""}`)) {
      const compatible = { ...values };
      delete compatible.country_code;
      delete compatible.region_code;
      delete compatible.network_domain_hash;
      delete compatible.location_source;
      delete compatible.location_updated_at;
      result = await writeSupabaseNodeRegistration(registeringNodeId, authUserId, compatible);
    }
    if (result.error || !result.data) throw result.error || new Error("The fallback node registration failed.");
    if (activeNode?.id !== registeringNodeId) return activeNode;
    Object.assign(activeNode, result.data, { _supabaseRegistered: true });
    lastSupabaseHeartbeatAt = Date.now();
    return activeNode;
  })();
  try { return await nodeRegistrationPromise; }
  catch (error) {
    nodeRegistrationError = String(error?.message || "Patient Zero registration failed.").slice(0, 240);
    window.dispatchEvent(new CustomEvent("meshvault:coordination-status", { detail: coordinationStatus() }));
    throw error;
  }
  finally { nodeRegistrationPromise = null; }
}

async function retireOrdinaryBootstrapRegistration() {
  if (!activeNode || supabaseBootstrapState().patientZeroListener || supabaseBootstrapState().completed) return;
  if (bootstrapRetirementPromise) return bootstrapRetirementPromise;
  const retiringNodeId = activeNode.id;
  bootstrapRetirementPromise = (async () => {
    // Removing the short-lived row is part of the same first-contact session.
    // Failure is intentionally not retried in this lifecycle: avoiding a
    // hosted cleanup loop matters more than deleting a short-lived public row.
    if (activeNode?._supabaseRegistered && supabaseProviderAllowed()) {
      const { error } = await appTable("nodes").delete().eq("id", retiringNodeId);
      if (error) throw error;
    }
    if (activeNode?.id !== retiringNodeId) return;
    await clearAnonymousSessionLocally();
    markSupabaseBootstrapComplete();
    supabaseFallbackOpened = false;
    supabaseDiscoveryPending = false;
    closeSupabaseFallbackWindow();
    await supabaseBootstrapProvider.setRealtimeEnabled(false).catch(() => {});
    await supabaseBootstrapProvider.disconnectNode().catch(() => {});
  })();
  try { await bootstrapRetirementPromise; }
  finally { bootstrapRetirementPromise = null; }
}

function connectSupabaseInBackground(nodeId) {
  if (!nodeId || bootstrapConnecting || activeNode?.id !== nodeId || !supabaseProviderAllowed()) return;
  bootstrapConnecting = true;
  const patientZero = supabaseBootstrapState().patientZeroListener;
  ensureSupabaseNodeRegistration().then(() => supabaseBootstrapProvider.connectNode(nodeId, { discover: !patientZero })).then(async () => {
    if (activeNode?.id !== nodeId) return;
    markProviderStatus(supabaseBootstrapProvider.name, true);
    supabaseFallbackOpened = true;
    supabaseDiscoveryPending = !patientZero;
    clearTimeout(fallbackCloseTimer);
    if (!patientZero) {
      const remaining = Math.max(10000, Number(coordinationConfig().supabaseFallbackWindowMs || 30000));
      fallbackCloseTimer = window.setTimeout(async () => {
        fallbackCloseTimer = null;
        supabaseFallbackOpened = false;
        supabaseDiscoveryPending = false;
        closeSupabaseFallbackWindow();
        await supabaseBootstrapProvider.setRealtimeEnabled(false).catch(() => {});
        await refreshCoordinationMode().catch(() => {});
      }, remaining);
    }
    await refreshCoordinationMode();
    if (!patientZero) {
      const remoteDiscoveries = await discoverForCoordination().catch(() => []);
      const candidates = remoteDiscoveries.flatMap((entry) => entry.result || []);
      connectPresenceEntries(candidates, nodeId);
    }
    await publishMeshPresence();
  }).catch(() => {
    markProviderStatus(supabaseBootstrapProvider.name, false);
    refreshCoordinationMode().catch(() => {});
    // A failed first-contact attempt is final for this running lifecycle.
    // Restarting the app creates a new bounded attempt; no timer polls here.
  }).finally(() => { bootstrapConnecting = false; });
}

async function connectFallbackAfterMeshAttempt(nodeId) {
  const patientZero = supabaseBootstrapState().patientZeroListener;
  if (!patientZero && !supabaseAutomaticFallbackEnabled()) return;
  if (patientZero && !activeNode?._supabaseRegistered) return;
  // Patient Zero is the listener that ordinary profiles are trying to find;
  // it must register immediately. Only ordinary clients wait briefly for an
  // already-known mesh route before opening their bounded cold-start gate.
  const delay = patientZero ? 0 : Math.max(0, Number(coordinationConfig().supabaseColdStartDelayMs || 60000));
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  if (activeNode?.id !== nodeId) return;
  if (!patientZero && (connectedParticipantCount() >= Number(coordinationConfig().minimumMeshParticipants || 1)
    || connectedBackboneCount() >= Number(coordinationConfig().minimumBackbonePeers || 1))) {
    await refreshCoordinationMode();
    return;
  }
  if (!openSupabaseFallbackWindow({ force: patientZero })) return;
  if (fallbackIceConfigLoader) {
    if (!fallbackIceConfigPromise) fallbackIceConfigPromise = Promise.resolve().then(() => fallbackIceConfigLoader()).catch(() => null);
    const connection = await fallbackIceConfigPromise;
    if (connection?.iceServers?.length) updatePeerIceServers(connection.iceServers);
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
  registerProvider(PROVIDER_KINDS.PEER_DISCOVERY, localPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PRESENCE, localPeerBootstrapProvider);
  registerProvider(PROVIDER_KINDS.PEER_DISCOVERY, inviteLinkBootstrapProvider);
}
async function handleGossipMessage(_peer, message) {
  if (message.kind === GOSSIP_KINDS.PEER_ANNOUNCE) {
    latestPeerAnnouncements.delete(message.payload.nodeId);
    latestPeerAnnouncements.set(message.payload.nodeId, message);
    while (latestPeerAnnouncements.size > MAX_CACHED_PEER_ANNOUNCEMENTS) {
      latestPeerAnnouncements.delete(latestPeerAnnouncements.keys().next().value);
    }
    upsertPeer({ peerId: message.payload.nodeId, nodeName: message.payload.nodeName, devicePublicKey: message.senderPublicKey, protocolVersion: message.payload.protocolVersion, capacityBytes: message.payload.capacityBytes, usedBytes: message.payload.usedBytes, countryCode: message.payload.countryCode, regionCode: message.payload.regionCode, networkDomainHash: message.payload.networkDomainHash, failureDomainId: message.payload.failureDomainId, capabilities: message.payload.capabilities || [], reliabilityScore: message.payload.reliabilityScore, survivalMode: message.payload.survivalMode, leaseExpiresAt: message.payload.leaseExpiresAt, uptimeSeconds: message.payload.uptimeSeconds, buddyNodeIds: message.payload.buddyNodeIds || [], anchorProtocolVersion: message.payload.anchorProtocolVersion, anchorControlCapacityBytes: message.payload.anchorControlCapacityBytes, anchorControlUsedBytes: message.payload.anchorControlUsedBytes, anchorConnectedNodes: message.payload.anchorConnectedNodes, coordinationMode: message.payload.coordinationMode, trustStatus: "gossiped" });
    // A directory entry is useful only if the newly learned peer can become a
    // route. Keep the fan-out bounded, but actively form the missing edge so
    // clients introduced by Patient Zero also discover and connect each other.
    const announcedNodeId = message.payload.nodeId;
    const maximumPeers = Math.max(1, Number(coordinationConfig().maximumPeerConnections || 12));
    if (announcedNodeId && announcedNodeId !== activeNode?.id
      && !connectedProtocol(announcedNodeId)
      && connectedProtocols().length < maximumPeers) {
      connectPeer(announcedNodeId).catch(() => {});
    }
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
  const message = await buildGossipMessage(deviceSigner, GOSSIP_KINDS.PEER_ANNOUNCE, {
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
  });
  latestPeerAnnouncements.delete(activeNode.id);
  latestPeerAnnouncements.set(activeNode.id, message);
  broadcastGossip(message);
}

function replayPeerDirectory(nodeId) {
  const peer = connectedProtocol(nodeId);
  if (!peer?.protocol?.sendGossip) return;
  const now = Date.now();
  for (const [announcedNodeId, message] of latestPeerAnnouncements) {
    if (message.expiresAt <= now) {
      latestPeerAnnouncements.delete(announcedNodeId);
      continue;
    }
    if (announcedNodeId === nodeId || announcedNodeId === activeNode?.id) continue;
    peer.protocol.sendGossip(message);
  }
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
    const firstContact = entry.source === "supabase";
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
    // Use the peer manager's deterministic offer owner for every connection,
    // including first contact. Forcing every new node to create an offer made
    // simultaneous Patient Zero handshakes collide and left only the latest
    // attempt usable. Each node pair now has exactly one offer owner, while
    // Patient Zero keeps an independent RTCPeerConnection for every client.
    else if (firstContact || !reserveIds.has(nodeId)) connectPeer(nodeId).catch(() => {});
  }
  window.dispatchEvent(new CustomEvent("meshvault:anchor-assignments", { detail: {
    primaryNodeIds: Array.from(primaryIds), reserveNodeIds: Array.from(reserveIds),
  } }));
}

export async function activateNode(deviceIdentity, vaultId, capacityBytes, iceServers = [], locationHint = null, { transient = false, transientCacheBytes = 0, fallbackIceLoader = null } = {}) {
  ensureProvidersRegistered();
  deviceSigner = { publicKey: deviceIdentity.devicePublicKey, algorithm: deviceIdentity.algorithm, sign: deviceIdentity.sign };
  await loadPatientZeroAuthorityBundle().catch(() => null);
  fallbackIceConfigLoader = typeof fallbackIceLoader === "function" ? fallbackIceLoader : null;
  fallbackIceConfigPromise = null;
  nodeRegistrationError = "";
  setContributionQuota(transient ? Math.max(0, Number(transientCacheBytes) || 0) : capacityBytes);
  const storedId = `${window.__DATA__.appStoragePrefix}nodeId`; const knownId = localStorage.getItem(storedId);
  const estimate = await storageEstimate();
  const baseValues = { vault_id: vaultId || null, supabase_auth_id: null, device_public_key: deviceIdentity.devicePublicKey, device_label: deviceLabel(deviceIdentity.label), failure_domain_id: `browser-profile:${deviceIdentity.deviceId}`, status: capacityBytes > 0 || transient ? "online" : "paused", capacity_bytes: capacityBytes, used_bytes: Math.min(capacityBytes, estimate.usage || 0), last_seen_at: new Date().toISOString() };
  const protocolValues = { coordination_protocol_version: 3 };
  const locationValues = locationHint ? { country_code: locationHint.countryCode || null, region_code: locationHint.regionCode || null, network_domain_hash: locationHint.networkDomainHash || null, location_source: locationHint.source || "unknown", location_updated_at: locationHint.observedAt || new Date().toISOString() } : {};
  const data = { id: knownId || crypto.randomUUID(), ...baseValues, ...locationValues, ...protocolValues, coordination_status: "mesh-first", _supabaseRegistered: false };
  const latestDeviceLabel = deviceLabel(pendingNodeLabel || deviceIdentity.label);
  data.device_label = latestDeviceLabel;
  activeNode = data; activeNode._lifecycleController = new AbortController(); localStorage.setItem(storedId, data.id);
  const patientZero = patientZeroOperatorEnabled(deviceIdentity.devicePublicKey);
  configureSupabaseBootstrapPolicy({ nodeId: data.id, patientZero });
  // Register the listener before peers begin cold-start discovery. Registration
  // is a hard prerequisite for Patient Zero: showing a local green state while
  // the hosted first-contact row is missing traps every new node in cold start.
  if (patientZero) {
    await ensurePatientZeroNodeRegistration();
  }
  const presencePayload = () => activeNode ? { nodeId: activeNode.id, nodeName: activeNode.device_label, devicePublicKey: deviceIdentity.devicePublicKey, protocolVersion: 3, capabilities: nodeControlCapabilities(), capacityBytes: Number(activeNode.capacity_bytes) || 0, usedBytes: Number(activeNode.used_bytes) || 0, countryCode: activeNode.country_code || null, regionCode: activeNode.region_code || null, networkDomainHash: activeNode.network_domain_hash || null, failureDomainId: activeNode.failure_domain_id || null, reliabilityScore: activeNode.reliability_score ?? null, survivalMode: !!activeNode.survival_mode, leaseExpiresAt: activeNode.lease_expires_at || null, uptimeSeconds: activeNode.uptime_seconds ?? null, buddyNodeIds: activeNode.buddy_node_ids || [], anchorProtocolVersion: anchorCapabilities().length ? Number(window.__DATA__?.anchor?.protocolVersion || 3) : 0, coordinationMode: coordinationState.mode } : null;
  configureAnchorPeerProvider({ getPresencePayload: presencePayload });
  configureBackboneSeedProvider({ nodeId: data.id, signer: deviceSigner, getPresencePayload: presencePayload });
  await configureAnchorService({ nodeId: data.id, deviceIdentity, getPeers: connectedProtocols, peerInfo: getPeer, getCoordinationStatus: coordinationStatus });
  configurePeers({
    fromNodeId: data.id, iceServers, onState: (nodeId, status) => {
      window.dispatchEvent(new CustomEvent("meshvault:peer-state", { detail: { nodeId, status } }));
      if (["connected", "disconnected", "failed", "closed", "timed-out"].includes(status)) announceTopology().catch(() => {});
      // Presence and control replication are useful after a channel opens,
      // not for every intermediate ICE state transition.
      if (status === "connected") {
        if (!supabaseBootstrapState().patientZeroListener) {
          retireOrdinaryBootstrapRegistration().catch(() => {}).finally(() => refreshCoordinationMode().catch(() => {}));
        } else refreshCoordinationMode().catch(() => {});
        announcePresence().catch(() => {});
        replicatePendingControlObjects().catch(() => {});
      } else refreshCoordinationMode().catch(() => {});
    },
    onProtocolConnected: async (peer) => {
      // Mainframe can serve many independent channels. Replay what it already
      // knows to this one peer, then immediately publish this profile so the
      // rest of the connected mesh learns the new route and its real capacity.
      replayPeerDirectory(peer.nodeId);
      await announcePresence();
      await announceTopology();
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
  // Every ordinary profile starts mesh-first. If no verified mesh route
  // answers, the bounded path below contacts only the pinned Patient Zero.
  window.addEventListener("meshvault:backbone-shard", async (event) => {
    const detail = event.detail || {};
    if (!detail.bytes || !detail.shardHash) return;
    window.dispatchEvent(new CustomEvent("meshvault:shard-pulse", { detail: { fromNodeId: detail.fromNodeId, toNodeId: data.id, shardHash: detail.shardHash } }));
    await storeIncomingShard(detail.shardHash, detail.bytes, detail.shardHash).catch(() => {});
  }, { signal: activeNode._lifecycleController?.signal });
  activeNode._unsubscribePresence = onPresence((entries) => connectPresenceEntries(entries, data.id));
  // Startup never scans hosted file or shard-placement tables. Signed mesh
  // deletion orders are read from local/connected control participants.
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
  const patientZeroListener = supabaseBootstrapState().patientZeroListener;
  const writeBackbone = activeNode._supabaseRegistered
    && patientZeroListener
    && (forceSupabase || now.getTime() - lastSupabaseHeartbeatAt >= Number(coordinationConfig().supabaseHeartbeatMs || 600000));
  if (writeBackbone) {
    let supabaseReachable = false;
    try {
      if (patientZeroListener) await ensureAnonymousSession({ refreshIfExpiring: true });
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
export async function setNodePaused(paused) { if (!activeNode) return; activeNode.status = paused ? "paused" : "online"; if (supabaseFallbackOpened && supabaseFallbackWindowOpen() && activeNode._supabaseRegistered) try { await appTable("nodes").update({ status: activeNode.status, last_seen_at: new Date().toISOString() }).eq("id", activeNode.id); } catch {} await announcePresence().catch(() => {}); }
export async function updateNodeCapacity(bytes) { if (!activeNode) return; const capacity = Math.max(0, Number(bytes) || 0); setContributionQuota(capacity); activeNode.capacity_bytes = capacity; activeNode.used_bytes = Math.min(activeNode.used_bytes, capacity); activeNode.status = capacity ? activeNode.status : "paused"; if (supabaseFallbackOpened && supabaseFallbackWindowOpen() && activeNode._supabaseRegistered) try { await appTable("nodes").update({ capacity_bytes: capacity, used_bytes: activeNode.used_bytes, status: activeNode.status }).eq("id", activeNode.id); } catch {} await announcePresence().catch(() => {}); }
export async function updateNodeLabel(label) {
  pendingNodeLabel = String(label || "Browser node").trim().slice(0, 80) || "Browser node";
  if (!activeNode) return pendingNodeLabel;
  activeNode.device_label = pendingNodeLabel;
  if (supabaseFallbackOpened && supabaseFallbackWindowOpen() && activeNode._supabaseRegistered) try { await appTable("nodes").update({ device_label: activeNode.device_label }).eq("id", activeNode.id); } catch {}
  await announcePresence().catch(() => {});
  return activeNode.device_label;
}
export async function pauseNode() {
  if (heartbeat) clearTimeout(heartbeat); heartbeat = null;
  if (fallbackCloseTimer) clearTimeout(fallbackCloseTimer); fallbackCloseTimer = null;
  for (const controller of outgoingFragmentRequests.values()) controller.abort(new DOMException("Node paused", "AbortError"));
  outgoingFragmentRequests.clear();
  latestPeerAnnouncements.clear();
  const stoppingNode = activeNode; activeNode = null;
  lastSupabaseHeartbeatAt = 0;
  lastBackboneDiscoveryAt = 0;
  supabaseFallbackOpened = false;
  supabaseDiscoveryPending = false;
  setVerifiedMeshRoute(false);
  closeSupabaseFallbackWindow();
  nodeRegistrationPromise = null;
  bootstrapRetirementPromise = null;
  fallbackIceConfigLoader = null;
  fallbackIceConfigPromise = null;
  // Do not create a final unload request. The signed lease expires naturally;
  // pagehide/beforeunload writes were both unreliable and needlessly chatty.
  if (stoppingNode) { stoppingNode._lifecycleController?.abort(); stoppingNode._unsubscribePresence?.(); }
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
  const segments = await listContentSegments();
  const placements = [];
  for (const segment of segments) for (const shard of segment.segment_shards || []) {
    for (const placement of shard.shard_placements || []) if (placement.node_id === activeNode.id && placement.status !== "deleted") {
      placements.push({ ...placement, vault_id: segment.vault_id, shard_id: shard.id, shard_hash: shard.shard_hash });
    }
  }
  const lifecycleRows = placements.filter((placement) => ["retiring", "deleting"].includes(placement.status));
  for (const placement of lifecycleRows) {
    const shardHash = placement.shard_hash;
    if (!shardHash) continue;
    if (placement.deletion_authorization) {
      await acknowledgeShardDeletion(activeNode.id, shardHash, placement.deletion_authorization).catch(() => false);
    } else {
      await acknowledgeLifecycleShardDeletion(activeNode.id, shardHash).catch(() => false);
    }
  }
  for (const placement of placements) {
    if (!["retiring", "deleting"].includes(placement.status)) {
      await transitionShardPlacement(placement.vault_id, placement.id, "unavailable");
    }
    if (placement.role === "durable" && !["retiring", "deleting"].includes(placement.status)) {
      await queueShardRepair(placement.vault_id, placement.shard_id).catch(() => {});
    }
  }
  return clearShards();
}
export function currentNode() { return activeNode; }
export function currentDeviceSigner() { return deviceSigner; }
export async function exportPatientZeroPublicSetup() {
  const authority = patientZeroAuthorityState();
  return {
    enabled: true,
    authorityPublicKeys: authority.genesisPublicKey ? [authority.genesisPublicKey] : [],
    activeAuthorityPublicKey: authority.activeAuthorityPublicKey || null,
    responderDevicePublicKey: authority.responderDevicePublicKey || null,
    authoritySequence: Number(authority.sequence || 0),
    staticResponders: [],
    relayUrls: [],
    transport: "supabase-first-contact-only",
  };
}
export function coordinationStatus() {
  return {
    ...coordinationState,
    targetAnchors: coordinationConfig().targetAnchors || 3,
    primaryAnchorNodeIds: anchorAssignments.primary.map((entry) => entry.nodeId || entry.peerId),
    reserveAnchorNodeIds: anchorAssignments.reserve.map((entry) => entry.nodeId || entry.peerId),
    supabaseRealtime: { ...supabaseBootstrapProvider.realtimeStatus(), registrationError: nodeRegistrationError },
    backboneSeeds: backboneSeedStatus(),
    distributedRendezvous: { enabled: false, relays: { configured: 0, connected: 0 }, peers: 0 },
  };
}
