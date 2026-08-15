import { appTable, supabase } from "../services/supabase.js";
import { publishControlObject, queryAnchors, replicateOplogOperation } from "../network/anchor-service.js";
import { COORDINATION_MODES } from "../network/coordination-policy.js";
import { getCoordinationMode, isProviderUp } from "../network/providers/provider-registry.js";
import { canonicalHashHex } from "../security/signing.js";
import {
  buildVaultIndexEnvelope, getLocalVaultIndex, newestVaultIndex,
  normalizeVaultIndexPayload, openVaultIndexEnvelope, saveLocalVaultIndex,
  verifyVaultIndexEnvelope,
} from "./vault-index.js";
import {
  appendOperation, getBackbonePendingOperations, getUnsyncedOperations,
  ingestOperations, markSyncFailure, markSyncReceipt,
} from "../oplog/oplog-engine.js";

const INDEX_TTL_MS = 30 * 86400000;
const DEFAULT_BACKBONE_DELAY_MS = 5 * 60 * 1000;

let identity = null;
let mutationChain = Promise.resolve();
let backboneTimer = null;
let operationLoadPromise = null;
let lastOperationLoadAt = 0;

function operationSyncConfig() { return window.__DATA__?.coordination || {}; }
function operationCursorKey(vaultId) { return `${window.__DATA__?.appStoragePrefix || "polymai:app717:"}operation-cache-cursor:${vaultId}`; }
function readOperationCursor(vaultId) {
  try { return Math.max(0, Number(localStorage.getItem(operationCursorKey(vaultId))) || 0); }
  catch { return 0; }
}
function writeOperationCursor(vaultId, value) {
  try { localStorage.setItem(operationCursorKey(vaultId), String(Math.max(0, Number(value) || 0))); } catch {}
}

function configuredIdentity() {
  if (!identity?.vaultId) throw new Error("The vault control repository is not configured.");
  return identity;
}

