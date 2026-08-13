import {
  ALG_ED25519,
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalBytes,
  canonicalHashHex,
  hashHex,
  importPublicKeyRaw,
  verify as verifySignature,
} from "./signing.js";

const HASH_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function integer(value, fallback = 0) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) ? number : Number.NaN;
}

function currentShardHashes(segment) {
  if (Array.isArray(segment.shardHashes)) return segment.shardHashes.map((hash) => String(hash || ""));
  const generation = integer(segment.codingGeneration ?? segment.coding_generation, 1);
  return [...(segment.segmentShards || segment.segment_shards || [])]
    .filter((shard) => integer(shard.codingGeneration ?? shard.coding_generation, 1) === generation)
    .sort((left, right) => integer(left.shardIndex ?? left.shard_index) - integer(right.shardIndex ?? right.shard_index))
    .map((shard) => String(shard.shardHash || shard.shard_hash || ""));
}

export async function segmentDescriptorCore(segment = {}) {
  const encryptedPrivateMetadata = segment.encryptedPrivateMetadata || segment.encrypted_private_metadata;
  return {
    descriptorVersion: 3,
    vaultId: String(segment.vaultId || segment.vault_id || ""),
    segmentId: String(segment.segmentId || segment.id || ""),
    dedupToken: String(segment.dedupToken || segment.dedup_fingerprint || ""),
    storageFormatVersion: integer(segment.storageFormatVersion ?? segment.format_version, 3),
    keyDerivationVersion: integer(segment.keyDerivationVersion ?? segment.key_derivation_version, 3),
    encryptionGeneration: integer(segment.encryptionGeneration ?? segment.encryption_generation, 1),
    originalSize: integer(segment.originalSize ?? segment.original_size_bytes),
    storedSize: integer(segment.storedSize ?? segment.stored_size_bytes),
    cipherSize: integer(segment.cipherSize ?? segment.cipher_size_bytes),
    compression: String(segment.compression || segment.compression_method || "none"),
    cipherHash: String(segment.cipherHash || segment.cipher_hash || ""),
    privateMetadataHash: await canonicalHashHex(encryptedPrivateMetadata),
    codingGeneration: integer(segment.codingGeneration ?? segment.coding_generation, 1),
    erasureCoding: {
      algorithm: "reed-solomon",
      profileVersion: 2,
      dataShards: integer(segment.dataShards ?? segment.data_shards),
      parityShards: integer(segment.parityShards ?? segment.parity_shards),
      requiredShards: integer(segment.requiredShards ?? segment.required_shards),
      repairThreshold: integer(segment.repairThreshold ?? segment.repair_threshold ?? segment.requiredShards ?? segment.required_shards),
      totalShards: integer(segment.totalShards ?? segment.total_shards),
    },
    shardHashes: currentShardHashes(segment),
  };
}

function validCore(core) {
  const profile = core.erasureCoding;
  return HASH_RE.test(core.vaultId)
    && UUID_RE.test(core.segmentId)
    && HASH_RE.test(core.dedupToken)
    && core.storageFormatVersion === 3
    && core.keyDerivationVersion === 3
    && core.encryptionGeneration >= 1
    && core.originalSize >= 0
    && core.storedSize >= 0
    && core.cipherSize === core.storedSize + 28
    && ["none", "gzip"].includes(core.compression)
    && HASH_RE.test(core.cipherHash)
    && HASH_RE.test(core.privateMetadataHash)
    && core.codingGeneration >= 1
    && profile.algorithm === "reed-solomon"
    && profile.profileVersion === 2
    && profile.dataShards >= 2
    && profile.parityShards >= 1
    && profile.requiredShards === profile.dataShards
    && profile.totalShards === profile.dataShards + profile.parityShards
    && profile.repairThreshold >= profile.requiredShards
    && profile.repairThreshold <= profile.totalShards
    && core.shardHashes.length === profile.totalShards
    && core.shardHashes.every((hash) => HASH_RE.test(hash));
}

export async function signSegmentDescriptor(segment, signer) {
  if (signer?.algorithm !== ALG_ED25519) throw new Error("Protocol v3 segment descriptors require Ed25519.");
  const core = await segmentDescriptorCore(segment);
  if (!validCore(core)) throw new Error("The segment descriptor is incomplete or invalid.");
  const descriptorHash = await canonicalHashHex(core);
  const signature = bytesToBase64Url(await signer.sign(canonicalBytes({ ...core, descriptorHash })));
  return { descriptorHash, signature };
}

export async function verifySegmentDescriptor(segment, ownerPublicKey) {
  try {
    const core = await segmentDescriptorCore(segment);
    if (!validCore(core)) return { valid: false, reason: "invalid_descriptor" };
    const descriptorHash = String(segment.ownerDescriptorHash || segment.owner_descriptor_hash || "");
    const signature = String(segment.ownerDescriptorSignature || segment.owner_descriptor_signature || "");
    if (!HASH_RE.test(descriptorHash) || await canonicalHashHex(core) !== descriptorHash) return { valid: false, reason: "descriptor_hash_mismatch" };
    const publicBytes = base64UrlToBytes(ownerPublicKey);
    const signatureBytes = base64UrlToBytes(signature);
    if (publicBytes.byteLength !== 32 || signatureBytes.byteLength !== 64) return { valid: false, reason: "invalid_signature" };
    if (await hashHex(publicBytes) !== core.vaultId) return { valid: false, reason: "wrong_owner" };
    const publicKey = await importPublicKeyRaw(publicBytes, ALG_ED25519);
    const valid = await verifySignature(publicKey, ALG_ED25519, signatureBytes, canonicalBytes({ ...core, descriptorHash }));
    return valid ? { valid: true, core, descriptorHash } : { valid: false, reason: "invalid_signature" };
  } catch {
    return { valid: false, reason: "malformed_descriptor" };
  }
}
