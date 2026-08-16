import { publishControlObject, queryAnchors, replicateOplogOperation } from "../network/anchor-service.js";
import { canonicalHashHex } from "../security/signing.js";
import {
  buildVaultIndexEnvelope, getLocalVaultIndex, newestVaultIndex,
  normalizeVaultIndexPayload, openVaultIndexEnvelope, saveLocalVaultIndex,
  verifyVaultIndexEnvelope,
} from "./vault-index.js";
import { appendOperation, getUnsyncedOperations, ingestOperations, markSyncReceipt } from "../oplog/oplog-engine.js";

const INDEX_TTL_MS = 30 * 86400000;
const DEFAULT_BACKBONE_DELAY_MS = 5 * 60 * 1000;

let identity = null;
let mutationChain = Promise.resolve();
let backboneTimer = null;
let operationLoadPromise = null;
let lastOperationLoadAt = 0;

function operationSyncConfig() { return window.__DATA__?.coordination || {}; }

function configuredIdentity() {
  if (!identity?.vaultId) throw new Error("The vault control repository is not configured.");
  return identity;
}

async function publishIndexToAnchors(envelope) {
  const object = await publishControlObject("vault-index", envelope.vaultId, envelope, INDEX_TTL_MS);
  return Number(object?.replicaCount || 0);
}

function scheduleBackboneFlush() {
  clearTimeout(backboneTimer);
  const delay = Number(window.__DATA__?.coordination?.operationBackboneFlushMs) || DEFAULT_BACKBONE_DELAY_MS;
  backboneTimer = window.setTimeout(() => {
    backboneTimer = null;
    // Retry mesh replicas only. Supabase is opened by the bounded cold-start
    // policy, never by an operation timer.
    flushControlPlane().catch(() => {});
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

export async function loadVaultCatalog({ includeSupabase = false, includeAnchors = false } = {}) {
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

  // Supabase is only a first-contact signaling gate. Vault indexes are
  // reconciled from signed local/peer copies and never from hosted tables.

  const newest = newestVaultIndex(candidates);
  if (!newest) return null;
  await saveLocalVaultIndex(newest);
  return openVaultIndexEnvelope(newest, owner);
}

export async function publishVaultCatalog(payload, { forceSupabase: _forceSupabase = false } = {}) {
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
  if (!anchorReplicas) {
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
  if (!["folders", "files", "segments", "versionSegments", "tombstones", "repairState"].includes(section)) throw new Error("Unknown vault-index section.");
  return mutateCatalog((payload) => { payload[section] = Array.isArray(rows) ? structuredClone(rows) : []; });
}

export function upsertCatalogRow(section, row) {
  if (!["folders", "files", "segments", "versionSegments", "tombstones", "repairState"].includes(section) || !row?.id) return Promise.resolve(null);
  return mutateCatalog((payload) => {
    payload[section] = [structuredClone(row), ...payload[section].filter((entry) => entry.id !== row.id)];
  });
}

export function removeCatalogRow(section, id) {
  if (!["folders", "files", "segments", "versionSegments", "tombstones", "repairState"].includes(section) || !id) return Promise.resolve(null);
  return mutateCatalog((payload) => { payload[section] = payload[section].filter((entry) => entry.id !== id); });
}

export async function appendCatalogOperation(opType, payload) {
  const owner = configuredIdentity();
  const signer = { publicKey: owner.ownerPublicKey, algorithm: owner.algorithm, sign: owner.sign };
  return appendOperation(signer, owner.vaultId, opType, payload);
}

function portableOperation(operation) {
  const { synced, syncReceipts, syncAttempts, nextSyncAt, lastSyncError, ...envelope } = operation;
  return envelope;
}

export async function replicateOperation(operation, { forceBackbone: _forceBackbone = false } = {}) {
  let anchorReplicas = 0;
  try {
    anchorReplicas = await replicateOplogOperation(portableOperation(operation));
    if (anchorReplicas > 0) await markSyncReceipt(operation.opId, "anchor", { replicas: anchorReplicas });
  } catch {}
  if (!anchorReplicas) scheduleBackboneFlush();
  // The signed local operation is durable in this device even while no mesh
  // replica is reachable. It remains pending and is retried when a peer opens.
  return true;
}

export async function flushControlPlane({ forceBackbone = false } = {}) {
  const owner = configuredIdentity();
  const pending = await getUnsyncedOperations(owner.vaultId);
  for (const operation of pending) await replicateOperation(operation).catch(() => {});
  return pending.length;
}

export async function loadReplicatedOperations({ force = false, includeSupabase = false } = {}) {
  const cooldownMs = Math.max(10000, Number(operationSyncConfig().operationSyncCooldownMs) || 60000);
  if (!force && Date.now() - lastOperationLoadAt < cooldownMs) return { accepted: [], rejected: [], skipped: true };
  if (!force && operationLoadPromise) return operationLoadPromise;
  const request = (async () => {
  const owner = configuredIdentity();
  const incoming = [];
  const wrappers = await queryAnchors("oplog", owner.vaultId, 100).catch(() => []);
  incoming.push(...wrappers.map((row) => row.payload).filter(Boolean));
  const result = await ingestOperations(owner.vaultId, incoming, { ownerPublicKey: owner.ownerPublicKey });
  lastOperationLoadAt = Date.now();
  return result;
  })();
  operationLoadPromise = request;
  try { return await request; }
  finally { if (operationLoadPromise === request) operationLoadPromise = null; }
}

export async function replayCatalogOperations() {
  return 0;
}
