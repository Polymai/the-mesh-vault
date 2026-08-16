import { getState, setState, updateNested, subscribe, announce } from "./state/store.js";
import {
  loadOrCreateVaultIdentity, hasStoredVaultIdentity, currentVaultIdentity, markMeshKeySaved,
  meshKeyRecoveryPhrase, qrPayload, exportMeshKeyFile, restoreVaultFromFile, restoreVaultFromPhrase, verifyMeshKeyPhrase,
} from "./identity/vault-identity.js";
import { loadOrCreateDeviceIdentity, renameDevice } from "./identity/device-identity.js";
import { listFiles, listPendingFileDeletions, listFolders, createFolder, moveFileRecord, deleteFolderRecord } from "./services/metadata-service.js";
import { getPeerIceConfig } from "./services/network-service.js";
import { getContributionLimit, setContributionLimit, getStorageNodeOnly, setStorageNodeOnly, getVaultProfile, setVaultProfile, getErasureClass, setErasureClass, getAnchorSettings } from "./services/vault-service.js";
import { uploadFile } from "./flows/upload-flow.js";
import { downloadFile } from "./flows/download-flow.js";
import { deleteFile } from "./flows/delete-flow.js";
import { previewFolderDeletion, deleteFolder } from "./flows/delete-folder-flow.js";
import { createShareLink } from "./flows/share-flow.js";
import { activateNode, setNodePaused, updateNodeCapacity, updateNodeLabel, heartbeatNode, refreshNodePeers, updateNodeSurvivalTelemetry, clearLocalNodeStorage, pauseNode, exportPatientZeroPublicSetup, hasVerifiedMeshRoute, coordinationStatus } from "./network/node-service.js";
import { anchorStatus } from "./network/anchor-service.js";
import { requestBrowserLocationHint } from "./geo/browser-location.js";
import { requestRecoveryCycle, startRecoveryCoordinator, stopRecoveryCoordinator } from "./network/recovery-coordinator.js";
import { computeNetworkStatus, computeFileResilienceFromVersion } from "./network/resilience-v2.js";
import { connectedProtocols } from "./network/peer-manager.js";
import { getPeer, listKnownPeers } from "./network/peer-registry.js";
import { requestPersistence, storageEstimate } from "./storage/fragment-store.js";
import { getOperationLog, appendOperation, onSyncNeeded } from "./oplog/oplog-engine.js";
import { OP_TYPES } from "./oplog/operation-types.js";
import {
  clearControlRepository, configureControlRepository, flushControlPlane,
  loadReplicatedOperations, loadVaultCatalog, publishVaultCatalog,
} from "./control/control-repository.js";
import { listTrustedDevices } from "./identity/device-registry.js";
import { startRouter, renderApp } from "./router.js";
import { configureSurvivalService, configureWakeAssistance, disableWakeAssistance, setSurvivalMode, survivalStatus, requestBuddyWake, stopSurvivalService } from "./network/survival-service.js";
import { configurePwaInstall, requestPwaInstall, copyPublicAppLink, sharePublicAppLink } from "./platform/pwa-install.js";
import { sharedLaunchBatchId, loadSharedBatch, markSharedEntryImported, finishSharedLaunch } from "./platform/share-target.js";
import { performV3LocalReset, scheduleVaultLocalReset } from "./platform/v3-storage-reset.js";
import { disablePatientZeroOperator as clearPatientZeroOperator } from "./platform/patient-zero-operator.js";
import {
  clearNativeNodeStorage, configureNativeNode, isNativeBackgroundActive, nativeNodeStatus, openNativePowerSettings,
  restartNativeNode, startNativeNode, stopNativeNode,
} from "./platform/native-node.js";

let initialized = false;
let syncingOplog = false;
let importingSharedLaunch = false;
let liveMeshRefreshTimer = null;
let nativeNodeRefreshTimer = null;
let liveMeshRefreshPromise = null;
let coordinationSyncPromise = null;
let lastCoordinationSyncAt = 0;
let lastForegroundRefreshAt = 0;
const coordinationConfig = () => window.__DATA__?.coordination || {};
const LIVE_MESH_REFRESH_MS = Number(coordinationConfig().liveMeshRefreshMs || 120000);
const FOREGROUND_REFRESH_COOLDOWN_MS = Number(coordinationConfig().foregroundRefreshCooldownMs || 30000);
const PUBLIC_ROUTE_HASHES = new Set(["", "#/home", "#/onboarding", "#/security", "#/terms", "#/privacy"]);
function isPublicRouteHash(hash = location.hash) {
  return PUBLIC_ROUTE_HASHES.has(String(hash).split("?")[0]) || String(hash).startsWith("#/share/");
}
function currentSigner() { const identity = currentVaultIdentity(); return identity ? { publicKey: identity.ownerPublicKey, algorithm: identity.algorithm, sign: identity.sign } : null; }
function meshBootstrapAvailable() {
  return hasVerifiedMeshRoute() || coordinationStatus()?.fallbackActive === true;
}
function refreshConnectivityState() {
  const connectedPeerCount = connectedProtocols().length; const bootstrapUp = meshBootstrapAvailable();
  updateNested("network", { connectedPeerCount, bootstrapUp, status: computeNetworkStatus({ connectedPeerCount, bootstrapUp, peerDiscoveryUp: true }) });
}

