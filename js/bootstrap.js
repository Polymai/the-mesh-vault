import { getState, setState, updateNested, subscribe, announce } from "./state/store.js";
import {
  loadOrCreateVaultIdentity, hasStoredVaultIdentity, currentVaultIdentity, markMeshKeySaved, setRecoveryReplicator,
  replicateCurrentRecoveryEnvelope, meshKeyRecoveryPhrase, qrPayload, exportMeshKeyFile, restoreVaultFromFile, restoreVaultFromPhrase, verifyMeshKeyPhrase,
} from "./identity/vault-identity.js";
import { loadOrCreateDeviceIdentity, renameDevice } from "./identity/device-identity.js";
import { listFiles, listPendingFileDeletions, listFolders, createFolder } from "./services/metadata-service.js";
import { getPeerIceConfig, loadNetworkOverview } from "./services/network-service.js";
import { listMyStorageNodes, loadVaultStorageSummary } from "./services/segment-service.js";
import { getContributionLimit, setContributionLimit, getStorageNodeOnly, setStorageNodeOnly, getVaultProfile, setVaultProfile, getErasureClass, setErasureClass, ensureVaultRegistration } from "./services/vault-service.js";
import { appTable, appConfig, currentAccessToken, ensureAnonymousSession, supabase } from "./services/supabase.js";
import { uploadFile } from "./flows/upload-flow.js";
import { downloadFile } from "./flows/download-flow.js";
import { deleteFile } from "./flows/delete-flow.js";
import { previewFolderDeletion, deleteFolder } from "./flows/delete-folder-flow.js";
import { createShareLink } from "./flows/share-flow.js";
import { activateNode, setNodePaused, updateNodeCapacity, updateNodeLabel, heartbeatNode, updateNodeSurvivalTelemetry, clearLocalNodeStorage, pauseNode } from "./network/node-service.js";
import { updateAnchorSettings, anchorStatus, replicateOplogOperation, publishControlObject, queryAnchors } from "./network/anchor-service.js";
import { requestBrowserLocationHint } from "./geo/browser-location.js";
import { startRecoveryCoordinator, stopRecoveryCoordinator } from "./network/recovery-coordinator.js";
import { computeNetworkStatus, computeFileResilienceFromVersion } from "./network/resilience-v2.js";
import { providerStatuses } from "./network/providers/provider-registry.js";
import { connectedProtocols } from "./network/peer-manager.js";
import { getPeer } from "./network/peer-registry.js";
import { requestPersistence, storageEstimate } from "./storage/fragment-store.js";
import { getOperationLog, appendOperation, getUnsyncedOperations, markSynced, ingestOperations, onSyncNeeded } from "./oplog/oplog-engine.js";
import { OP_TYPES } from "./oplog/operation-types.js";
import { listTrustedDevices } from "./identity/device-registry.js";
import { bytesToBase64Url, canonicalBytes } from "./security/signing.js";
import { startRouter, renderApp } from "./router.js";
import { configureSurvivalService, setSurvivalMode, survivalStatus, requestBuddyWake, stopSurvivalService } from "./network/survival-service.js";

let initialized = false;
let syncingOplog = false;
let linkedAccountAccessToken = null;
const PUBLIC_ROUTE_HASHES = new Set(["", "#/home", "#/onboarding", "#/security", "#/terms", "#/privacy"]);
function isPublicRouteHash(hash = location.hash) {
  return PUBLIC_ROUTE_HASHES.has(String(hash).split("?")[0]) || String(hash).startsWith("#/share/");
}
setRecoveryReplicator(async (envelope) => {
  let replicated = false; let lastError = null;
  try {
    const { error } = await appTable("recovery_envelope_cache").upsert({ recovery_lookup_id: envelope.recoveryLookupId, vault_id: envelope.vaultId, envelope }, { onConflict: "recovery_lookup_id" });
    if (error) throw error; replicated = true;
  } catch (error) { lastError = error; }
  try { await publishControlObject("recovery-envelope", envelope.recoveryLookupId, envelope, 30 * 86400000); replicated = true; }
  catch (error) { lastError ||= error; }
  if (!replicated) throw lastError || new Error("The encrypted recovery envelope could not be replicated.");
});
async function fetchRecoveryEnvelope(recoveryLookupId) {
  let coordinationError = null;
  try {
    const { data, error } = await appTable("recovery_envelope_cache").select("envelope").eq("recovery_lookup_id", recoveryLookupId).maybeSingle();
    if (error) throw error;
    if (!error && data?.envelope) return data.envelope;
  } catch (error) { coordinationError = error; }
  const replicated = await queryAnchors("recovery-envelope", recoveryLookupId, 10).catch(() => []);
  const peerEnvelope = replicated.find((row) => row.payload?.recoveryLookupId === recoveryLookupId && row.payload?.cipher && row.payload?.salt)?.payload || null;
  if (peerEnvelope) return peerEnvelope;
  if (coordinationError) throw new Error("Recovery lookup could not reach the coordination service. Check this browser's connection and try again.");
  return null;
}
function currentSigner() { const identity = currentVaultIdentity(); return identity ? { publicKey: identity.ownerPublicKey, algorithm: identity.algorithm, sign: identity.sign } : null; }
function refreshConnectivityState() {
  const connectedPeerCount = connectedProtocols().length; const bootstrapUp = providerStatuses().supabase?.up !== false;
  updateNested("network", { connectedPeerCount, bootstrapUp, status: computeNetworkStatus({ connectedPeerCount, bootstrapUp, peerDiscoveryUp: true }) });
}

