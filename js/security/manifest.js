import { canonicalBytes, canonicalHashHex, bytesToBase64Url, base64UrlToBytes, importPublicKeyRaw, verify as verifySignature } from "./signing.js";

export const MANIFEST_FORMAT_VERSION = 2;
export const STORAGE_PROTOCOL_VERSION = 2;
export const SUPPORTED_STORAGE_PROTOCOL_VERSIONS = Object.freeze([1, 2]);

export async function buildManifestV2(fields, signer) {
  const core = {
    manifestFormatVersion: MANIFEST_FORMAT_VERSION, storageProtocolVersion: fields.storageProtocolVersion || STORAGE_PROTOCOL_VERSION,
    vaultId: fields.vaultId, fileVersionId: fields.fileVersionId,
    ownerPublicKey: signer.publicKey, algorithm: signer.algorithm, createdAt: Date.now(),
    originalHash: fields.originalHash, originalSize: fields.originalSize,
    segmentCount: fields.segmentCount, boundaryMethod: fields.boundaryMethod, segments: fields.segments,
  };
  const manifestHash = await canonicalHashHex(core);
  const signable = { ...core, manifestHash };
  const signature = bytesToBase64Url(await signer.sign(canonicalBytes(signable)));
  const manifestId = await canonicalHashHex({ ...signable, signature });
  return { manifestId, ...signable, signature };
}

export async function verifyManifestV2(envelope, opts = {}) {
  const { supportedManifestVersions = [MANIFEST_FORMAT_VERSION], supportedStorageVersions = SUPPORTED_STORAGE_PROTOCOL_VERSIONS, isRevokedKey, isSuperseded } = opts;
  if (!envelope || typeof envelope !== "object") return { valid: false, reason: "malformed" };
  if (!supportedManifestVersions.includes(envelope.manifestFormatVersion)) return { valid: false, reason: "unsupported_manifest_version" };
  if (!supportedStorageVersions.includes(envelope.storageProtocolVersion)) return { valid: false, reason: "unsupported_storage_version" };
  if (isRevokedKey?.(envelope.ownerPublicKey)) return { valid: false, reason: "revoked_issuer" };
  const { manifestId, manifestHash, signature, ...core } = envelope;
  if (!Array.isArray(core.segments)) return { valid: false, reason: "malformed" };
  for (const segment of core.segments) {
    if (!Array.isArray(segment.shardHashes) || segment.shardHashes.length !== segment.totalShards) return { valid: false, reason: "invalid_shard_hashes" };
    const required = Number(segment.requiredShards); const total = Number(segment.totalShards); const repairThreshold = Number(segment.repairThreshold ?? required);
    if (!Number.isInteger(required) || !Number.isInteger(total) || !Number.isInteger(repairThreshold) || required < 2 || required > repairThreshold || repairThreshold > total) return { valid: false, reason: "invalid_erasure_profile" };
  }
  if ((await canonicalHashHex(core)) !== manifestHash) return { valid: false, reason: "invalid_manifest_hash" };
  const signable = { ...core, manifestHash };
  if ((await canonicalHashHex({ ...signable, signature })) !== manifestId) return { valid: false, reason: "manifest_id_mismatch" };
  try {
    const publicKey = await importPublicKeyRaw(base64UrlToBytes(envelope.ownerPublicKey), envelope.algorithm);
    const ok = await verifySignature(publicKey, envelope.algorithm, base64UrlToBytes(signature), canonicalBytes(signable));
    if (!ok) return { valid: false, reason: "invalid_signature" };
  } catch { return { valid: false, reason: "invalid_signature" }; }
  if (isSuperseded?.(envelope)) return { valid: false, reason: "superseded" };
  return { valid: true };
}