function observedMeshOverview(state = getState()) {
  const peers = listKnownPeers();
  const nativeActive = isNativeBackgroundActive(state.nativeNode);
  const local = state.node?.id ? {
    id: state.node.id,
    vault_id: state.identity?.vaultId || null,
    device_label: state.node.label,
    status: state.node.status,
    // The native Android worker and its WebView are one physical device. When
    // native storage is active, report its capacity on the visible local node
    // instead of counting the same phone twice or showing zero on Overview.
    capacity_bytes: Number(nativeActive ? state.nativeNode.capacityBytes : state.node.capacityBytes) || 0,
    used_bytes: Number(nativeActive ? state.nativeNode.usedBytes : state.node.usedBytes) || 0,
    country_code: state.node.countryCode || null,
    region_code: state.node.regionCode || null,
    last_seen_at: new Date().toISOString(),
  } : null;
  const nodes = [local, ...peers.map((peer) => ({
    id: peer.peerId,
    device_public_key: peer.devicePublicKey || null,
    device_label: peer.nodeName || "Mesh peer",
    failure_domain_id: peer.failureDomainId || peer.peerId,
    status: "online",
    capacity_bytes: Number(peer.capacityBytes || 0),
    used_bytes: Number(peer.usedBytes || 0),
    country_code: peer.countryCode || null,
    region_code: peer.regionCode || null,
    network_domain_hash: peer.networkDomainHash || null,
    reliability_score: peer.reliabilityScore,
    survival_mode: !!peer.survivalMode,
    lease_expires_at: peer.leaseExpiresAt || null,
    uptime_seconds: peer.uptimeSeconds,
    anchor_protocol_version: Number(peer.anchorProtocolVersion || 0),
    last_seen_at: new Date(peer.lastSeenAt || Date.now()).toISOString(),
  }))].filter(Boolean);
  return {
    nodes,
    events: state.network.events || [],
    snapshots: state.network.snapshots || [],
    activeNodes: nodes.filter((node) => node.status === "online").length,
    verifiedCapacity: nodes.reduce((sum, node) => sum + Number(node.capacity_bytes || 0), 0),
    usedBytes: nodes.reduce((sum, node) => sum + Number(node.used_bytes || 0), 0),
  };
}

function commitObservedMeshOverview() {
  const state = getState();
  const network = observedMeshOverview(state);
  const bootstrapUp = meshBootstrapAvailable();
  const connectedPeerCount = connectedProtocols().length;
  setState({
    nodes: network.nodes,
    network: {
      ...state.network,
      ...network,
      connectedPeerCount,
      bootstrapUp,
      status: computeNetworkStatus({ connectedPeerCount, bootstrapUp, peerDiscoveryUp: true }),
      resilientBytes: state.network.resilientBytes || 0,
    },
  });
  return network;
}

async function refreshLiveMesh({ includeOverview = false } = {}) {
  if (liveMeshRefreshPromise) return liveMeshRefreshPromise;
  liveMeshRefreshPromise = (async () => {
    await refreshNodePeers().catch(() => 0);
    refreshConnectivityState();
    // Live Mesh is an observed topology, not a hosted database report. Never
    // turn entering the view or its timer into a Supabase overview query.
    commitObservedMeshOverview();
  })().finally(() => { liveMeshRefreshPromise = null; });
  return liveMeshRefreshPromise;
}

function refreshForegroundRuntime() {
  if (document.visibilityState === "hidden") return;
  const now = Date.now();
  if (now - lastForegroundRefreshAt < FOREGROUND_REFRESH_COOLDOWN_MS) return;
  lastForegroundRefreshAt = now;
  heartbeatNode().catch(() => {}).finally(() => {
    if (getState().route === "mesh") refreshLiveMesh().catch(() => {});
  });
}

function startLiveMeshRefresh() {
  if (liveMeshRefreshTimer) return;
  liveMeshRefreshTimer = window.setInterval(() => {
    if (document.visibilityState !== "hidden" && getState().route === "mesh") refreshLiveMesh().catch(() => {});
  }, LIVE_MESH_REFRESH_MS);
}

async function pushOperationLog() {
  if (syncingOplog) return; const identity = getState().identity; if (!identity?.vaultId) return;
  syncingOplog = true;
  try { await flushControlPlane(); }
  finally { syncingOplog = false; }
}

