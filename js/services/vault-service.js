import { appTable } from "./supabase.js";
import { base64UrlToBytes, hashHex } from "../security/signing.js";
import { encryptJson, decryptJson } from "../security/keyring.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const DB_NAME = `${prefix}vault-settings-v1`;
const STORE = "settings";
const DEFAULT_CONTRIBUTION_BYTES = window.__DATA__?.limits?.defaultContributionBytes || 1073741824;
const MAX_CONTRIBUTION_BYTES = window.__DATA__?.limits?.maxContributionBytes || 10737418240;
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
  return row?.value === "high" ? "high" : "standard";
}
export async function setErasureClass(value) {
  const normalized = value === "high" ? "high" : "standard";
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
export async function getVaultProfile(vaultId) {
  const row = await idb((store) => store.get(profileKey(vaultId))).catch(() => null);
  if (!row?.value) return { name: "" };
  try { return cleanProfile(await decryptJson(row.value)); }
  catch { return { name: "", location: "" }; }
}
export async function setVaultProfile(vaultId, profile = {}) {
  const value = cleanProfile(profile);
  const encrypted = await encryptJson(value, `vault-profile-v1:${vaultId}`);
  await idb((store) => store.put({ key: profileKey(vaultId), value: encrypted }), "readwrite");
  return value;
}

function identityMismatch(message) {
  const error = new Error(message);
  error.code = "VAULT_IDENTITY_MISMATCH";
  return error;
}

function verifyRegisteredIdentity(row, identity) {
  if (row.owner_public_key !== identity.ownerPublicKey || row.owner_key_algorithm !== identity.algorithm) {
    throw identityMismatch("The registered vault identity does not match this Mesh Key.");
  }
  return row;
}

export async function ensureVaultRegistration(identity) {
  if (!identity?.vaultId || !identity?.ownerPublicKey || !identity?.algorithm) throw new Error("A complete vault identity is required.");
  const derivedVaultId = await hashHex(base64UrlToBytes(identity.ownerPublicKey));
  if (derivedVaultId !== identity.vaultId) throw identityMismatch("The local vault ID does not match its owner public key.");

  const readRegistered = async () => {
    const { data, error } = await appTable("vaults")
      .select("vault_id,owner_public_key,owner_key_algorithm")
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
    }).select("vault_id,owner_public_key,owner_key_algorithm").single();
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
