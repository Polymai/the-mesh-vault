import { canonicalBytes, bytesToBase64Url, base64UrlToBytes, importPublicKeyRaw, verify, hashHex } from "./signing.js";

export async function buildDeletionAuthorization({ vaultId, fileId, manifestId = null, shardHash, nodeId }, signer) {
  if (!vaultId || !fileId || !shardHash || !nodeId || !signer?.publicKey || typeof signer.sign !== "function") throw new Error("A complete owner-signed deletion request is required.");
  const core = {
    protocolVersion: 1, vaultId, fileId, manifestId: manifestId || null,
    shardHash, nodeId, issuedAt: Date.now(),
    ownerPublicKey: signer.publicKey, algorithm: signer.algorithm,
  };
  return { ...core, signature: bytesToBase64Url(await signer.sign(canonicalBytes(core))) };
}

export async function verifyDeletionAuthorization(authorization, { nodeId, shardHash } = {}) {
  if (!authorization || authorization.protocolVersion !== 1 || !authorization.vaultId || !authorization.fileId || !authorization.ownerPublicKey || !authorization.signature) return false;
  if (nodeId && authorization.nodeId !== nodeId) return false;
  if (shardHash && authorization.shardHash !== shardHash) return false;
  if (!Number.isFinite(authorization.issuedAt) || authorization.issuedAt > Date.now() + 300000) return false;
  if ((await hashHex(base64UrlToBytes(authorization.ownerPublicKey))) !== authorization.vaultId) return false;
  const { signature, ...core } = authorization;
  try {
    const key = await importPublicKeyRaw(base64UrlToBytes(authorization.ownerPublicKey), authorization.algorithm);
    return verify(key, authorization.algorithm, base64UrlToBytes(signature), canonicalBytes(core));
  } catch { return false; }
}
