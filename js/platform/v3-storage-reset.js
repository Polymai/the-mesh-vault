const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const RESET_MARKER = `${prefix}mesh-key-v3-local-reset`;
const VAULT_RESET_MARKER = `${prefix}pending-vault-reset-v3`;
const LEGACY_DATABASE_SUFFIXES = Object.freeze([
  "vault-identity-v1",
  "device-identity-v1",
  "vault-index-v1",
  "shards-v1",
  "anchor-control-v1",
  "anchor-control-v2",
  "oplog-v1",
  "fragment-location-cache-v1",
  "manifest-store-v1",
  "vault-settings-v1",
  "metadata-cache-v1",
]);
const PRIVATE_VAULT_DATABASE_SUFFIXES = Object.freeze([
  "vault-identity-v3",
  "vault-index-v3",
  "oplog-v3",
  "fragment-location-cache-v3",
  "manifest-store-v3",
  "metadata-cache-v3",
]);

function deleteDatabase(name) {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function deleteLegacyOpfsEntries() {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory().catch(() => null);
  if (!root) return;
  const oldShardPrefix = prefix.replace(/[^a-z0-9]/gi, "-");
  const oldShardPattern = new RegExp(`^${oldShardPrefix}[a-f0-9]{64}\\.bin$`, "i");
  const temporaryPlaintextPattern = /^meshvault-(?:download|share)-[a-f0-9-]+\.tmp$/i;
  for await (const [name] of root.entries()) {
    if (oldShardPattern.test(name) || temporaryPlaintextPattern.test(name)) await root.removeEntry(name).catch(() => {});
  }
}

function clearVaultLocalStorage(vaultId) {
  const safeVaultId = String(vaultId || "");
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix) && safeVaultId && key.includes(safeVaultId)) localStorage.removeItem(key);
  }
}

async function performPendingVaultReset() {
  const raw = localStorage.getItem(VAULT_RESET_MARKER);
  if (!raw) return false;
  let request;
  try { request = JSON.parse(raw); } catch { request = {}; }
  const deletionResults = await Promise.all(PRIVATE_VAULT_DATABASE_SUFFIXES.map(async (suffix) => ({
    suffix,
    deleted: await deleteDatabase(`${prefix}${suffix}`),
  })));
  const failedDatabases = deletionResults.filter((result) => !result.deleted).map((result) => result.suffix);
  if (failedDatabases.length) {
    throw new Error(`Close other TheMeshVault tabs and reload to finish removing this vault (${failedDatabases.join(", ")}).`);
  }
  clearVaultLocalStorage(request.vaultId);
  localStorage.removeItem(VAULT_RESET_MARKER);
  return true;
}

export function scheduleVaultLocalReset(vaultId, reason = "remove-device") {
  if (!vaultId) throw new Error("Open a vault before removing it from this device.");
  localStorage.setItem(VAULT_RESET_MARKER, JSON.stringify({
    vaultId: String(vaultId), reason: String(reason || "remove-device"), requestedAt: Date.now(),
  }));
}

export async function performV3LocalReset() {
  const vaultReset = await performPendingVaultReset();
  if (localStorage.getItem(RESET_MARKER) === "complete") return vaultReset;
  const deletionResults = await Promise.all(LEGACY_DATABASE_SUFFIXES.map(async (suffix) => ({
    suffix,
    deleted: await deleteDatabase(`${prefix}${suffix}`),
  })));
  const failedDatabases = deletionResults.filter((result) => !result.deleted).map((result) => result.suffix);
  if (failedDatabases.length) {
    throw new Error(`Close other TheMeshVault tabs and reload to finish the v3 security reset (${failedDatabases.join(", ")}).`);
  }
  await deleteLegacyOpfsEntries();
  localStorage.setItem(RESET_MARKER, "complete");
  return true;
}