function indexRow(envelope) {
  return {
    vault_id: envelope.vaultId,
    owner_public_key: envelope.ownerPublicKey,
    owner_key_algorithm: envelope.algorithm,
    revision: envelope.revision,
    previous_index_hash: envelope.previousIndexHash,
    payload_hash: envelope.payloadHash,
    encrypted_index: envelope.encryptedPayload,
    index_hash: envelope.indexHash,
    signature: envelope.signature,
    protocol_version: envelope.protocolVersion,
    created_at: new Date(envelope.createdAt).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function rowEnvelope(row) {
  if (!row) return null;
  return {
    format: "themeshvault-vault-index",
    protocolVersion: Number(row.protocol_version),
    vaultId: row.vault_id,
    ownerPublicKey: row.owner_public_key,
    algorithm: row.owner_key_algorithm,
    revision: Number(row.revision),
    previousIndexHash: row.previous_index_hash || null,
    payloadHash: row.payload_hash,
    encryptedPayload: row.encrypted_index,
    indexHash: row.index_hash,
    signature: row.signature,
    createdAt: new Date(row.created_at).getTime(),
  };
}

async function readSupabaseIndex(vaultId) {
  const { data, error } = await appTable("vault_index_cache").select("*").eq("vault_id", vaultId).maybeSingle();
  if (error) throw error;
  const envelope = rowEnvelope(data);
  return envelope && (await verifyVaultIndexEnvelope(envelope, { vaultId })).valid ? envelope : null;
}

async function writeSupabaseIndex(envelope) {
  const row = indexRow(envelope);
  const { data: written, error: rpcError } = await supabase.schema("app717_meshvault").rpc("publish_vault_index", {
    p_vault_id: row.vault_id,
    p_owner_public_key: row.owner_public_key,
    p_owner_key_algorithm: row.owner_key_algorithm,
    p_revision: row.revision,
    p_previous_index_hash: row.previous_index_hash,
    p_payload_hash: row.payload_hash,
    p_encrypted_index: row.encrypted_index,
    p_index_hash: row.index_hash,
    p_signature: row.signature,
    p_protocol_version: row.protocol_version,
    p_created_at: row.created_at,
  });
  if (rpcError) {
    const message = `${rpcError.code || ""} ${rpcError.message || ""} ${rpcError.details || ""}`;
    if (!/PGRST202|could not find.*publish_vault_index|schema cache/i.test(message)) throw rpcError;
    const { error } = await appTable("vault_index_cache").upsert(row, { onConflict: "vault_id" });
    if (error) throw error;
    return true;
  }
  return written !== false;
}

async function publishIndexToAnchors(envelope) {
  const object = await publishControlObject("vault-index", envelope.vaultId, envelope, INDEX_TTL_MS);
  return Number(object?.replicaCount || 0);
}

function shouldDeferBackbone(anchorReplicas) {
  return getCoordinationMode() === COORDINATION_MODES.ANCHOR_PRIMARY
    && anchorReplicas >= Number(window.__DATA__?.coordination?.minimumMeshAnchors || 2);
}

function scheduleBackboneFlush() {
  clearTimeout(backboneTimer);
  const delay = Number(window.__DATA__?.coordination?.operationBackboneFlushMs) || DEFAULT_BACKBONE_DELAY_MS;
  backboneTimer = window.setTimeout(() => {
    backboneTimer = null;
    flushControlPlane({ forceBackbone: true }).catch(() => {});
  }, delay);
}

export function configureControlRepository(vaultIdentity) {
  identity = vaultIdentity || null;
}

export function clearControlRepository() {
  identity = null;
  clearTimeout(backboneTimer);
  backboneTimer = null;
  operationLoadPromise = null;
  lastOperationLoadAt = 0;
}

export async function loadVaultCatalog({ includeSupabase = true, includeAnchors = true } = {}) {
  const owner = configuredIdentity();
  const candidates = [];
  const local = await getLocalVaultIndex(owner.vaultId);
  if (local) {
    candidates.push(local);
    // Normal rendering is local-first. Callers that explicitly request the
    // hosted copy still reconcile Anchor and Supabase candidates below.
    if (!includeSupabase && !includeAnchors) {
      const opened = await openVaultIndexEnvelope(local, owner).catch(() => null);
      if (opened) return opened;
    }
  }

  const anchorRows = includeAnchors ? await queryAnchors("vault-index", owner.vaultId, 10).catch(() => []) : [];
  for (const row of anchorRows) {
    const envelope = row?.payload;
    if (envelope && (await verifyVaultIndexEnvelope(envelope, { vaultId: owner.vaultId })).valid) candidates.push(envelope);
  }

  if (includeSupabase && isProviderUp("supabase")) {
    const remote = await readSupabaseIndex(owner.vaultId).catch(() => null);
    if (remote) candidates.push(remote);
  }

  const newest = newestVaultIndex(candidates);
  if (!newest) return null;
  await saveLocalVaultIndex(newest);
  return openVaultIndexEnvelope(newest, owner);
}

export async function publishVaultCatalog(payload, { forceSupabase = false } = {}) {
  const owner = configuredIdentity();
  const normalized = normalizeVaultIndexPayload(payload);
  const current = await loadVaultCatalog({ includeSupabase: false, includeAnchors: false }).catch(() => null);
  if (current?.envelope?.payloadHash) {
    if ((await canonicalHashHex(normalized)) === current.envelope.payloadHash) return current.envelope;
  }
  let revision = Math.max(Date.now(), Number(current?.envelope?.revision || 0) + 1);
  let envelope = await buildVaultIndexEnvelope(owner, normalized, {
    revision,
    previousIndexHash: current?.envelope?.indexHash || null,
  });
  await saveLocalVaultIndex(envelope);
  const anchorReplicas = await publishIndexToAnchors(envelope).catch(() => 0);
  if (forceSupabase || !shouldDeferBackbone(anchorReplicas)) {
    const written = await writeSupabaseIndex(envelope).catch((error) => {
      scheduleBackboneFlush();
      if (!anchorReplicas) throw error;
      return true;
    });
    if (!written) {
      const remote = await readSupabaseIndex(owner.vaultId).catch(() => null);
      const opened = remote ? await openVaultIndexEnvelope(remote, owner) : null;
      if (opened && remote.indexHash !== envelope.indexHash) {
        revision = Math.max(Date.now(), Number(remote.revision) + 1, Number(envelope.revision) + 1);
        envelope = await buildVaultIndexEnvelope(owner, normalized, {
          revision,
          previousIndexHash: remote.indexHash,
        });
        await saveLocalVaultIndex(envelope);
        await publishIndexToAnchors(envelope).catch(() => 0);
        if (!(await writeSupabaseIndex(envelope))) {
          scheduleBackboneFlush();
          throw new Error("The signed vault index changed on another device. Its local operation remains queued for replay.");
        }
      } else if (!opened) {
        scheduleBackboneFlush();
        if (!anchorReplicas) {
          throw new Error("The hosted vault index could not be verified. The valid local index was retained for a later retry.");
        }
      }
    }
  } else {
    scheduleBackboneFlush();
  }
  return envelope;
}

async function mutateCatalog(mutator) {
  const run = async () => {
    // The explicit startup sync has already reconciled remote revisions.
    // Reading Supabase again before every local file/folder mutation doubled
    // coordination traffic without adding useful protection.
    const current = await loadVaultCatalog({ includeSupabase: false, includeAnchors: false }).catch(() => null);
    const payload = normalizeVaultIndexPayload(current?.payload || {});
    await mutator(payload);
    return publishVaultCatalog(payload);
  };
  mutationChain = mutationChain.then(run, run);
  return mutationChain;
}

export function replaceCatalogSection(section, rows) {
  if (!["folders", "files", "tombstones", "repairState"].includes(section)) throw new Error("Unknown vault-index section.");
  return mutateCatalog((payload) => { payload[section] = Array.isArray(rows) ? structuredClone(rows) : []; });
}

export function upsertCatalogRow(section, row) {
  if (!["folders", "files", "tombstones", "repairState"].includes(section) || !row?.id) return Promise.resolve(null);
  return mutateCatalog((payload) => {
    payload[section] = [structuredClone(row), ...payload[section].filter((entry) => entry.id !== row.id)];
  });
}

export function removeCatalogRow(section, id) {
  if (!["folders", "files", "tombstones", "repairState"].includes(section) || !id) return Promise.resolve(null);
  return mutateCatalog((payload) => { payload[section] = payload[section].filter((entry) => entry.id !== id); });
}

export async function appendCatalogOperation(opType, payload) {
  const owner = configuredIdentity();
  const signer = { publicKey: owner.ownerPublicKey, algorithm: owner.algorithm, sign: owner.sign };
  return appendOperation(signer, owner.vaultId, opType, payload);
}

function operationRow(operation) {
  const { synced, syncReceipts, syncAttempts, nextSyncAt, lastSyncError, ...envelope } = operation;
  return {
    op_id: envelope.opId,
    vault_id: envelope.vaultId,
    op_sequence: envelope.seq,
    actor_public_key: envelope.actorPublicKey,
    algorithm: envelope.algorithm,
    operation: envelope,
    created_at: new Date(envelope.timestamp).toISOString(),
  };
}

function portableOperation(operation) {
  const { synced, syncReceipts, syncAttempts, nextSyncAt, lastSyncError, ...envelope } = operation;
  return envelope;
}

async function writeSupabaseOperation(operation) {
  const { error } = await appTable("vault_operation_cache").upsert(operationRow(operation), { onConflict: "op_id", ignoreDuplicates: true });
  if (error) throw error;
  await markSyncReceipt(operation.opId, "supabase");
  return true;
}

export async function replicateOperation(operation, { forceBackbone = false } = {}) {
  let anchorReplicas = 0;
  try {
    anchorReplicas = await replicateOplogOperation(portableOperation(operation));
    if (anchorReplicas > 0) await markSyncReceipt(operation.opId, "anchor", { replicas: anchorReplicas });
  } catch {}
  const defer = !forceBackbone && shouldDeferBackbone(anchorReplicas);
  let supabaseWritten = false;
  if (!defer) {
    try {
      await writeSupabaseOperation(operation);
      supabaseWritten = true;
    }
    catch (error) {
      await markSyncFailure(operation.opId, error, Math.min(60000, 2000 * (2 ** Math.min(5, Number(operation.syncAttempts || 0))))).catch(() => {});
      if (!anchorReplicas) throw error;
      scheduleBackboneFlush();
    }
  } else {
    scheduleBackboneFlush();
  }
  return anchorReplicas > 0 || defer || supabaseWritten;
}

export async function flushControlPlane({ forceBackbone = false } = {}) {
  const owner = configuredIdentity();
  const pending = forceBackbone
    ? await getBackbonePendingOperations(owner.vaultId)
    : await getUnsyncedOperations(owner.vaultId);
  for (const operation of pending) await replicateOperation(operation, { forceBackbone }).catch(() => {});
  if (forceBackbone) {
    const local = await getLocalVaultIndex(owner.vaultId);
    if (local) await writeSupabaseIndex(local).catch(() => {});
  }
  return pending.length;
}

async function readSupabaseOperationDelta(vaultId) {
  const config = operationSyncConfig();
  const initialLimit = Math.max(20, Math.min(500, Number(config.operationInitialBatchSize) || 200));
  const batchSize = Math.max(20, Math.min(500, Number(config.operationDeltaBatchSize) || 200));
  const maxBatches = Math.max(1, Math.min(5, Number(config.operationDeltaMaxBatches) || 3));
  const cursor = readOperationCursor(vaultId);
  const rows = [];
  let nextCursor = cursor;
  try {
    if (!cursor) {
      const result = await appTable("vault_operation_cache")
        .select("cache_sequence,operation").eq("vault_id", vaultId)
        .order("cache_sequence", { ascending: false }).limit(initialLimit);
      if (result.error) throw result.error;
      rows.push(...(result.data || []).reverse());
    } else {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const result = await appTable("vault_operation_cache")
          .select("cache_sequence,operation").eq("vault_id", vaultId)
          .gt("cache_sequence", nextCursor).order("cache_sequence", { ascending: true }).limit(batchSize);
        if (result.error) throw result.error;
        const page = result.data || [];
        rows.push(...page);
        if (page.length) nextCursor = Math.max(nextCursor, ...page.map((row) => Number(row.cache_sequence) || 0));
        if (page.length < batchSize) break;
      }
    }
  } catch {
    // Provisioning can briefly lag behind the frontend. The compatibility
    // path is deliberately bounded and never restores the former 5,000-row read.
    const result = await appTable("vault_operation_cache")
      .select("operation").eq("vault_id", vaultId)
      .order("created_at", { ascending: false }).order("op_id", { ascending: false }).limit(initialLimit);
    return { operations: (result.error ? [] : result.data || []).map((row) => row.operation).filter(Boolean), nextCursor: cursor };
  }
  if (rows.length) {
    nextCursor = Math.max(nextCursor, ...rows.map((row) => Number(row.cache_sequence) || 0));
  }
  return { operations: rows.map((row) => row.operation).filter(Boolean), nextCursor };
}

export async function loadReplicatedOperations({ force = false, includeSupabase = true } = {}) {
  const cooldownMs = Math.max(10000, Number(operationSyncConfig().operationSyncCooldownMs) || 60000);
  if (!force && Date.now() - lastOperationLoadAt < cooldownMs) return { accepted: [], rejected: [], skipped: true };
  if (!force && operationLoadPromise) return operationLoadPromise;
  const request = (async () => {
  const owner = configuredIdentity();
  const incoming = [];
  const wrappers = await queryAnchors("oplog", owner.vaultId, 100).catch(() => []);
  incoming.push(...wrappers.map((row) => row.payload).filter(Boolean));
  let remoteCursor = 0;
  if (includeSupabase && isProviderUp("supabase")) {
    const remote = await readSupabaseOperationDelta(owner.vaultId).catch(() => ({ operations: [], nextCursor: 0 }));
    incoming.push(...remote.operations);
    remoteCursor = remote.nextCursor;
  }
  const result = await ingestOperations(owner.vaultId, incoming, { ownerPublicKey: owner.ownerPublicKey });
  if (remoteCursor) writeOperationCursor(owner.vaultId, remoteCursor);
  lastOperationLoadAt = Date.now();
  return result;
  })();
  operationLoadPromise = request;
  try { return await request; }
  finally { if (operationLoadPromise === request) operationLoadPromise = null; }
}

export async function replayCatalogOperations() {
  const owner = configuredIdentity();
  if (!isProviderUp("supabase")) return 0;
  const { getOperationLog } = await import("../oplog/oplog-engine.js");
  const operations = await getOperationLog(owner.vaultId);
  let replayed = 0;
  for (const operation of operations) {
    const row = operation.payload?.row;
    try {
      if (operation.opType === "create_folder" && row?.id) {
        const { error } = await appTable("folders").upsert(row, { onConflict: "id", ignoreDuplicates: true });
        if (error) throw error;
        replayed += 1;
      } else if (operation.opType === "create_file" && row?.id) {
        const { error } = await appTable("files").upsert(row, { onConflict: "id", ignoreDuplicates: true });
        if (error) throw error;
        replayed += 1;
      } else if (operation.opType === "update_encrypted_metadata" && operation.payload?.fileId && operation.payload?.patch) {
        const { error } = await appTable("files").update(operation.payload.patch)
          .eq("vault_id", owner.vaultId).eq("id", operation.payload.fileId);
        if (error) throw error;
        replayed += 1;
      } else if (operation.opType === "delete_folder" && operation.payload?.folderId) {
        const ids = [...new Set([
          operation.payload.folderId,
          ...(operation.payload.descendantFolderIds || []),
        ].filter(Boolean))];
        const { error } = await appTable("folders").delete()
          .eq("vault_id", owner.vaultId).in("id", ids);
        if (error) throw error;
        replayed += 1;
      }
    } catch {}
  }
  return replayed;
}