function summarizeVaultStorage(files) {
  const profiles = new Map();
  const summary = {
    uniqueSegments: 0, uniqueOriginalBytes: 0, representationBytes: 0,
    compressionSavedBytes: 0, physicalBytes: 0, physicalShardCopies: 0,
    surplusPlacements: 0, profiles: [],
  };
  for (const file of files || []) {
    const version = file.version || {};
    summary.uniqueSegments += Number(version.segment_count || 0);
    summary.uniqueOriginalBytes += Number(file.size_bytes || version.original_size_bytes || 0);
    summary.representationBytes += Number(version.representation_size_bytes || 0);
    summary.compressionSavedBytes += Number(version.compression_saved_bytes || 0);
    summary.physicalBytes += Number(version.physical_storage_bytes || 0);
    summary.physicalShardCopies += Number(version.physical_shard_copies || 0);
    summary.surplusPlacements += Number(version.surplus_placements || 0);
    const required = Number(version.minimum_required_shards || 0);
    const total = Number(version.total_shards || 0);
    if (required && total >= required) {
      const profile = `${required}+${total - required}`;
      profiles.set(profile, Number(profiles.get(profile) || 0) + Number(version.segment_count || 0));
    }
  }
  summary.profiles = [...profiles].map(([profile, segmentCount]) => ({ profile, segmentCount }));
  return summary;
}

async function refreshPrivateData({ includeOverview = false } = {}) {
  const state = getState(); if (!state.identity?.vaultId) return;
  const vaultId = state.identity.vaultId;
  const emptyNetwork = { nodes: state.nodes || [], events: state.network.events || [], snapshots: state.network.snapshots || [], activeNodes: state.network.activeNodes || 0, verifiedCapacity: state.network.verifiedCapacity || 0, usedBytes: state.network.usedBytes || 0 };
  const meshRouteAvailable = hasVerifiedMeshRoute();
  const [files, pendingDeletions, folders, network, log] = await Promise.all([
    listFiles(vaultId),
    listPendingFileDeletions(vaultId).catch(() => state.pendingDeletions || []),
    listFolders(vaultId).catch(() => state.folders || []),
    meshRouteAvailable ? observedMeshOverview(state) : emptyNetwork,
    getOperationLog(vaultId).catch(() => []),
  ]);
  const vaultStorage = summarizeVaultStorage(files);
  const bootstrapUp = meshBootstrapAvailable(); const connectedPeerCount = connectedProtocols().length;
  const peerNetworkActive = connectedPeerCount > 0;
  const measuredFiles = await Promise.all(files.map(async (file) => ({ ...file, resilience: await computeFileResilienceFromVersion({ version: file.version, bootstrapUp, peerNetworkActive }) })));
  setState({ files: measuredFiles, pendingDeletions, folders, nodes: network.nodes.length ? network.nodes : state.nodes, vaultStorage, network: { ...network, connectedPeerCount, bootstrapUp, status: computeNetworkStatus({ connectedPeerCount, bootstrapUp, peerDiscoveryUp: true }), resilientBytes: network.snapshots.at(-1)?.resilient_bytes || state.network.resilientBytes || 0 }, trustedDevices: listTrustedDevices(log, state.identity.ownerPublicKey) });
}

