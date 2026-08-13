import {
  ALG_ED25519, base64UrlToBytes, bytesToBase64Url, canonicalBytes,
  canonicalHashHex, hashHex, importPublicKeyRaw, verify as verifySignature,
} from "./signing.js";
import { verifySegmentDescriptor } from "./segment-descriptor.js";

export const MANIFEST_FORMAT_VERSION = 3;
export const STORAGE_PROTOCOL_VERSION = 3;
export const SUPPORTED_STORAGE_PROTOCOL_VERSIONS = Object.freeze([3]);

const HASH_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function readSegmentErasureProfile(segment = {}) {
  const explicit = segment.erasureCoding && typeof segment.erasureCoding === "object" ? segment.erasureCoding : {};
  const dataShards = Number(explicit.dataShards ?? segment.dataShards);
  const parityShards = Number(explicit.parityShards ?? segment.parityShards);
  const requiredShards = Number(explicit.requiredShards ?? segment.requiredShards);
  const repairThreshold = Number(explicit.repairThreshold ?? segment.repairThreshold);
  const totalShards = Number(explicit.totalShards ?? segment.totalShards);
  return {
    algorithm: explicit.algorithm,
    profileVersion: Number(explicit.profileVersion ?? segment.codingProfileVersion),
    dataShards,
    parityShards,
    requiredShards,
    repairThreshold,
    totalShards,
  };
}

export async function buildManifestV3(fields, signer) {
  if (signer?.algorithm !== ALG_ED25519) throw new Error("Protocol v3 manifests require Ed25519.");
  const core = {
    manifestFormatVersion: MANIFEST_FORMAT_VERSION,
    storageProtocolVersion: STORAGE_PROTOCOL_VERSION,
    vaultId: fields.vaultId,
    fileVersionId: fields.fileVersionId,
    ownerPublicKey: signer.publicKey,
    algorithm: signer.algorithm,
    createdAt: Date.now(),
    originalHash: fields.originalHash,
    originalSize: fields.originalSize,
    segmentCount: fields.segmentCount,
    boundaryMethod: fields.boundaryMethod,
    segments: fields.segments,
  };
  const manifestHash = await canonicalHashHex(core);
  const signable = { ...core, manifestHash };
  const signature = bytesToBase64Url(await signer.sign(canonicalBytes(signable)));
  const manifestId = await canonicalHashHex({ ...signable, signature });
  return { manifestId, ...signable, signature };
}

