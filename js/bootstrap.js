import { getState, setState, updateNested, subscribe, announce } from "./state/store.js";
import {
  loadOrCreateVaultIdentity, hasStoredVaultIdentity, currentVaultIdentity, markMeshKeySaved,
  meshKeyRecoveryPhrase, qrPayload, exportMeshKeyFile, restoreVaultFromFile, restoreVaultFromPhrase, verifyMeshKeyPhrase,
} from "./identity/vault-identity.js";
import { loadOrCreateDeviceIdentity, renameDevice } from "./identity/device-identity.js";
import { backfillVaultCatalog, listFiles, listPendingFileDeletions, listFolders, createFolder, moveFileRecord } from "./services/metadata-service.js";
import { getPeerIceConfig, loadNetworkOverview } from "./services/network-service.js";
import { listMyStorageNodes, loadVaultStorageSummary } from "./services/segment-service.js";
import { getContributionLimit, setContributionLimit, getStorageNodeOnly, setStorageNodeOnly, getVaultProfile, setVaultProfile, getErasureClass, setErasureClass, getAnchorSettings, ensureVaultRegistration } from "./services/vault-service.js";
import { appTable, appConfig, currentAccessToken, ensureAnonymousSession, supabase } from "./services/supabase.js";
import { uploadFile } from "./flows/upload-flow.js";
import { downloadFile } from "./flows/download-flow.js";
import { deleteFile } from "./flows/delete-flow.js";
import { previewFolderDeletion, deleteFolder } from "./flows/delete-folder-flow.js";
import { createShareLink } from "./flows/share-flow.js";
import { activateNode, setNodePaused, updateNodeCapacity, updateNodeLabel, heartbeatNode, refreshNodePeers, updateNodeSurvivalTelemetry, clearLocalNodeStorage, pauseNode } from "./network/node-service.js";
import { anchorStatus } from "./network/anchor-service.js";
import { requestBrowserLocationHint } from "./geo/browser-location.js";
import { startRecoveryCoordinator, stopRecoveryCoordinator } from "./network/recovery-coordinator.js";
import { computeNetworkStatus, computeFileResilienceFromVersion } from "./network/resilience-v2.js";
import { providerStatuses } from "./network/providers/provider-registry.js";
import { connectedProtocols } from "./network/peer-manager.js";
import { getPeer } from "./network/peer-registry.js";
import { requestPersistence, storageEstimate } from "./storage/fragment-store.js";
import { getOperationLog, appendOperation, onSyncNeeded } from "./oplog/oplog-engine.js";
import { OP_TYPES } from "./oplog/operation-types.js";
import {
  clearControlRepository, configureControlRepository, flushControlPlane,
  loadReplicatedOperations, replayCatalogOperations,
} from "./control/control-repository.js";
import { listTrustedDevices } from "./identity/device-registry.js";
import { bytesToBase64Url, canonicalBytes } from "./security/signing.js";
import { startRouter, renderApp } from "./router.js";
import { configureSurvivalService, configureWakeAssistance, disableWakeAssistance, setSurvivalMode, survivalStatus, requestBuddyWake, stopSurvivalService } from "./network/survival-service.js";
import { configurePwaInstall, requestPwaInstall, copyPublicAppLink, sharePublicAppLink } from "./platform/pwa-install.js";
import { sharedLaunchBatchId, loadSharedBatch, markSharedEntryImported, finishSharedLaunch } from "./platform/share-target.js";
import { performV3LocalReset } from "./platform/v3-storage-reset.js";

