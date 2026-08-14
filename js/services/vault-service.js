import { appTable } from "./supabase.js";
import {
  base64UrlToBytes, bytesToBase64Url, canonicalBytes, hashHex,
  importPublicKeyRaw, verify as verifySignature,
} from "../security/signing.js";
import { encryptJson, decryptJson } from "../security/keyring.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}vault-settings-v3`;
const STORE = "settings";
const DEFAULT_CONTRIBUTION_BYTES = window.__DATA__?.limits?.defaultContributionBytes || 1073741824;
const MAX_CONTRIBUTION_BYTES = window.__DATA__?.limits?.maxContributionBytes || 268435456000;
const DEFAULT_ANCHOR_CACHE_BYTES = window.__DATA__?.anchor?.defaultCacheBytes || 104857600;
const MIN_ANCHOR_CACHE_BYTES = window.__DATA__?.anchor?.minimumCacheBytes || 26214400;
const MAX_ANCHOR_CACHE_BYTES = window.__DATA__?.anchor?.maximumCacheBytes || 1073741824;

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function idb(action, mode = "readonly") {
  const db = await database();
  return new Promise((resolve, reject) => { const tx = db.transaction(STORE, mode); const request = action(tx.objectStore(STORE)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export async function getContributionLimit() {
  const row = await idb((store) => store.get("contributionLimitBytes")).catch(() => null);
  return row ? Number(row.value) : DEFAULT_CONTRIBUTION_BYTES;
}
export async function setContributionLimit(bytes) {
  const value = Math.max(0, Math.min(MAX_CONTRIBUTION_BYTES, Number(bytes) || 0));
  await idb((store) => store.put({ key: "contributionLimitBytes", value }), "readwrite");
  return value;
}
export async function getStorageNodeOnly() {
  const row = await idb((store) => store.get("storageNodeOnly")).catch(() => null);
  return !!row?.value;
}
export async function setStorageNodeOnly(enabled) {
  await idb((store) => store.put({ key: "storageNodeOnly", value: !!enabled }), "readwrite");
  return !!enabled;
}
export async function getErasureClass() {
  const row = await idb((store) => store.get("erasureClass")).catch(() => null);
  const fallback = window.__DATA__?.resilience?.defaultErasureClass || "auto";
  return ["auto", "standard", "high"].includes(row?.value) ? row.value : fallback;
}
export async function setErasureClass(value) {
  const normalized = ["auto", "standard", "high"].includes(value) ? value : "auto";
  await idb((store) => store.put({ key: "erasureClass", value: normalized }), "readwrite");
  return normalized;
}
export async function getAnchorSettings() {
  const row = await idb((store) => store.get("anchorSettings")).catch(() => null);
  return {
    enabled: !!row?.value?.enabled,
    cacheLimitBytes: Math.max(MIN_ANCHOR_CACHE_BYTES, Math.min(MAX_ANCHOR_CACHE_BYTES, Number(row?.value?.cacheLimitBytes) || DEFAULT_ANCHOR_CACHE_BYTES)),
  };
}
export async function setAnchorSettings(settings = {}) {
  const current = await getAnchorSettings();
  const value = {
    enabled: settings.enabled === undefined ? current.enabled : !!settings.enabled,
    cacheLimitBytes: Math.max(MIN_ANCHOR_CACHE_BYTES, Math.min(MAX_ANCHOR_CACHE_BYTES, Number(settings.cacheLimitBytes) || current.cacheLimitBytes)),
  };
  await idb((store) => store.put({ key: "anchorSettings", value }), "readwrite");
  return value;
}

function cleanProfile(profile = {}) {
  return {
    name: String(profile.name || "").trim().slice(0, 80),
  };
}
function profileKey(vaultId) {
  const id = String(vaultId || "").trim();
  if (!id) throw new Error("A vault is required to save profile details.");
  return `vaultProfile:${id}`;
}

function profileSignable(vaultId, revision, encryptedProfile) {
  return {
    vaultId,
    revision: Math.max(1, Math.floor(Number(revision) || 0)),
    encryptedProfile,
    protocolVersion: 3,
  };
}
const vaultProfileAad = (vaultId, revision) => `themeshvault/v3/vault-profile:${vaultId}:${Math.max(1, Math.floor(Number(revision) || 0))}`;

export async function buildEncryptedVaultProfile(identity, profile, revision = Date.now()) {
  if (!identity?.vaultId || !identity?.ownerPublicKey || !identity?.algorithm || typeof identity.sign !== "function") {
    throw new Error("The vault owner identity is required to sync its private name.");
  }
  const value = cleanProfile(profile);
  const nextRevision = Math.max(1, Math.floor(Number(revision) || Date.now()));
  const encryptedProfile = await encryptJson(value, vaultProfileAad(identity.vaultId, nextRevision));
  const signable = profileSignable(identity.vaultId, nextRevision, encryptedProfile);
  return {
    ...signable,
    ownerPublicKey: identity.ownerPublicKey,
    algorithm: identity.algorithm,
    signature: bytesToBase64Url(await identity.sign(canonicalBytes(signable))),
  };
}

export async function openEncryptedVaultProfile(record, identity) {
  if (!record || !identity?.vaultId || record.vaultId !== identity.vaultId
    || record.ownerPublicKey !== identity.ownerPublicKey || record.algorithm !== identity.algorithm) return null;
  try {
    const signable = profileSignable(record.vaultId, record.revision, record.encryptedProfile);
    const publicKey = await importPublicKeyRaw(base64UrlToBytes(record.ownerPublicKey), record.algorithm);
    const valid = await verifySignature(publicKey, record.algorithm, base64UrlToBytes(record.signature), canonicalBytes(signable));
    if (!valid) return null;
    return { ...cleanProfile(await decryptJson(record.encryptedProfile, vaultProfileAad(record.vaultId, signable.revision))), revision: signable.revision };
  } catch { return null; }
}

async function readLocalProfile(vaultId) {
  const row = await idb((store) => store.get(profileKey(vaultId))).catch(() => null);
  if (!row?.value) return { profile: { name: "" }, revision: 0, encryptedProfile: null };
  const revision = Math.max(0, Math.floor(Number(row.value.revision) || 0));
  const encryptedProfile = row.value.encryptedProfile || row.value;
  try { return { profile: cleanProfile(await decryptJson(encryptedProfile, vaultProfileAad(vaultId, revision))), revision, encryptedProfile }; }
  catch { return { profile: { name: "" }, revision: 0, encryptedProfile: null }; }
}

async function saveLocalProfile(vaultId, encryptedProfile, revision) {
  await idb((store) => store.put({
    key: profileKey(vaultId),
    value: { encryptedProfile, revision: Math.max(0, Math.floor(Number(revision) || 0)) },
  }), "readwrite");
}

async function readRemoteProfile(identity) {
  if (!identity?.vaultId) return { available: false, record: null };
  const { data, error } = await appTable("vaults")
    .select("vault_id,owner_public_key,owner_key_algorithm,encrypted_profile,profile_revision,profile_signature")
    .eq("vault_id", identity.vaultId)
    .maybeSingle();
  if (error) return { available: false, record: null, error };
  if (!data?.encrypted_profile || !data?.profile_signature) return { available: true, record: null };
  return {
    available: true,
    record: {
      vaultId: data.vault_id,
      ownerPublicKey: data.owner_public_key,
      algorithm: data.owner_key_algorithm,
      encryptedProfile: data.encrypted_profile,
      revision: Number(data.profile_revision) || 0,
      signature: data.profile_signature,
    },
  };
}

async function publishProfile(identity, profile, minimumRevision = 0) {
  const envelope = await buildEncryptedVaultProfile(identity, profile, Math.max(Date.now(), Number(minimumRevision) + 1));
  await saveLocalProfile(identity.vaultId, envelope.encryptedProfile, envelope.revision);
  const { data, error } = await appTable("vaults").update({
    encrypted_profile: envelope.encryptedProfile,
    profile_revision: envelope.revision,
    profile_signature: envelope.signature,
    profile_updated_at: new Date(envelope.revision).toISOString(),
  }).eq("vault_id", identity.vaultId)
    .lte("profile_revision", envelope.revision)
    .select("vault_id")
    .maybeSingle();
  return {
    ...cleanProfile(profile),
    revision: envelope.revision,
    synced: !error && !!data,
    syncStatus: !error && data ? "synced" : "local",
  };
}

export async function getVaultProfile(vaultId, identity = null) {
  const local = await readLocalProfile(vaultId);
  if (!identity?.vaultId) return { ...local.profile, revision: local.revision, synced: false, syncStatus: "local" };
  const remote = await readRemoteProfile(identity);
  const opened = remote.record ? await openEncryptedVaultProfile(remote.record, identity) : null;
  if (opened && opened.revision >= local.revision) {
    await saveLocalProfile(vaultId, remote.record.encryptedProfile, opened.revision);
    return { name: opened.name, revision: opened.revision, synced: true, syncStatus: "synced" };
  }
  if (local.profile.name && remote.available) {
    return publishProfile(identity, local.profile, Math.max(local.revision, opened?.revision || 0)).catch(() => ({
      ...local.profile, revision: local.revision, synced: false, syncStatus: "local",
    }));
  }
  return { ...local.profile, revision: local.revision, synced: false, syncStatus: remote.available ? "not-set" : "local" };
}

export async function setVaultProfile(identity, profile = {}) {
  const vaultId = identity?.vaultId;
  if (!vaultId) throw new Error("Open a vault before saving profile details.");
  const value = cleanProfile(profile);
  const local = await readLocalProfile(vaultId);
  const remote = await readRemoteProfile(identity);
  const opened = remote.record ? await openEncryptedVaultProfile(remote.record, identity) : null;
  return publishProfile(identity, value, Math.max(local.revision, opened?.revision || 0)).catch(async () => {
    const revision = Math.max(Date.now(), local.revision + 1);
    const encryptedProfile = await encryptJson(value, vaultProfileAad(vaultId, revision));
    await saveLocalProfile(vaultId, encryptedProfile, revision);
    return { ...value, revision, synced: false, syncStatus: "local" };
  });
}

function identityMismatch(message) {
  const error = new Error(message);
  error.code = "VAULT_IDENTITY_MISMATCH";
  return error;
}

function verifyRegisteredIdentity(row, identity) {
  if (Number(row.protocol_version) !== 3 || row.owner_public_key !== identity.ownerPublicKey || row.owner_key_algorithm !== identity.algorithm) {
    throw identityMismatch("The registered vault identity does not match this Mesh Key.");
  }
  return row;
}

export async function ensureVaultRegistration(identity) {
  if (!identity?.vaultId || !identity?.ownerPublicKey || !identity?.algorithm) throw new Error("A complete vault identity is required.");
  const publicBytes = base64UrlToBytes(identity.ownerPublicKey);
  let derivedVaultId;
  try { derivedVaultId = await hashHex(publicBytes); }
  finally { publicBytes.fill(0); }
  if (derivedVaultId !== identity.vaultId) throw identityMismatch("The local vault ID does not match its owner public key.");

  const readRegistered = async () => {
    const { data, error } = await appTable("vaults")
      .select("vault_id,owner_public_key,owner_key_algorithm,protocol_version")
      .eq("vault_id", identity.vaultId)
      .maybeSingle();
    if (error) throw error;
    return data;
  };

  let row = await readRegistered();
  if (!row) {
    const { data, error } = await appTable("vaults").insert({
      vault_id: identity.vaultId,
      owner_public_key: identity.ownerPublicKey,
      owner_key_algorithm: identity.algorithm,
      protocol_version: 3,
    }).select("vault_id,owner_public_key,owner_key_algorithm,protocol_version").single();
    if (error && error.code !== "23505") throw error;
    row = data || await readRegistered();
  }
  if (!row) throw new Error("The vault could not be registered with the coordination service.");
  verifyRegisteredIdentity(row, identity);

  const { error: touchError } = await appTable("vaults")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("vault_id", identity.vaultId)
    .eq("owner_public_key", identity.ownerPublicKey)
    .eq("owner_key_algorithm", identity.algorithm);
  if (touchError) throw touchError;
  return row;
}