export async function verifyManifestV3(envelope, opts = {}) {
  const {
    expectedManifestId = null,
    expectedVaultId = null,
    expectedOwnerPublicKey = null,
    expectedFileVersionId = null,
    isRevokedKey,
    isSuperseded,
  } = opts;
  if (!envelope || typeof envelope !== "object") return { valid: false, reason: "malformed" };
  if (envelope.manifestFormatVersion !== MANIFEST_FORMAT_VERSION || envelope.storageProtocolVersion !== STORAGE_PROTOCOL_VERSION) {
    return { valid: false, reason: "unsupported_protocol_version" };
  }
  if (envelope.algorithm !== ALG_ED25519) return { valid: false, reason: "unsupported_algorithm" };
  if (expectedManifestId && envelope.manifestId !== expectedManifestId) return { valid: false, reason: "wrong_manifest" };
  if (expectedVaultId && envelope.vaultId !== expectedVaultId) return { valid: false, reason: "wrong_vault" };
  if (expectedOwnerPublicKey && envelope.ownerPublicKey !== expectedOwnerPublicKey) return { valid: false, reason: "wrong_owner" };
  if (expectedFileVersionId && envelope.fileVersionId !== expectedFileVersionId) return { valid: false, reason: "wrong_file_version" };
  if (isRevokedKey?.(envelope.ownerPublicKey)) return { valid: false, reason: "revoked_issuer" };
  if (!UUID_RE.test(String(envelope.fileVersionId || ""))) return { valid: false, reason: "invalid_file_version" };
  if (!Number.isSafeInteger(envelope.createdAt) || envelope.createdAt <= 0 || envelope.createdAt > Date.now() + 24 * 60 * 60 * 1000) return { valid: false, reason: "invalid_created_at" };
  if (envelope.boundaryMethod !== "fixed-8MiB") return { valid: false, reason: "invalid_boundary_method" };
  if (!HASH_RE.test(envelope.originalHash) || !Number.isSafeInteger(envelope.originalSize) || envelope.originalSize < 0) return { valid: false, reason: "invalid_original" };
  if (!Array.isArray(envelope.segments) || envelope.segmentCount !== envelope.segments.length || !Number.isSafeInteger(envelope.segmentCount) || envelope.segmentCount < 1) {
    return { valid: false, reason: "invalid_segment_count" };
  }
  let summedOriginalSize = 0;
  for (const segment of envelope.segments) {
    const profile = readSegmentErasureProfile(segment);
    if (
      !UUID_RE.test(String(segment.segmentId || ""))
      || segment.storageFormatVersion !== 3
      || segment.keyDerivationVersion !== 3
      || !Number.isSafeInteger(segment.encryptionGeneration)
      || segment.encryptionGeneration < 1
      || !HASH_RE.test(String(segment.dedupToken || ""))
      || !HASH_RE.test(String(segment.cipherHash || ""))
      || !HASH_RE.test(String(segment.ownerDescriptorHash || ""))
      || typeof segment.ownerDescriptorSignature !== "string"
      || !Number.isSafeInteger(segment.originalSize)
      || segment.originalSize < 0
      || !Number.isSafeInteger(segment.storedSize)
      || segment.storedSize < 0
      || !Number.isSafeInteger(segment.cipherSize)
      || segment.cipherSize !== segment.storedSize + 28
      || !["none", "gzip"].includes(segment.compression)
      || segment.encryptedPrivateMetadata?.v !== 3
      || typeof segment.encryptedPrivateMetadata?.iv !== "string"
      || typeof segment.encryptedPrivateMetadata?.cipher !== "string"
      || typeof segment.encryptedPrivateMetadata?.aad !== "string"
      || segment.encryptedPrivateMetadata.aad.length > 2048
      || !Array.isArray(segment.placements)
      || segment.placements.length > 128
      || !Array.isArray(segment.shardHashes)
      || segment.shardHashes.length !== profile.totalShards
      || segment.shardHashes.some((hash) => !HASH_RE.test(String(hash || "")))
      || profile.algorithm !== "reed-solomon"
      || profile.profileVersion !== 2
      || !Number.isInteger(profile.dataShards)
      || !Number.isInteger(profile.parityShards)
      || !Number.isInteger(profile.requiredShards)
      || !Number.isInteger(profile.repairThreshold)
      || !Number.isInteger(profile.totalShards)
      || profile.dataShards < 2
      || profile.parityShards < 1
      || profile.requiredShards !== profile.dataShards
      || profile.totalShards !== profile.dataShards + profile.parityShards
      || profile.requiredShards > profile.repairThreshold
      || profile.repairThreshold > profile.totalShards
    ) return { valid: false, reason: "invalid_segment" };
    try {
      if (base64UrlToBytes(envelope.ownerPublicKey).byteLength !== 32
        || base64UrlToBytes(segment.ownerDescriptorSignature).byteLength !== 64
        || base64UrlToBytes(segment.encryptedPrivateMetadata.iv.replace(/\+/g, "-").replace(/\//g, "_")).byteLength !== 12
        || base64UrlToBytes(segment.encryptedPrivateMetadata.cipher.replace(/\+/g, "-").replace(/\//g, "_")).byteLength > 4096
        || segment.placements.some((placement) => !Number.isInteger(placement?.shardIndex) || placement.shardIndex < 0 || placement.shardIndex >= profile.totalShards || typeof placement?.nodeId !== "string" || placement.nodeId.length > 128)) {
        return { valid: false, reason: "invalid_segment" };
      }
    } catch { return { valid: false, reason: "invalid_segment" }; }
    const descriptorResult = await verifySegmentDescriptor({ ...segment, vaultId: envelope.vaultId }, envelope.ownerPublicKey);
    if (!descriptorResult.valid) return { valid: false, reason: `invalid_segment_descriptor:${descriptorResult.reason}` };
    summedOriginalSize += segment.originalSize;
  }
  if (summedOriginalSize !== envelope.originalSize) return { valid: false, reason: "original_size_mismatch" };
  const { manifestId, manifestHash, signature, ...core } = envelope;
  if ((await canonicalHashHex(core)) !== manifestHash) return { valid: false, reason: "invalid_manifest_hash" };
  const signable = { ...core, manifestHash };
  if ((await canonicalHashHex({ ...signable, signature })) !== manifestId) return { valid: false, reason: "manifest_id_mismatch" };
  try {
    const publicBytes = base64UrlToBytes(envelope.ownerPublicKey);
    if (publicBytes.byteLength !== 32 || base64UrlToBytes(signature).byteLength !== 64) return { valid: false, reason: "invalid_signature" };
    if ((await hashHex(publicBytes)) !== envelope.vaultId) return { valid: false, reason: "not_self_certifying" };
    const publicKey = await importPublicKeyRaw(publicBytes, envelope.algorithm);
    const valid = await verifySignature(publicKey, envelope.algorithm, base64UrlToBytes(signature), canonicalBytes(signable));
    if (!valid) return { valid: false, reason: "invalid_signature" };
  } catch {
    return { valid: false, reason: "invalid_signature" };
  }
  if (isSuperseded?.(envelope)) return { valid: false, reason: "superseded" };
  return { valid: true };
}
