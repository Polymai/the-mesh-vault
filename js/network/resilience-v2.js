import { calculateFileResilience } from "./resilience.js";
import { getLocalManifest } from "./manifest-discovery.js";

export const NETWORK_STATUS = Object.freeze({
  FULLY_CONNECTED: "fully_connected",
  PEER_NETWORK_ACTIVE: "peer_network_active",
  BOOTSTRAP_UNAVAILABLE: "bootstrap_provider_unavailable",
  LIMITED_DISCOVERY: "limited_discovery",
  LOCAL_ONLY: "local_only_access",
});
export const FILE_STATUS = Object.freeze({
  UNAVAILABLE: "file_unavailable",
  ENCRYPTED_DATA_STORED: "encrypted_data_stored",
  MANIFEST_AVAILABLE: "manifest_available",
  ENOUGH_SHARDS_AVAILABLE: "enough_shards_available",
  AT_RISK: "file_at_risk",
  RECOVERABLE_NOW: "recoverable_now",
  RECOVERABLE_WITHOUT_BOOTSTRAP: "recoverable_without_bootstrap",
});

export function computeNetworkStatus({ connectedPeerCount = 0, bootstrapUp = true, peerDiscoveryUp = true } = {}) {
  if (connectedPeerCount > 0) return bootstrapUp ? NETWORK_STATUS.FULLY_CONNECTED : NETWORK_STATUS.PEER_NETWORK_ACTIVE;
  if (!bootstrapUp) return NETWORK_STATUS.BOOTSTRAP_UNAVAILABLE;
  if (!peerDiscoveryUp) return NETWORK_STATUS.LOCAL_ONLY;
  return NETWORK_STATUS.LIMITED_DISCOVERY;
}

export async function computeFileResilienceV2({ manifestId, segments = [], hasDecryptionMaterial = true, supportedProtocolVersions = [2], bootstrapUp = true, peerNetworkActive = true }) {
  const manifestEnvelope = await getLocalManifest(manifestId);
  const manifestAvailable = !!manifestEnvelope && supportedProtocolVersions.includes(manifestEnvelope.manifestFormatVersion);
  const dbResilience = calculateFileResilience(segments);
  const enoughShardsAvailable = dbResilience.recoverable;
  const encryptedDataStored = segments.some((segment) => Number(segment.content_segments?.total_shards ?? segment.total_shards ?? 0) > 0);
  const recoverableNow = manifestAvailable && enoughShardsAvailable && hasDecryptionMaterial;
  const recoverableWithoutBootstrap = recoverableNow && peerNetworkActive;
  const atRisk = recoverableNow && (dbResilience.repairNeeded || dbResilience.state === "degraded");

  let summaryStatus = FILE_STATUS.UNAVAILABLE;
  if (atRisk) summaryStatus = FILE_STATUS.AT_RISK;
  else if (recoverableWithoutBootstrap) summaryStatus = FILE_STATUS.RECOVERABLE_WITHOUT_BOOTSTRAP;
  else if (recoverableNow) summaryStatus = FILE_STATUS.RECOVERABLE_NOW;
  else if (enoughShardsAvailable) summaryStatus = FILE_STATUS.ENOUGH_SHARDS_AVAILABLE;
  else if (manifestAvailable) summaryStatus = FILE_STATUS.MANIFEST_AVAILABLE;
  else if (encryptedDataStored) summaryStatus = FILE_STATUS.ENCRYPTED_DATA_STORED;

  return {
    summaryStatus, encryptedDataStored, manifestAvailable, enoughShardsAvailable, hasDecryptionMaterial,
    bootstrapAvailable: bootstrapUp, peerDiscoveryAvailable: peerNetworkActive,
    recoverableNow, recoverableWithoutBootstrap, atRisk, repairDemand: dbResilience.repairDemand,
  };
}

export async function computeFileResilienceFromVersion({ version, hasDecryptionMaterial = true, bootstrapUp = true, peerNetworkActive = true }) {
  const active = Number(version?.active_shards || 0); const required = Number(version?.minimum_required_shards || 0); const repairThreshold = Number(version?.repair_threshold_shards || required); const total = Number(version?.total_shards || 0);
  const state = version?.recovery_status || "local_pending"; const manifestEnvelope = version?.manifest_id ? await getLocalManifest(version.manifest_id) : null;
  const manifestAvailable = !!manifestEnvelope; const enoughShardsAvailable = ["recoverable", "resilient"].includes(state); const encryptedDataStored = total > 0;
  const recoverableNow = manifestAvailable && enoughShardsAvailable && hasDecryptionMaterial;
  const recoverableWithoutBootstrap = recoverableNow && peerNetworkActive;
  const atRisk = recoverableNow && state === "recoverable" && active < repairThreshold;
  let summaryStatus = FILE_STATUS.UNAVAILABLE;
  if (atRisk) summaryStatus = FILE_STATUS.AT_RISK;
  else if (recoverableWithoutBootstrap) summaryStatus = FILE_STATUS.RECOVERABLE_WITHOUT_BOOTSTRAP;
  else if (recoverableNow) summaryStatus = FILE_STATUS.RECOVERABLE_NOW;
  else if (enoughShardsAvailable) summaryStatus = FILE_STATUS.ENOUGH_SHARDS_AVAILABLE;
  else if (manifestAvailable) summaryStatus = FILE_STATUS.MANIFEST_AVAILABLE;
  else if (encryptedDataStored) summaryStatus = FILE_STATUS.ENCRYPTED_DATA_STORED;
  const repairDemand = active < repairThreshold ? Math.max(0, total - active) : 0;
  return { summaryStatus, encryptedDataStored, manifestAvailable, enoughShardsAvailable, hasDecryptionMaterial, bootstrapAvailable: bootstrapUp, peerDiscoveryAvailable: peerNetworkActive, recoverableNow, recoverableWithoutBootstrap, atRisk, repairDemand, failureDomainAssurance: "browser_profile", verifiedPhysicalDevices: 0 };
}