async function syncVaultCoordination(identity, { force = false } = {}) {
  if (!identity?.vaultId) return false;
  if (coordinationSyncPromise) return coordinationSyncPromise;
  if (!force && Date.now() - lastCoordinationSyncAt < Number(coordinationConfig().operationSyncCooldownMs || 1800000)) return false;
  coordinationSyncPromise = (async () => {
    const meshRouteAvailable = hasVerifiedMeshRoute();
    const [catalog, _operations, localProfile] = await Promise.all([
      loadVaultCatalog({ includeAnchors: meshRouteAvailable }).catch(() => null),
      loadReplicatedOperations({ force }).catch(() => null),
      getVaultProfile(identity.vaultId).catch(() => null),
    ]);
    if (!catalog) {
      await publishVaultCatalog({
        folders: [], files: [], segments: [], versionSegments: [], tombstones: [], repairState: [],
      }).catch(() => {});
    }
    await flushControlPlane().catch(() => {});
    if (localProfile && getState().identity?.vaultId === identity.vaultId) setState({ vaultProfile: localProfile });
    lastCoordinationSyncAt = Date.now();
    await refreshPrivateData();
    return true;
  })().finally(() => { coordinationSyncPromise = null; });
  return coordinationSyncPromise;
}
async function importSharedLaunchIfReady() {
  const batchId = sharedLaunchBatchId();
  const identity = currentVaultIdentity();
  if (!batchId || !identity || importingSharedLaunch) return false;
  importingSharedLaunch = true;
  location.hash = `#/drive?share-target=${encodeURIComponent(batchId)}`;
  try {
    const batch = await loadSharedBatch(batchId);
    if (!batch) {
      finishSharedLaunch(batchId);
      announce("The shared-file inbox was unavailable. Share the file again from its source app.", "warning", 9000);
      return false;
    }
    if (batch.rejectedCount) {
      announce(`${batch.rejectedCount} shared ${batch.rejectedCount === 1 ? "file was" : "files were"} skipped because the 100 MB file or 250 MB batch limit was exceeded.`, "warning", 10000);
    }
    if (!batch.entries.length) {
      finishSharedLaunch(batchId);
      if (!batch.rejectedCount) announce("No supported files were included in the share.", "warning");
      return false;
    }
    let imported = 0;
    for (const entry of batch.entries) {
      try {
        await uploadFile(entry.file, { vaultIdentity: identity, folderId: null, resilienceClass: getState().erasureClass });
        await markSharedEntryImported(batchId, entry.id);
        imported += 1;
      } catch (error) {
        await refreshPrivateData().catch(() => {});
        announce(`“${entry.file.name}” remains in the local share inbox and will retry when this launch is reopened: ${error.message}`, "error", 12000);
        return false;
      }
    }
    await refreshPrivateData();
    finishSharedLaunch(batchId);
    announce(`${imported} shared ${imported === 1 ? "file" : "files"} secured in TheMeshVault.`, "success", 8000);
    return true;
  } finally {
    importingSharedLaunch = false;
  }
}
async function linkAccount() {
  throw new Error("Optional hosted accounts are disabled in mesh-only protocol v3. Your Mesh Key owns this vault.");
}
async function unlinkAccount() {
  setState({ accountLink: null });
  announce("Account link removed from this device.", "info");
}
async function startDevice(deviceIdentity, vaultId) {
  // A node/mesh-side failure (e.g. the bootstrap provider being unreachable
  // or not yet provisioned) must never block reaching the vault itself -
  // the vault is locally owned and usable regardless of mesh connectivity.
  try {
    // Start with cached peers, invites and public STUN. A brand-new profile
    // receives one bounded Supabase first-contact window to Patient Zero;
    // TURN credentials are requested only inside that same temporary window.
    const [browserHint, capacityBytes, nativeStatus] = await Promise.all([
      requestBrowserLocationHint().catch(() => null),
      getContributionLimit(),
      nativeNodeStatus({ refresh: true }),
    ]);
    const locationHint = browserHint ? { countryCode: browserHint.countryCode, regionCode: null, networkDomainHash: null, source: browserHint.source, observedAt: browserHint.observedAt } : null;
    const nativeActive = isNativeBackgroundActive(nativeStatus);
    const browserCapacity = nativeActive ? 0 : capacityBytes;
    const node = await activateNode(
      deviceIdentity,
      vaultId,
      browserCapacity,
      [],
      locationHint,
      {
        ...(nativeActive ? { transient: true, transientCacheBytes: 32 * 1024 * 1024 } : {}),
        fallbackIceLoader: () => getPeerIceConfig(5000),
      },
    );
    const estimate = await storageEstimate();
    updateNested("node", {
      id: node.id, status: node.status, capacityBytes: Number(node.capacity_bytes), usedBytes: Number(node.used_bytes),
      label: node.device_label || deviceIdentity.label,
      persistence: estimate.persistent ? "granted" : "available",
      countryCode: node.country_code || null, regionCode: node.region_code || null,
      locationSource: node.location_source || null, locationUpdatedAt: node.location_updated_at || null,
    });
    setState({ contributionLimitBytes: capacityBytes, nativeNode: nativeStatus });
    updateNested("anchor", { ...(await anchorStatus()), nodeName: deviceIdentity.label });
    await configureSurvivalService({
      nodeId: node.id,
      getPeers: connectedProtocols,
      peerInfo: getPeer,
      renewLease: updateNodeSurvivalTelemetry,
    });
    updateNested("survival", survivalStatus());
    await pushOperationLog().catch(() => {});
    setState((state) => ({ nodes: [node, ...(state.nodes || []).filter((entry) => entry.id !== node.id)] }));
    // Overview and Live Mesh consume the aggregate network state. Keep it in
    // sync immediately from local observations; do not wait for a hosted
    // overview response or for the user to open Live Mesh first.
    commitObservedMeshOverview();
    startRecoveryCoordinator({
      shouldRun: (reason) => {
        const state = getState();
        const hasVaultWork = (state.files || []).length > 0 || (state.pendingDeletions || []).length > 0;
        const eventDriven = ["file-changed", "deletion-changed", "profile-changed", "repair-needed", "repair-advisory", "maintenance", "peer-connected", "online"].includes(reason);
        return document.visibilityState !== "hidden"
          && !!state.identity?.vaultId
          && hasVaultWork
          && connectedProtocols().length > 0
          && eventDriven;
      },
      // A peer reconnect is not permission to query the hosted metadata plane.
      // User changes and genuine mesh repair events remain event-driven.
      runWhenReady: false,
    });
    if (nativeActive && nativeStatus.vaultId !== (vaultId || null)) {
      const refreshedNative = await restartNativeNode(getState(), capacityBytes).catch(() => nativeStatus);
      updateNested("nativeNode", refreshedNative);
    } else if (nativeStatus.supported && !nativeActive) {
      await configureNativeNode(getState(), capacityBytes).catch(() => null);
    }
  } catch (error) {
    updateNested("node", { status: "offline" });
    announce(`This device could not join the mesh right now: ${error.message}. Your vault is still available locally.`, "warning", 10000);
  }
}
async function enterVault(identity) {
  configureControlRepository(identity);
  const [vaultProfile, erasureClass] = await Promise.all([getVaultProfile(identity.vaultId).catch(() => ({ name: "", synced: false, syncStatus: "local" })), getErasureClass()]);
  setState({ identity: { vaultId: identity.vaultId, ownerPublicKey: identity.ownerPublicKey, algorithm: identity.algorithm, meshKeySaved: identity.meshKeySaved }, vaultProfile, erasureClass, storageNodeOnly: false, boot: "ready", error: null });
  const deviceIdentity = await loadOrCreateDeviceIdentity();
  // Anchor is a locally persisted browser role. Surface it before hosted node
  // activation so a temporary Supabase/bootstrap outage cannot hide or appear
  // to revoke the role in the shell.
  const persistedAnchor = await getAnchorSettings();
  updateNested("anchor", { ...(await anchorStatus()), ...persistedAnchor, nodeName: deviceIdentity.label });
  if (["#/home", "#/onboarding", ""].includes(location.hash)) location.hash = "#/dashboard";
  const localCatalog = await loadVaultCatalog({ includeSupabase: false, includeAnchors: false }).catch(() => null);
  if (localCatalog) await refreshPrivateData().catch(() => {});
  await startDevice(deviceIdentity, identity.vaultId);
  syncVaultCoordination(identity).catch((error) => {
    announce(`Mesh coordination is temporarily unavailable: ${error.message}`, "warning", 10000);
  });
  await importSharedLaunchIfReady();
}
async function enterStorageNodeOnly() {
  await setStorageNodeOnly(true);
  const deviceIdentity = await loadOrCreateDeviceIdentity();
  setState({ identity: null, vaultProfile: { name: "" }, storageNodeOnly: true, boot: "ready", error: null });
  location.hash = "#/settings";
  await startDevice(deviceIdentity, null);
}
async function initialize() {
  setState({ boot: "loading", error: null });
  try {
    await performV3LocalReset();
    updateNested("nativeNode", await nativeNodeStatus({ refresh: true }));
    const [hasIdentity, storageNodeOnly] = await Promise.all([hasStoredVaultIdentity(), getStorageNodeOnly()]);
    if (!hasIdentity && !storageNodeOnly) {
      setState({ identity: null, vaultProfile: { name: "" }, boot: "ready" });
      if (!isPublicRouteHash()) location.hash = "#/onboarding";
      return;
    }
    if (hasIdentity) { await enterVault(await loadOrCreateVaultIdentity()); return; }
    if (storageNodeOnly) {
      const deviceIdentity = await loadOrCreateDeviceIdentity();
      setState({ identity: null, vaultProfile: { name: "" }, storageNodeOnly: true, boot: "ready" });
      await startDevice(deviceIdentity, null);
      if (!isPublicRouteHash() && location.hash !== "#/settings") location.hash = "#/settings";
      return;
    }
  } catch (error) { setState({ boot: "error", error: error.message }); }
}
const actions = {
  initialize,
  mesh: { rerender: () => renderApp(true) },
  onboarding: {
    async continueAnonymous() { await enterVault(await loadOrCreateVaultIdentity()); },
    async restoreWithFile({ fileJson }) { await enterVault(await restoreVaultFromFile(fileJson)); },
    async restoreWithPhrase({ phrase }) { await enterVault(await restoreVaultFromPhrase(phrase)); },
    async joinAsStorageNode() { await enterStorageNodeOnly(); },
  },
  drive: {
    async upload(file, folderId = null) {
      const result = await uploadFile(file, { vaultIdentity: currentVaultIdentity(), folderId, resilienceClass: getState().erasureClass });
      requestRecoveryCycle("file-changed");
      return result;
    },
    download: (fileId) => downloadFile(fileId, { vaultIdentity: currentVaultIdentity() }),
    async remove(fileId) {
      const result = await deleteFile(fileId, { vaultIdentity: currentVaultIdentity() });
      requestRecoveryCycle("deletion-changed");
      return result;
    },
    previewFolderRemoval: (folderId) => previewFolderDeletion(folderId, { vaultIdentity: currentVaultIdentity() }),
    async removeFolder(folderId) {
      const result = await deleteFolder(folderId, { vaultIdentity: currentVaultIdentity() });
      requestRecoveryCycle("deletion-changed");
      return result;
    },
    share: (fileId) => createShareLink(fileId, { vaultIdentity: currentVaultIdentity() }),
    createFolder: (name, parentId = null) => createFolder(getState().identity.vaultId, name, parentId),
    move: (fileId, folderId = null) => moveFileRecord(getState().identity.vaultId, fileId, folderId),
    refresh: refreshPrivateData, rerender: () => renderApp(true),
    error: (error) => announce(error.message, "error", 8000), notice: (message, tone, timeout) => announce(message, tone, timeout),
  },
  meshKey: {
    phrase: () => meshKeyRecoveryPhrase(), qr: () => qrPayload(), file: () => exportMeshKeyFile(), verify: (phrase) => verifyMeshKeyPhrase(phrase),
    async save() { await markMeshKeySaved(); setState((state) => ({ identity: { ...state.identity, meshKeySaved: true } })); },
  },
  devices: {
    async revoke(deviceId) { const signer = currentSigner(); if (!signer) return; await appendOperation(signer, getState().identity.vaultId, OP_TYPES.REVOKE_DEVICE, { deviceId }); await refreshPrivateData(); },
  },
  account: {
    signin: (data) => linkAccount(data.email, data.password, "signin"),
    signup: (data) => linkAccount(data.email, data.password, "signup"),
    disconnect: unlinkAccount,
  },
  settings: {
    copyAppLink: () => copyPublicAppLink(),
    shareApp: () => sharePublicAppLink(),
    disablePatientZeroOperator() {
      clearPatientZeroOperator();
      try {
        const url = new URL(location.href);
        url.searchParams.delete("patient-zero-setup");
        history.replaceState(history.state, "", url);
      } catch {}
      announce("Patient Zero tools hidden on this device.", "success", 5000);
      renderApp(true);
    },
    async copyPatientZeroSetup() {
      const setup = await exportPatientZeroPublicSetup();
      const text = JSON.stringify(setup, null, 2);
      await navigator.clipboard.writeText(text);
      announce("Patient Zero public setup copied. It contains no private key.", "success", 7000);
      return setup;
    },
    async downloadPatientZeroSetup() {
      const setup = await exportPatientZeroPublicSetup();
      const exported = {
        kind: "themeshvault-patient-zero-public-setup",
        exportedAt: new Date().toISOString(),
        ...setup,
      };
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "themeshvault-patient-zero-public-setup.json";
      link.click();
      URL.revokeObjectURL(url);
      announce("Patient Zero public setup downloaded. No private key was included.", "success", 7000);
      return exported;
    },
    async copyPatientZeroConfig() {
      const setup = await exportPatientZeroPublicSetup();
      const authorityPublicKey = setup.authorityPublicKeys?.[0] || "";
      const source = `(function () {\n  // Public Patient Zero verification key only. No private key is included.\n  window.__POLYMAI_RENDEZVOUS_CONFIG__ = Object.freeze({\n    enabled: false,\n    relayUrls: Object.freeze([]),\n    authorityPublicKeys: Object.freeze([\n      ${JSON.stringify(authorityPublicKey)}\n    ]),\n    staticResponders: Object.freeze([])\n  });\n})();\n`;
      await navigator.clipboard.writeText(source);
      announce("Patient Zero app configuration copied. Paste it into Polymai and publish.", "success", 7000);
      return source;
    },
    async installApp() {
      const result = await requestPwaInstall();
      if (result.outcome === "accepted") announce("TheMeshVault installation approved.", "success");
      else if (result.outcome === "dismissed") announce("Installation cancelled.", "info");
      else if (result.outcome === "already-installed") announce("TheMeshVault is already installed.", "info");
      else announce("Use your browser's Install command to add TheMeshVault.", "info", 7000);
      return result;
    },
    async capacity(bytes) {
      const value = await setContributionLimit(bytes);
      setState({ contributionLimitBytes: value });
      if (isNativeBackgroundActive(getState().nativeNode)) {
        const nativeNode = await restartNativeNode(getState(), value);
        updateNested("nativeNode", nativeNode);
        await updateNodeCapacity(0);
        await setNodePaused(false);
        updateNested("node", { capacityBytes: 0, status: "online" });
      } else {
        await updateNodeCapacity(value);
        updateNested("node", { capacityBytes: value, status: value ? getState().node.status : "paused" });
      }
    },
    async toggleNode() { const paused = getState().node.status === "online"; await setNodePaused(paused); updateNested("node", { status: paused ? "paused" : "online" }); },
    async persist() { const granted = await requestPersistence(); updateNested("node", { persistence: granted ? "granted" : "unavailable" }); announce(granted ? "Persistent storage enabled." : "This browser did not grant persistent storage.", granted ? "success" : "warning"); },
    async clear() { const count = await clearLocalNodeStorage(); updateNested("node", { usedBytes: 0, status: "paused" }); announce(`${count} local encrypted shards removed.`, "warning"); },
    async resilienceClass(value) {
      const erasureClass = await setErasureClass(value); setState({ erasureClass });
      requestRecoveryCycle("profile-changed");
      const message = erasureClass === "high"
        ? "Extra resilience enabled for new and upgraded segments."
        : erasureClass === "standard"
          ? "Balanced protection enabled."
          : "Automatic protection enabled.";
      announce(message, "success"); return erasureClass;
    },
    async profile({ name }) {
      const identity = currentVaultIdentity();
      if (!identity) throw new Error("Open a vault before saving profile details.");
      const vaultProfile = await setVaultProfile(identity, { name });
      setState({ vaultProfile });
      announce(vaultProfile.synced ? "Private vault name encrypted and synced." : "Private vault name saved here; encrypted sync is pending.", vaultProfile.synced ? "success" : "warning");
      return vaultProfile;
    },
    async nodeName(name) {
      const cleanedName = String(name || "Browser node").trim().slice(0, 80) || "Browser node";
      await renameDevice(cleanedName);
      await updateNodeLabel(cleanedName);
      updateNested("node", { label: cleanedName });
      updateNested("anchor", { nodeName: cleanedName });
      if (isNativeBackgroundActive(getState().nativeNode)) updateNested("nativeNode", await restartNativeNode(getState(), getState().contributionLimitBytes));
      else if (getState().nativeNode.supported) await configureNativeNode(getState(), getState().contributionLimitBytes).catch(() => null);
      announce("Public node name updated.", "success");
      return cleanedName;
    },
    async anchor({ enabled, nodeName, cacheLimitBytes }) {
      const cleanedName = String(nodeName || "Browser node").trim().slice(0, 80) || "Browser node";
      await renameDevice(cleanedName); await updateNodeLabel(cleanedName);
      updateNested("node", { label: cleanedName });
      const survival = await setSurvivalMode(enabled, { cacheLimitBytes });
      updateNested("survival", survival);
      await heartbeatNode().catch(() => {});
      updateNested("anchor", { ...(await anchorStatus()), nodeName: cleanedName });
      if (isNativeBackgroundActive(getState().nativeNode)) updateNested("nativeNode", await restartNativeNode(getState(), getState().contributionLimitBytes));
      else if (getState().nativeNode.supported) await configureNativeNode(getState(), getState().contributionLimitBytes).catch(() => null);
      const nativeActive = isNativeBackgroundActive(getState().nativeNode);
      announce(enabled
        ? nativeActive ? "Backbone mode is active in the Android background node." : "Backbone mode is active while this tab remains awake."
        : "Backbone mode stopped.", enabled ? "success" : "info", 7000);
    },
    async nativeNode(enabled) {
      if (enabled) {
        const nativeNode = await startNativeNode(getState(), getState().contributionLimitBytes);
        if (!nativeNode.running && !nativeNode.enabled) throw new Error(nativeNode.lastError || "Android did not start the background node.");
        await updateNodeCapacity(0);
        await setNodePaused(false);
        updateNested("node", { capacityBytes: 0, status: "online" });
        updateNested("nativeNode", nativeNode);
        announce("Android background node started.", "success", 7000);
        return nativeNode;
      }
      const nativeNode = await stopNativeNode();
      await updateNodeCapacity(getState().contributionLimitBytes);
      if (getState().contributionLimitBytes > 0) await setNodePaused(false);
      updateNested("node", { capacityBytes: getState().contributionLimitBytes, status: getState().contributionLimitBytes ? "online" : "paused" });
      updateNested("nativeNode", nativeNode);
      announce("Android background node stopped. Browser sharing is active while this page is open.", "info", 8000);
      return nativeNode;
    },
    async nativePowerSettings() { await openNativePowerSettings(); },
    async clearNativeStorage() {
      const wasEnabled = isNativeBackgroundActive(getState().nativeNode);
      if (wasEnabled) await stopNativeNode();
      const nativeNode = await clearNativeNodeStorage();
      updateNested("nativeNode", nativeNode);
      announce(`${nativeNode.removed} encrypted Android ${nativeNode.removed === 1 ? "piece" : "pieces"} removed.`, "warning", 8000);
      return nativeNode;
    },
    async removeVaultFromDevice() {
      const identity = currentVaultIdentity();
      if (!identity) throw new Error("No vault is open on this device.");
      if (!identity.meshKeySaved) throw new Error("Save and verify your Mesh Key before removing this vault from this device.");
      if (isNativeBackgroundActive(getState().nativeNode)) {
        const nativeNode = await stopNativeNode();
        updateNested("nativeNode", nativeNode);
      }
      await setStorageNodeOnly(false);
      scheduleVaultLocalReset(identity.vaultId, "remove-device");
      location.reload();
    },
    async deleteVaultContents(onProgress = () => {}) {
      const identity = currentVaultIdentity();
      if (!identity) throw new Error("No vault is open on this device.");
      const snapshot = getState();
      const files = [...snapshot.files];
      onProgress({ step: "files", completed: 0, total: files.length });
      for (let index = 0; index < files.length; index += 1) {
        await deleteFile(files[index].id, { vaultIdentity: identity });
        onProgress({ step: "files", completed: index + 1, total: files.length });
      }
      const folderIds = snapshot.folders.map((folder) => folder.id).filter(Boolean);
      if (folderIds.length) await deleteFolderRecord(identity.vaultId, folderIds);
      onProgress({ step: "publishing", completed: files.length, total: files.length });
      await pushOperationLog();
      if (isNativeBackgroundActive(getState().nativeNode)) {
        const nativeNode = await stopNativeNode();
        updateNested("nativeNode", nativeNode);
      }
      await setStorageNodeOnly(false);
      scheduleVaultLocalReset(identity.vaultId, "delete-vault-contents");
      location.reload();
    },
  },
  nightNode: {
    status: survivalStatus,
    async enableNotifications() {
      const survival = await configureWakeAssistance();
      updateNested("survival", survival);
      if (survival.wakeAssistance === "ready") announce("Node reminders enabled.", "success");
      else if (survival.wakeAssistance === "setup needed") announce("Node reminders are not configured. Anchor mode still works.", "warning", 8000);
      else if (survival.wakeAssistance === "blocked") announce("Node reminders are blocked. Anchor mode still works without them.", "warning", 9000);
      else announce(survival.wakeAssistanceMessage || "Node reminders could not be enabled in this browser.", "warning", 12000);
      return survival;
    },
    async disableNotifications() {
      const anchorWasEnabled = (await anchorStatus()).enabled;
      const survival = await disableWakeAssistance();
      updateNested("survival", survival);
      if (survival.wakeAssistance === "available") announce(anchorWasEnabled ? "Node reminders disabled. Anchor mode remains active." : "Node reminders disabled.", "success");
      else announce("Node reminders could not be disabled in this browser.", "warning", 8000);
      return survival;
    },
    async wake(nodeId) { const result = await requestBuddyWake(nodeId); announce("Wake request sent to the buddy node.", "success"); return result; },
    async toggle(enabled) {
      const survival = await setSurvivalMode(enabled, { fullscreen: enabled });
      updateNested("survival", survival);
      updateNested("anchor", await anchorStatus());
      announce(enabled ? "Night Node is running. Keep this device connected to power." : "Night Node stopped and its lease is expiring.", enabled ? "success" : "info", 7000);
      renderApp(true);
    },
  },
};
export async function bootstrap() {
  if (initialized) return; initialized = true;
  configurePwaInstall((installState) => updateNested("pwaInstall", installState));
  let previousRoute = getState().route;
  subscribe((state) => {
    renderApp();
    if (state.route === "mesh" && previousRoute !== "mesh") queueMicrotask(() => refreshLiveMesh({ includeOverview: true }).catch(() => {}));
    previousRoute = state.route;
  });
  onSyncNeeded(() => pushOperationLog().catch(() => {}));
  window.addEventListener("meshvault:resilience-updated", () => refreshPrivateData().catch(() => {}));
  window.addEventListener("meshvault:peer-state", (event) => {
    refreshConnectivityState();
    // The operation log is vault metadata, not connection state. Flushing it
    // on every ICE transition created unrelated coordination traffic.
    if (event.detail?.status === "connected") pushOperationLog().catch(() => {});
  });
  window.addEventListener("online", () => {
    const identity = currentVaultIdentity();
    if (identity) syncVaultCoordination(identity).catch(() => {});
    else flushControlPlane().catch(() => {});
    refreshForegroundRuntime();
  });
  window.addEventListener("meshvault:topology-updated", () => { if (getState().route === "mesh") renderApp(true); });
  window.addEventListener("meshvault:peer-registry-updated", () => { if (getState().route === "mesh") renderApp(true); });
  window.addEventListener("meshvault:anchor-status", (event) => updateNested("anchor", event.detail));
  window.addEventListener("meshvault:coordination-status", (event) => updateNested("anchor", {
    coordinationMode: event.detail?.mode || "supabase-primary",
    fallbackActive: event.detail?.fallbackActive !== false,
  }));
  window.addEventListener("meshvault:survival-status", (event) => updateNested("survival", event.detail));
  navigator.serviceWorker?.addEventListener?.("message", (event) => { if (event.data?.type === "meshvault:background-check") heartbeatNode().catch(() => {}); });
  window.addEventListener("pageshow", refreshForegroundRuntime);
  window.addEventListener("focus", refreshForegroundRuntime);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshForegroundRuntime(); });
  startLiveMeshRefresh();
  nativeNodeRefreshTimer = window.setInterval(async () => {
    if (document.visibilityState === "hidden" || !getState().nativeNode.supported) return;
    updateNested("nativeNode", await nativeNodeStatus({ refresh: true }));
  }, 15000);
  startRouter(actions); renderApp();
  // Anonymous Supabase auth is created lazily only when a bounded fallback or
  // an explicit hosted feature actually needs it.
  await initialize();
}
export function destroyApp() { if (liveMeshRefreshTimer) window.clearInterval(liveMeshRefreshTimer); liveMeshRefreshTimer = null; if (nativeNodeRefreshTimer) window.clearInterval(nativeNodeRefreshTimer); nativeNodeRefreshTimer = null; clearControlRepository(); stopRecoveryCoordinator(); stopSurvivalService().catch(() => {}); pauseNode().catch(() => {}); }
