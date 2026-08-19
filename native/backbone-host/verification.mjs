import { createHash, createPublicKey, verify } from "node:crypto";

const sortDeep = (value) => Array.isArray(value) ? value.map(sortDeep) : value && typeof value === "object" ? Object.keys(value).sort().reduce((out, key) => { out[key] = sortDeep(value[key]); return out; }, {}) : value;
const canonical = (value) => Buffer.from(JSON.stringify(sortDeep(value)));
const hashHex = (value) => createHash("sha256").update(value).digest("hex");
const key = (raw) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" });

export function verifyControlObject(object) {
  if (!object?.objectId || object.protocolVersion !== 3 || !object.senderPublicKey || !object.signature || !object.payloadHash) return false;
  if (Number(object.expiresAt || 0) <= Date.now() || Number(object.createdAt || 0) > Date.now() + 300000 || Number(object.expiresAt) - Number(object.createdAt) > 31 * 86400000) return false;
  const { signature, objectId, storedAt, lastAccessedAt, sizeBytes, replicaNodeIds, semanticKey, retentionGroup, ...core } = object;
  if (hashHex(canonical(object.payload)) !== object.payloadHash) return false;
  if (hashHex(canonical({ ...core, signature })) !== objectId) return false;
  try { return verify(null, canonical(core), key(object.senderPublicKey), Buffer.from(signature, "base64url")); } catch { return false; }
}

export function verifyManifestEnvelope(envelope) {
  if (!envelope?.manifestId || envelope.manifestFormatVersion !== 3 || envelope.storageProtocolVersion !== 3 || !envelope.ownerPublicKey || !envelope.signature) return false;
  const { manifestId, manifestHash, signature, ...core } = envelope;
  if (hashHex(canonical(core)) !== manifestHash || hashHex(canonical({ ...core, manifestHash, signature })) !== manifestId) return false;
  if (hashHex(Buffer.from(envelope.ownerPublicKey, "base64url")) !== envelope.vaultId) return false;
  try { return verify(null, canonical({ ...core, manifestHash }), key(envelope.ownerPublicKey), Buffer.from(signature, "base64url")); } catch { return false; }
}

export function verifyDeletionAuthorization(authorization, instanceId, shardHash) {
  if (!authorization || authorization.protocolVersion !== 3 || authorization.nodeId !== instanceId || authorization.shardHash !== shardHash) return false;
  if (!authorization.ownerPublicKey || !authorization.signature || Number(authorization.issuedAt || 0) > Date.now() + 300000) return false;
  if (hashHex(Buffer.from(authorization.ownerPublicKey, "base64url")) !== authorization.vaultId) return false;
  const { signature, ...core } = authorization;
  try { return verify(null, canonical(core), key(authorization.ownerPublicKey), Buffer.from(signature, "base64url")); } catch { return false; }
}