async function pushOperationLog() {
  if (syncingOplog) return; const identity = getState().identity; if (!identity?.vaultId) return;
  syncingOplog = true;
  try { for (const operation of await getUnsyncedOperations(identity.vaultId)) if (await replicateOplogOperation(operation)) await markSynced(operation.opId); }
  finally { syncingOplog = false; }
}

async function loadReplicatedOperationLog(vaultId, ownerPublicKey) {
  const wrappers = await queryAnchors("oplog", vaultId, 50).catch(() => []);
  if (wrappers.length) await ingestOperations(vaultId, wrappers.map((row) => row.payload), { ownerPublicKey }).catch(() => {});
  return getOperationLog(vaultId).catch(() => []);
}

async function refreshPrivateData() {
  const state = getState(); if (!state.identity?.vaultId) return;
  const vaultId = state.identity.vaultId;
  const emptyNetwork = { nodes: state.nodes || [], events: state.network.events || [], snapshots: state.network.snapshots || [], activeNodes: state.network.activeNodes || 0, verifiedCapacity: state.network.verifiedCapacity || 0, usedBytes: state.network.usedBytes || 0 };
  const [files, pendingDeletions, folders, network, transfers, log, myStorageNodeIds, vaultStorage] = await Promise.all([
    listFiles(vaultId), listPendingFileDeletions(vaultId).catch(() => state.pendingDeletions || []), listFolders(vaultId).catch(() => state.folders || []), loadNetworkOverview().catch(() => emptyNetwork),
    appTable("transfers").select("*").eq("vault_id", vaultId).in("status", ["queued", "running"]).order("created_at", { ascending: false }).then((result) => result.error ? [] : result.data || []).catch(() => []),
    loadReplicatedOperationLog(vaultId, state.identity.ownerPublicKey), listMyStorageNodes(vaultId).catch(() => state.myStorageNodeIds || []),
    loadVaultStorageSummary(vaultId).catch(() => state.vaultStorage),
  ]);
  const statuses = providerStatuses(); const bootstrapUp = statuses.supabase?.up !== false; const connectedPeerCount = connectedProtocols().length;
  const peerNetworkActive = connectedPeerCount > 0;
  const measuredFiles = await Promise.all(files.map(async (file) => ({ ...file, resilience: await computeFileResilienceFromVersion({ version: file.version, bootstrapUp, peerNetworkActive }) })));
  setState({ files: measuredFiles, pendingDeletions, folders, nodes: network.nodes, transfers, vaultStorage, network: { ...network, connectedPeerCount, bootstrapUp, status: computeNetworkStatus({ connectedPeerCount, bootstrapUp, peerDiscoveryUp: true }), resilientBytes: network.snapshots.at(-1)?.resilient_bytes || 0 }, trustedDevices: listTrustedDevices(log, state.identity.ownerPublicKey), myStorageNodeIds });
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
  const response = await fetch(`${appConfig.functionsBaseUrl}/app717-meshvault-api`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, apikey: appConfig.anonKey }, body: JSON.stringify({ action: "link-account", vaultId: identity.vaultId, ownerPublicKey: identity.ownerPublicKey, algorithm: identity.algorithm, signature, timestamp }) });
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
    body: JSON.stringify({ ...signable, ownerPublicKey: identity.ownerPublicKey, algorithm: identity.algorithm, signature }),
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
    await replicateCurrentRecoveryEnvelope().catch(() => {});
    await pushOperationLog().catch(() => {});
    setState((state) => ({ nodes: [node, ...(state.nodes || []).filter((entry) => entry.id !== node.id)] }));
    startRecoveryCoordinator();
  } catch (error) {
    updateNested("node", { status: "offline" });
    announce(`This device could not join the mesh right now: ${error.message}. Your vault is still available locally.`, "warning", 10000);
  }
}
async function enterVault(identity) {
  try {
    await ensureAnonymousSession();
    await ensureVaultRegistration(identity);
    await replicateCurrentRecoveryEnvelope();
  } catch (error) {
    if (error.code === "VAULT_IDENTITY_MISMATCH") throw error;
    announce(`Mesh coordination is temporarily unavailable: ${error.message}`, "warning", 10000);
  }
  const [vaultProfile, erasureClass] = await Promise.all([getVaultProfile(identity.vaultId).catch(() => ({ name: "" })), getErasureClass()]);
  setState({ identity: { vaultId: identity.vaultId, ownerPublicKey: identity.ownerPublicKey, algorithm: identity.algorithm, meshKeySaved: identity.meshKeySaved }, vaultProfile, erasureClass, storageNodeOnly: false, boot: "ready", error: null });
  const deviceIdentity = await loadOrCreateDeviceIdentity();
  if (["#/home", "#/onboarding", ""].includes(location.hash)) location.hash = "#/dashboard";
  await Promise.all([refreshPrivateData().catch(() => {}), startDevice(deviceIdentity, identity.vaultId)]);
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
    async restoreWithFile({ fileJson, phrase }) { await enterVault(await restoreVaultFromFile(fileJson, phrase)); },
    async restoreWithPhrase({ phrase }) {
      await ensureAnonymousSession();
      await enterVault(await restoreVaultFromPhrase(phrase, fetchRecoveryEnvelope));
    },
    async joinAsStorageNode() { await enterStorageNodeOnly(); },
  },
  drive: {
    upload: (file) => uploadFile(file, { vaultIdentity: currentVaultIdentity(), resilienceClass: getState().erasureClass }), download: (fileId) => downloadFile(fileId, { vaultIdentity: currentVaultIdentity() }),
    remove: (fileId) => deleteFile(fileId, { vaultIdentity: currentVaultIdentity() }),
    previewFolderRemoval: (folderId) => previewFolderDeletion(folderId, { vaultIdentity: currentVaultIdentity() }),
    removeFolder: (folderId) => deleteFolder(folderId, { vaultIdentity: currentVaultIdentity() }),
    share: (fileId) => createShareLink(fileId, { vaultIdentity: currentVaultIdentity() }),
    createFolder: (name) => createFolder(getState().identity.vaultId, name), refresh: refreshPrivateData, rerender: () => renderApp(true),
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
    async capacity(bytes) { const value = await setContributionLimit(bytes); await updateNodeCapacity(value); updateNested("node", { capacityBytes: value, status: bytes ? getState().node.status : "paused" }); },
    async toggleNode() { const paused = getState().node.status === "online"; await setNodePaused(paused); updateNested("node", { status: paused ? "paused" : "online" }); },
    async persist() { const granted = await requestPersistence(); updateNested("node", { persistence: granted ? "granted" : "unavailable" }); announce(granted ? "Persistent storage enabled." : "This browser did not grant persistent storage.", granted ? "success" : "warning"); },
    async clear() { const count = await clearLocalNodeStorage(); updateNested("node", { usedBytes: 0, status: "paused" }); announce(`${count} local encrypted shards removed.`, "warning"); },
    async resilienceClass(value) { const erasureClass = await setErasureClass(value); setState({ erasureClass }); announce(erasureClass === "high" ? "High resilience enabled for new and upgraded segments." : "Standard resilience enabled.", "success"); return erasureClass; },
    async profile({ name }) {
      const vaultId = getState().identity?.vaultId;
      if (!vaultId) throw new Error("Open a vault before saving profile details.");
      const vaultProfile = await setVaultProfile(vaultId, { name });
      setState({ vaultProfile });
      announce("Vault profile saved locally.", "success");
      return vaultProfile;
    },
    async anchor({ enabled, nodeName, cacheLimitBytes }) {
      const cleanedName = String(nodeName || "Browser node").trim().slice(0, 80) || "Browser node";
      await renameDevice(cleanedName); await updateNodeLabel(cleanedName);
      await updateAnchorSettings({ enabled, cacheLimitBytes }); await heartbeatNode().catch(() => {});
      updateNested("anchor", { ...(await anchorStatus()), nodeName: cleanedName });
      announce(enabled ? "Anchor mode is active while this tab remains awake." : "Anchor mode stopped.", enabled ? "success" : "info", 7000);
    },
  },
  nightNode: {
    status: survivalStatus,
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
  if (initialized) return; initialized = true; subscribe(() => renderApp());
  onSyncNeeded(() => pushOperationLog().catch(() => {}));
  window.addEventListener("meshvault:resilience-updated", () => refreshPrivateData().catch(() => {}));
  window.addEventListener("meshvault:peer-state", () => { refreshConnectivityState(); pushOperationLog().catch(() => {}); });
  window.addEventListener("meshvault:topology-updated", () => { if (getState().route === "mesh") renderApp(true); });
  window.addEventListener("meshvault:anchor-status", (event) => updateNested("anchor", event.detail));
  window.addEventListener("meshvault:survival-status", (event) => updateNested("survival", event.detail));
  navigator.serviceWorker?.addEventListener?.("message", (event) => { if (event.data?.type === "meshvault:background-check") heartbeatNode().catch(() => {}); });
  startRouter(actions); renderApp();
  supabase.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") ensureAnonymousSession().catch(() => {}); });
  await initialize();
}
export function destroyApp() { stopRecoveryCoordinator(); stopSurvivalService().catch(() => {}); pauseNode().catch(() => {}); }
