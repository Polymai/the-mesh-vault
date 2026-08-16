import { getFileBundle } from "../services/metadata-service.js";
import { findManifest } from "../network/manifest-discovery.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { propagateManifestRequest } from "../network/node-service.js";
import { decryptJson, deriveSegmentKey, segmentPrivateMetadataAad } from "../security/keyring.js";
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
    verifyOpts: {
      expectedManifestId: bundle.version.manifest_id,
      expectedVaultId: vaultId,
      expectedOwnerPublicKey: vaultIdentity.ownerPublicKey,
      expectedFileVersionId: bundle.version.id,
    },
  });
  if (!manifest) throw new Error("This file's manifest could not be found to create a share link.");
  const grantsBySegmentId = new Map();
  for (const segment of manifest.segments) {
    if (grantsBySegmentId.has(segment.segmentId)) continue;
    const keyContext = { ...segment, vaultId };
    const privateMetadata = await decryptJson(segment.encryptedPrivateMetadata, segmentPrivateMetadataAad(keyContext));
    const rawKey = await deriveSegmentKey(keyContext);
    try {
      grantsBySegmentId.set(segment.segmentId, {
        segmentId: segment.segmentId,
        keyDerivationVersion: segment.keyDerivationVersion,
        encryptionGeneration: segment.encryptionGeneration,
        rawKey: bytesToBase64Url(rawKey),
        plainHash: privateMetadata.plainHash,
      });
    } finally { rawKey.fill(0); }
  }
  const segmentBundles = [...grantsBySegmentId.values()];
  const signer = { publicKey: vaultIdentity.ownerPublicKey, algorithm: vaultIdentity.algorithm, sign: vaultIdentity.sign };
  let capability;
  try {
    capability = await buildCapability(
      { vaultId, fileVersionId: bundle.version.id, manifestId: bundle.version.manifest_id, segmentBundles, expiresInMs, password, downloadLimit, singleUse }, signer,
    );
  } finally {
    segmentBundles.forEach((grant) => { grant.rawKey = ""; grant.plainHash = ""; });
    segmentBundles.length = 0;
    grantsBySegmentId.clear();
  }
  const { capabilityId, encryptedCapabilityMetadata, signature, fragment, expiresAt } = capability;
  await announceManifest(manifest).catch(() => {});
  await publishCapability(capabilityId, bundle.version.manifest_id, encryptedCapabilityMetadata, signature, expiresAt, singleUse, downloadLimit);
  return { url: buildShareUrl(capabilityId, fragment), capabilityId, expiresAt };
}
