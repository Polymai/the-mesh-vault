import { getFileBundle } from "../services/metadata-service.js";
import { findManifest } from "../network/manifest-discovery.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { propagateManifestRequest } from "../network/node-service.js";
import { unwrapSegmentKey, decryptJson } from "../security/keyring.js";
import { bytesToBase64Url } from "../security/signing.js";
import { buildCapability, buildShareUrl } from "../security/capability.js";
import { publishCapability } from "../services/capability-service.js";
import { announceManifest } from "../network/providers/provider-registry.js";

export async function createShareLink(fileId, { vaultIdentity, expiresInMs = 24 * 60 * 60 * 1000, password = "", downloadLimit = null, singleUse = false } = {}) {
  const vaultId = vaultIdentity?.vaultId;
  if (!vaultId) throw new Error("Open this file from its owning vault.");
  const bundle = await getFileBundle(vaultId, fileId);
  if (!bundle.version.manifest_id) throw new Error("This file has no published manifest yet.");
  const { envelope: manifest } = await findManifest(bundle.version.manifest_id, {
    connectedPeers: connectedProtocols(), propagate: propagateManifestRequest,
    verifyOpts: { supportedManifestVersions: [2], supportedStorageVersions: [1, 2] },
  });
  if (!manifest) throw new Error("This file's manifest could not be found to create a share link.");
  const segmentBundles = [];
  for (const segment of manifest.segments) {
    const rawKey = await unwrapSegmentKey(segment.wrappedSegmentKey);
    const privateMetadata = await decryptJson(segment.encryptedPrivateMetadata);
    segmentBundles.push({ rawKey: bytesToBase64Url(rawKey), plainHash: privateMetadata.plainHash, aad: privateMetadata.aad });
    rawKey.fill(0);
  }
  const signer = { publicKey: vaultIdentity.ownerPublicKey, algorithm: vaultIdentity.algorithm, sign: vaultIdentity.sign };
  const { capabilityId, encryptedCapabilityMetadata, signature, fragment, expiresAt } = await buildCapability(
    { manifestId: bundle.version.manifest_id, segmentBundles, expiresInMs, password, downloadLimit, singleUse }, signer,
  );
  await announceManifest(manifest).catch(() => {});
  await publishCapability(capabilityId, bundle.version.manifest_id, encryptedCapabilityMetadata, signature, expiresAt, singleUse, downloadLimit);
  return { url: buildShareUrl(capabilityId, fragment), capabilityId, expiresAt };
}