let initialized = false;
let syncingOplog = false;
let importingSharedLaunch = false;
let linkedAccountAccessToken = null;
let liveMeshRefreshTimer = null;
let liveMeshRefreshPromise = null;
let lastNetworkOverviewAt = 0;
let lastForegroundRefreshAt = 0;
const LIVE_MESH_REFRESH_MS = 15000;
const NETWORK_OVERVIEW_REFRESH_MS = 60000;
const PUBLIC_ROUTE_HASHES = new Set(["", "#/home", "#/onboarding", "#/security", "#/terms", "#/privacy"]);
function isPublicRouteHash(hash = location.hash) {
  return PUBLIC_ROUTE_HASHES.has(String(hash).split("?")[0]) || String(hash).startsWith("#/share/");
}
function currentSigner() { const identity = currentVaultIdentity(); return identity ? { publicKey: identity.ownerPublicKey, algorithm: identity.algorithm, sign: identity.sign } : null; }
function refreshConnectivityState() {
  const connectedPeerCount = connectedProtocols().length; const bootstrapUp = providerStatuses().supabase?.up !== false;
  updateNested("network", { connectedPeerCount, bootstrapUp, status: computeNetworkStatus({ connectedPeerCount, bootstrapUp, peerDiscoveryUp: true }) });
}

async function refreshLiveMesh({ includeOverview = false } = {}) {
  if (liveMeshRefreshPromise) return liveMeshRefreshPromise;
  liveMeshRefreshPromise = (async () => {
    await refreshNodePeers().catch(() => 0);
    refreshConnectivityState();
    const shouldLoadOverview = includeOverview || Date.now() - lastNetworkOverviewAt >= NETWORK_OVERVIEW_REFRESH_MS;
    if (!shouldLoadOverview) return;
    const network = await loadNetworkOverview().catch(() => null);
    if (!network) return;
    lastNetworkOverviewAt = Date.now();
    const statuses = providerStatuses();
    const bootstrapUp = statuses.supabase?.up !== false;
    const connectedPeerCount = connectedProtocols().length;
    setState((state) => ({
      nodes: network.nodes,
      network: {
        ...network,
        connectedPeerCount,
        bootstrapUp,
        status: computeNetworkStatus({ connectedPeerCount, bootstrapUp, peerDiscoveryUp: true }),
        resilientBytes: network.snapshots.at(-1)?.resilient_bytes || state.network.resilientBytes || 0,
      },
    }));
  })().finally(() => { liveMeshRefreshPromise = null; });
  return liveMeshRefreshPromise;
}

function refreshForegroundRuntime() {
  if (document.visibilityState === "hidden") return;
  const now = Date.now();
  if (now - lastForegroundRefreshAt < 1500) return;
  lastForegroundRefreshAt = now;
  heartbeatNode().catch(() => {}).finally(() => {
    if (getState().route === "mesh") refreshLiveMesh({ includeOverview: true }).catch(() => {});
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

async function loadReplicatedOperationLog(vaultId, ownerPublicKey) {
  await loadReplicatedOperations().catch(() => {});
  return getOperationLog(vaultId).catch(() => []);
}

async function refreshPrivateData() {
  const state = getState(); if (!state.identity?.vaultId) return;
  const vaultId = state.identity.vaultId;
  const emptyNetwork = { nodes: state.nodes || [], events: state.network.events || [], snapshots: state.network.snapshots || [], activeNodes: state.network.activeNodes || 0, verifiedCapacity: state.network.verifiedCapacity || 0, usedBytes: state.network.usedBytes || 0 };
  const [files, pendingDeletions, folders, network, transfers, log, myStorageNodeIds, vaultStorage, vaultProfile] = await Promise.all([
    listFiles(vaultId), listPendingFileDeletions(vaultId).catch(() => state.pendingDeletions || []), listFolders(vaultId).catch(() => state.folders || []), loadNetworkOverview().catch(() => emptyNetwork),
    appTable("transfers").select("*").eq("vault_id", vaultId).in("status", ["queued", "running"]).order("created_at", { ascending: false }).then((result) => result.error ? [] : result.data || []).catch(() => []),
    loadReplicatedOperationLog(vaultId, state.identity.ownerPublicKey), listMyStorageNodes(vaultId).catch(() => state.myStorageNodeIds || []),
    loadVaultStorageSummary(vaultId).catch(() => state.vaultStorage),
    getVaultProfile(vaultId, currentVaultIdentity()).catch(() => state.vaultProfile),
  ]);
  const statuses = providerStatuses(); const bootstrapUp = statuses.supabase?.up !== false; const connectedPeerCount = connectedProtocols().length;
  const peerNetworkActive = connectedPeerCount > 0;
  const measuredFiles = await Promise.all(files.map(async (file) => ({ ...file, resilience: await computeFileResilienceFromVersion({ version: file.version, bootstrapUp, peerNetworkActive }) })));
  setState({ files: measuredFiles, pendingDeletions, folders, nodes: network.nodes, transfers, vaultStorage, vaultProfile, network: { ...network, connectedPeerCount, bootstrapUp, status: computeNetworkStatus({ connectedPeerCount, bootstrapUp, peerDiscoveryUp: true }), resilientBytes: network.snapshots.at(-1)?.resilient_bytes || 0 }, trustedDevices: listTrustedDevices(log, state.identity.ownerPublicKey), myStorageNodeIds });
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
async function withEphemeralSession(email, password, mode) {
  const config = window.__POLYMAI_SUPABASE_CONFIG__;
  const client = window.supabase.createClient(config.url, config.anonKey, { auth: { storageKey: `${config.appStoragePrefix}link-auth`, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { schema: "app717_meshvault" } });
  const result = mode === "signup" ? await client.auth.signUp({ email, password }) : await client.auth.signInWithPassword({ email, password });
  if (result.error) throw new Error(result.error.message);
  if (!result.data.session) throw new Error("Check your email to confirm your account, then try connecting again.");
  return result.data.session;
}
async function linkAccount(email, password, mode) {
  const identity = currentVaultIdentity(); if (!identity) throw new Error("Create your vault first.");
  const session = await withEphemeralSession(email, password, mode);
  const timestamp = Date.now();
  const signature = bytesToBase64Url(await identity.sign(canonicalBytes({ vaultId: identity.vaultId, authUserId: session.user.id, action: "link-account", timestamp })));
  const response = await fetch(`${appConfig.functionsBaseUrl}/app717-meshvault-api`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, apikey: appConfig.anonKey }, body: JSON.stringify({ action: "link-account", clientProtocolVersion: 3, vaultId: identity.vaultId, ownerPublicKey: identity.ownerPublicKey, algorithm: identity.algorithm, signature, timestamp }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Could not connect this account.");
  linkedAccountAccessToken = session.access_token;
  setState({ accountLink: { authUserId: session.user.id, email } });
}
async function unlinkAccount() {
  const identity = currentVaultIdentity();
  const accountLink = getState().accountLink;
  if (!identity || !accountLink || !linkedAccountAccessToken) throw new Error("Sign in again before disconnecting this account.");
  const timestamp = Date.now();
  const signable = { vaultId: identity.vaultId, authUserId: accountLink.authUserId, action: "unlink-account", timestamp };
  const signature = bytesToBase64Url(await identity.sign(canonicalBytes(signable)));
  const response = await fetch(`${appConfig.functionsBaseUrl}/app717-meshvault-api`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${linkedAccountAccessToken}`, apikey: appConfig.anonKey },
    body: JSON.stringify({ ...signable, clientProtocolVersion: 3, ownerPublicKey: identity.ownerPublicKey, algorithm: identity.algorithm, signature }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Could not disconnect this account.");
  linkedAccountAccessToken = null;
  setState({ accountLink: null });
  announce("Account disconnected. Your vault is unaffected.", "info");
}
async function startDevice(deviceIdentity, vaultId) {
  // A node/mesh-side failure (e.g. the bootstrap provider being unreachable
  // or not yet provisioned) must never block reaching the vault itself -
  // the vault is locally owned and usable regardless of mesh connectivity.
  try {
    // The browser location prompt and the edge/ICE round trip run concurrently
    // so asking the user for permission never adds sequential latency to
    // joining the mesh - a denial, timeout, or unsupported browser is a no-op
    // fallback to whatever coarser edge hint is available, never a block.
    const [iceResult, browserHint, capacityBytes] = await Promise.all([
      getPeerIceConfig(5000).then((connection) => ({ iceServers: connection.iceServers || [], locationHint: connection.locationHint || null })).catch(() => ({ iceServers: [], locationHint: null })),
      requestBrowserLocationHint().catch(() => null),
      getContributionLimit(),
    ]);
    const edgeLocationHint = iceResult.locationHint;
    const locationHint = browserHint ? { countryCode: browserHint.countryCode, regionCode: null, networkDomainHash: edgeLocationHint?.networkDomainHash || null, source: browserHint.source, observedAt: browserHint.observedAt } : edgeLocationHint;
    const node = await activateNode(deviceIdentity, vaultId, capacityBytes, iceResult.iceServers, locationHint);
    const estimate = await storageEstimate();
    updateNested("node", {
      id: node.id, status: node.status, capacityBytes: Number(node.capacity_bytes), usedBytes: Number(node.used_bytes),
      label: node.device_label || deviceIdentity.label,
      persistence: estimate.persistent ? "granted" : "available",
      countryCode: node.country_code || null, regionCode: node.region_code || null,
      locationSource: node.location_source || null, locationUpdatedAt: node.location_updated_at || null,
    });
    updateNested("anchor", { ...(await anchorStatus()), nodeName: deviceIdentity.label });
    await configureSurvivalService({
      nodeId: node.id,
      getPeers: connectedProtocols,
      peerInfo: getPeer,
      accessToken: currentAccessToken,
      renewLease: updateNodeSurvivalTelemetry,
    });
    updateNested("survival", survivalStatus());
    await pushOperationLog().catch(() => {});
    setState((state) => ({ nodes: [node, ...(state.nodes || []).filter((entry) => entry.id !== node.id)] }));
    startRecoveryCoordinator();
  } catch (error) {
    updateNested("node", { status: "offline" });
    announce(`This device could not join the mesh right now: ${error.message}. Your vault is still available locally.`, "warning", 10000);
  }
}
async function enterVault(identity) {
  configureControlRepository(identity);
  const coordinationReady = (async () => {
    await ensureAnonymousSession();
    await ensureVaultRegistration(identity);
    return true;
  })().catch((error) => {
    announce(`Mesh coordination is temporarily unavailable: ${error.message}`, "warning", 10000);
    return false;
  });
  const [vaultProfile, erasureClass] = await Promise.all([getVaultProfile(identity.vaultId).catch(() => ({ name: "", synced: false, syncStatus: "local" })), getErasureClass()]);
  setState({ identity: { vaultId: identity.vaultId, ownerPublicKey: identity.ownerPublicKey, algorithm: identity.algorithm, meshKeySaved: identity.meshKeySaved }, vaultProfile, erasureClass, storageNodeOnly: false, boot: "ready", error: null });
  const deviceIdentity = await loadOrCreateDeviceIdentity();
  // Anchor is a locally persisted browser role. Surface it before hosted node
  // activation so a temporary Supabase/bootstrap outage cannot hide or appear
  // to revoke the role in the shell.
  const persistedAnchor = await getAnchorSettings();
  updateNested("anchor", { ...(await anchorStatus()), ...persistedAnchor, nodeName: deviceIdentity.label });
  if (["#/home", "#/onboarding", ""].includes(location.hash)) location.hash = "#/dashboard";
  coordinationReady.then(async (available) => {
    if (!available || getState().identity?.vaultId !== identity.vaultId) return;
    await replayCatalogOperations().catch(() => {});
    await backfillVaultCatalog(identity.vaultId).catch(() => {});
    await flushControlPlane({ forceBackbone: true }).catch(() => {});
    const syncedProfile = await getVaultProfile(identity.vaultId, identity).catch(() => null);
    if (syncedProfile && getState().identity?.vaultId === identity.vaultId) setState({ vaultProfile: syncedProfile });
    await refreshPrivateData().catch(() => {});
  }).catch(() => {});
  await startDevice(deviceIdentity, identity.vaultId);
  await importSharedLaunchIfReady();
}
async function enterStorageNodeOnly() {
  await ensureAnonymousSession();
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
    const [hasIdentity, storageNodeOnly] = await Promise.all([hasStoredVaultIdentity(), getStorageNodeOnly()]);
    if (!hasIdentity && !storageNodeOnly) {
      setState({ identity: null, vaultProfile: { name: "" }, boot: "ready" });
      if (!isPublicRouteHash()) location.hash = "#/onboarding";
      return;
    }
    try { await ensureAnonymousSession(); }
    catch (error) {
      announce("Coordination is offline. Opening this device from its local Mesh Key and cached mesh state.", "warning", 10000);
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
    upload: (file, folderId = null) => uploadFile(file, { vaultIdentity: currentVaultIdentity(), folderId, resilienceClass: getState().erasureClass }), download: (fileId) => downloadFile(fileId, { vaultIdentity: currentVaultIdentity() }),
    remove: (fileId) => deleteFile(fileId, { vaultIdentity: currentVaultIdentity() }),
    previewFolderRemoval: (folderId) => previewFolderDeletion(folderId, { vaultIdentity: currentVaultIdentity() }),
    removeFolder: (folderId) => deleteFolder(folderId, { vaultIdentity: currentVaultIdentity() }),
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
    async installApp() {
      const result = await requestPwaInstall();
      if (result.outcome === "accepted") announce("TheMeshVault installation approved.", "success");
      else if (result.outcome === "dismissed") announce("Installation cancelled.", "info");
      else if (result.outcome === "already-installed") announce("TheMeshVault is already installed.", "info");
      else announce("Use your browser's Install command to add TheMeshVault.", "info", 7000);
      return result;
    },
    async capacity(bytes) { const value = await setContributionLimit(bytes); await updateNodeCapacity(value); updateNested("node", { capacityBytes: value, status: bytes ? getState().node.status : "paused" }); },
    async toggleNode() { const paused = getState().node.status === "online"; await setNodePaused(paused); updateNested("node", { status: paused ? "paused" : "online" }); },
    async persist() { const granted = await requestPersistence(); updateNested("node", { persistence: granted ? "granted" : "unavailable" }); announce(granted ? "Persistent storage enabled." : "This browser did not grant persistent storage.", granted ? "success" : "warning"); },
    async clear() { const count = await clearLocalNodeStorage(); updateNested("node", { usedBytes: 0, status: "paused" }); announce(`${count} local encrypted shards removed.`, "warning"); },
    async resilienceClass(value) {
      const erasureClass = await setErasureClass(value); setState({ erasureClass });
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
      announce(enabled ? "Anchor mode is active while this tab remains awake." : "Anchor mode stopped.", enabled ? "success" : "info", 7000);
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
  window.addEventListener("meshvault:peer-state", () => { refreshConnectivityState(); pushOperationLog().catch(() => {}); });
  window.addEventListener("online", () => {
    replayCatalogOperations().catch(() => {});
    flushControlPlane({ forceBackbone: true }).catch(() => {});
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
  startRouter(actions); renderApp();
  supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") ensureAnonymousSession().catch(() => {}); });
  await initialize();
}
export function destroyApp() { if (liveMeshRefreshTimer) window.clearInterval(liveMeshRefreshTimer); liveMeshRefreshTimer = null; clearControlRepository(); stopRecoveryCoordinator(); stopSurvivalService().catch(() => {}); pauseNode().catch(() => {}); }
