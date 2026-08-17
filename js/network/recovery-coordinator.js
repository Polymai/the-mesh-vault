import { currentNode } from "./node-service.js";
import { getShard, putShard } from "../storage/fragment-store.js";
import { connectedProtocols } from "./peer-manager.js";
import { findFragment } from "./fragment-discovery.js";
import { hashBytes } from "../security/keyring.js";
import { reconstructShards, encodeShards } from "../security/erasure.js";
import {
  auditAllVersionResilience, currentGenerationShards, listContentSegments,
  listShardRepairs, loadPlacementCandidates, queueShardRepair,
  recordShardPlacement, refreshPhysicalStorageTotals, transitionShardPlacement,
  updateShardRepair,
} from "../services/segment-service.js";
import { ACTIVE_PLACEMENT_STATUSES, planReplicaReconciliation } from "./shard-lifecycle.js";
import { acknowledgeLifecycleShardDeletion, retryPendingVaultDeletions } from "../services/deletion-service.js";
import { claimDistributedRepairLease, listRepairAdvisories, publishRepairCompletion } from "./distributed-repair.js";

const DEFAULT_MAINTENANCE_MS = 15 * 60 * 1000;
const DEFAULT_EVENT_DELAY_MS = 5000;
const MINIMUM_CYCLE_GAP_MS = 30000;
let timer = null;
let eventTimer = null;
let running = false;
let lastCycleAt = 0;
let shouldRun = () => true;
let listenersAttached = false;

function scheduleMaintenance(maintenanceMs) {
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(async () => {
    timer = null;
    await runRecoveryCycle("maintenance").catch(() => {});
    scheduleMaintenance(maintenanceMs);
  }, maintenanceMs);
}
function eventReason(event) {
  if (event?.type === "meshvault:peer-state" && event.detail?.status !== "connected") return null;
  if (event?.type === "meshvault:repair-advisory") return "repair-advisory";
  if (event?.type === "meshvault:repair-needed") return "repair-needed";
  if (event?.type === "online") return "online";
  return "peer-connected";
}
function onRecoverySignal(event) { const reason = eventReason(event); if (reason) requestRecoveryCycle(reason); }
function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener("meshvault:repair-needed", onRecoverySignal);
  window.addEventListener("meshvault:repair-advisory", onRecoverySignal);
  window.addEventListener("meshvault:peer-state", onRecoverySignal);
  window.addEventListener("online", onRecoverySignal);
}
function detachListeners() {
  if (!listenersAttached) return;
  listenersAttached = false;
  window.removeEventListener("meshvault:repair-needed", onRecoverySignal);
  window.removeEventListener("meshvault:repair-advisory", onRecoverySignal);
  window.removeEventListener("meshvault:peer-state", onRecoverySignal);
  window.removeEventListener("online", onRecoverySignal);
}

async function syncRepairAdvisories(node) {
  const rows = await listRepairAdvisories(node.vault_id, 20);
  let queued = 0;
  for (const request of rows) {
    const lease = await claimDistributedRepairLease(request, node.id).catch(() => ({ acquired: false }));
    if (!lease.acquired) continue;
    const job = await queueShardRepair(request.vaultId, request.shardId, request.targetNodeId || null, { announce: false, requestId: request.requestId }).catch(() => null);
    if (job) queued += 1;
  }
  return queued;
}
function findShardRecord(segments, shardId) {
  for (const segment of segments) {
    const shard = currentGenerationShards(segment).find((entry) => entry.id === shardId);
    if (shard) return { segment, shard };
  }
  return null;
}
async function verifyPlacement(placement, shardHash, localNodeId, peerById) {
  let verified = false;
  if (placement.node_id === localNodeId) {
    const bytes = await getShard(shardHash).catch(() => null);
    verified = !!bytes && (await hashBytes(bytes)) === shardHash;
  } else {
    const peer = peerById.get(placement.node_id);
    if (!peer?.protocol) return null;
    verified = await peer.protocol.requestProof(shardHash, shardHash).catch(() => false);
  }
  await transitionShardPlacement(placement.vault_id, placement.id, verified ? "verified" : "unavailable");
  if (!verified) await queueShardRepair(placement.vault_id, placement.shard_id).catch(() => {});
  return verified;
}
export async function verifyPlacementSamples() {
  const node = currentNode();
  if (!node?.vault_id || node.status !== "online") return [];
  const peers = connectedProtocols();
  const peerById = new Map(peers.map((peer) => [peer.nodeId, peer]));
  const reachableIds = new Set([node.id, ...peerById.keys()]);
  const cutoff = Date.now() - Number(window.__DATA__?.resilience?.proofFreshMs || 1800000);
  const candidates = [];
  for (const segment of await listContentSegments(node.vault_id)) for (const shard of currentGenerationShards(segment)) {
    for (const placement of shard.shard_placements || []) {
      if (!reachableIds.has(placement.node_id)) continue;
      if (!["suspect", "unavailable"].includes(placement.status) && Date.parse(placement.last_proof_at || 0) > cutoff) continue;
      candidates.push({ placement: { ...placement, vault_id: segment.vault_id, shard_id: shard.id }, shardHash: shard.shard_hash });
    }
  }
  const local = candidates.find((entry) => entry.placement.node_id === node.id);
  const remote = candidates.find((entry) => entry.placement.node_id !== node.id);
  return Promise.all([local, remote].filter(Boolean).map((entry) => verifyPlacement(entry.placement, entry.shardHash, node.id, peerById)));
}

async function collectRecoveryShards(segment, peers) {
  const available = [];
  for (const candidate of currentGenerationShards(segment)) {
    const found = await findFragment(candidate.shard_hash, { connectedPeers: peers }).catch(() => ({ bytes: null }));
    if (found.bytes && (await hashBytes(found.bytes)) === candidate.shard_hash) {
      available.push({ index: Number(candidate.shard_index), bytes: found.bytes });
      if (available.length >= Number(segment.required_shards)) break;
    }
  }
  return available;
}
export async function repairOnce() {
  const node = currentNode();
  if (!node?.vault_id || node.status !== "online") return null;
  const jobs = (await listShardRepairs(node.vault_id)).filter((job) => ["queued", "announced", "claimed"].includes(job.status)).sort((a, b) => Date.parse(a.requested_at || 0) - Date.parse(b.requested_at || 0));
  const job = jobs[0];
  if (!job) return null;
  const target = findShardRecord(await listContentSegments(node.vault_id), job.shard_id);
  if (!target || target.segment.status === "deleting") {
    await updateShardRepair(node.vault_id, job.id, { status: "complete" });
    return job;
  }
  await updateShardRepair(node.vault_id, job.id, { status: "claimed", claimed_by_node_id: node.id });
  const peers = connectedProtocols();
  const available = await collectRecoveryShards(target.segment, peers);
  if (available.length < Number(target.segment.required_shards)) {
    await updateShardRepair(node.vault_id, job.id, { status: "announced" });
    return job;
  }
  const cipher = await reconstructShards(available, Number(target.segment.cipher_size_bytes), Number(target.segment.data_shards));
  const layout = await encodeShards(cipher, Number(target.segment.data_shards), Number(target.segment.parity_shards));
  const bytes = new Uint8Array(layout.shards[Number(target.shard.shard_index)]);
  if ((await hashBytes(bytes)) !== target.shard.shard_hash) {
    await updateShardRepair(node.vault_id, job.id, { status: "announced" });
    return job;
  }
  const existingDomains = new Set(currentGenerationShards(target.segment).flatMap((shard) => shard.shard_placements || []).filter((placement) => placement.role === "durable" && ACTIVE_PLACEMENT_STATUSES.includes(placement.status)).map((placement) => placement.failure_domain_id || placement.node_id));
  const candidates = (await loadPlacementCandidates(node, peers)).filter((candidate) => !existingDomains.has(candidate.failure_domain_id || candidate.id));
  const destination = candidates.sort((a, b) => Number(b.reliability_score || 0) - Number(a.reliability_score || 0) || Number(b.freeBytes || 0) - Number(a.freeBytes || 0))[0];
  if (!destination) {
    await updateShardRepair(node.vault_id, job.id, { status: "announced" });
    return job;
  }
  const replaced = (target.shard.shard_placements || []).find((placement) => ["suspect", "unavailable"].includes(placement.status));
  let reservation = await recordShardPlacement({ vaultId: node.vault_id, shardId: target.shard.id, node: destination, role: "durable", replacementForPlacementId: replaced?.id || null, status: "pending" });
  try {
    if (destination.isLocal) await putShard(target.shard.shard_hash, bytes, target.shard.shard_hash);
    else await destination.peer.protocol.sendShard(target.shard.shard_hash, bytes, target.shard.shard_hash);
    reservation = await transitionShardPlacement(node.vault_id, reservation.id, "verified");
    await updateShardRepair(node.vault_id, job.id, { status: "complete", target_node_id: destination.id });
    await publishRepairCompletion({ requestId: job.id, vaultId: node.vault_id, shardId: target.shard.id }, node.id, destination.id).catch(() => {});
    await refreshPhysicalStorageTotals(node.vault_id, target.segment.id).catch(() => {});
  } catch {
    await transitionShardPlacement(node.vault_id, reservation.id, "deleting").catch(() => {});
    await updateShardRepair(node.vault_id, job.id, { status: "announced" });
  }
  return job;
}

export async function reconcileSurplusPlacements() {
  const node = currentNode();
  if (!node?.vault_id) return 0;
  const peerById = new Map(connectedProtocols().map((peer) => [peer.nodeId, peer]));
  let changed = 0;
  for (const segment of await listContentSegments(node.vault_id)) {
    const actions = planReplicaReconciliation(currentGenerationShards(segment), { surplusGraceMs: window.__DATA__?.resilience?.surplusGraceMs || 300000 });
    for (const action of actions) {
      if (action.type === "promote") { await transitionShardPlacement(node.vault_id, action.placement.id, "verified"); changed += 1; continue; }
      if (action.type === "mark-surplus") { await transitionShardPlacement(node.vault_id, action.placement.id, "surplus"); changed += 1; continue; }
      const shard = currentGenerationShards(segment).find((entry) => entry.id === action.shardId);
      if (!shard) continue;
      await transitionShardPlacement(node.vault_id, action.placement.id, "retiring");
      if (action.placement.node_id === node.id) await acknowledgeLifecycleShardDeletion(node.id, shard.shard_hash).catch(() => false);
      else {
        const protocol = peerById.get(action.placement.node_id)?.protocol;
        if (protocol) await protocol.requestDelete(shard.shard_hash).catch(() => false);
      }
      changed += 1;
    }
    if (actions.length) await refreshPhysicalStorageTotals(node.vault_id, segment.id).catch(() => {});
  }
  return changed;
}

async function recoveryCycle(reason = "maintenance") {
  const node = currentNode();
  if (!node?.vault_id) return false;
  const fullMaintenance = ["maintenance", "peer-connected", "online", "file-changed"].includes(reason);
  let changed = false;
  if (fullMaintenance) changed = (await verifyPlacementSamples()).some((result) => result !== null) || changed;
  if (reason === "repair-advisory" || fullMaintenance) changed = (await syncRepairAdvisories(node)) > 0 || changed;
  if (["deletion-changed", "maintenance", "peer-connected", "online"].includes(reason)) changed = !!(await retryPendingVaultDeletions(node.vault_id, node.id, connectedProtocols())) || changed;
  if (fullMaintenance || ["repair-needed", "repair-advisory"].includes(reason)) { await auditAllVersionResilience(node.vault_id); changed = !!(await repairOnce()) || changed; }
  if (["maintenance", "peer-connected", "online", "file-changed", "deletion-changed"].includes(reason)) changed = (await reconcileSurplusPlacements()) > 0 || changed;
  if (changed) window.dispatchEvent(new CustomEvent("meshvault:resilience-updated"));
  return true;
}
async function runRecoveryCycle(reason) {
  if (running || !shouldRun(reason)) return false;
  const waitMs = MINIMUM_CYCLE_GAP_MS - (Date.now() - lastCycleAt);
  if (waitMs > 0) { requestRecoveryCycle(reason, waitMs); return false; }
  running = true;
  try { const completed = await recoveryCycle(reason); if (completed) lastCycleAt = Date.now(); return completed; }
  finally { running = false; }
}
export function requestRecoveryCycle(reason = "repair-needed", delayMs = DEFAULT_EVENT_DELAY_MS) {
  if (!shouldRun(reason)) return false;
  if (eventTimer) clearTimeout(eventTimer);
  eventTimer = window.setTimeout(() => { eventTimer = null; runRecoveryCycle(reason).catch(() => {}); }, Math.max(0, Number(delayMs) || 0));
  return true;
}
export function startRecoveryCoordinator(options = {}) {
  stopRecoveryCoordinator();
  const maintenanceMs = Math.max(60000, Number(options.maintenanceMs || window.__DATA__?.resilience?.maintenanceCycleMs || DEFAULT_MAINTENANCE_MS));
  shouldRun = typeof options.shouldRun === "function" ? options.shouldRun : () => true;
  attachListeners(); scheduleMaintenance(maintenanceMs);
  if (options.runWhenReady) requestRecoveryCycle("peer-connected", options.initialDelayMs || DEFAULT_EVENT_DELAY_MS);
}
export function stopRecoveryCoordinator() {
  if (timer) clearTimeout(timer);
  if (eventTimer) clearTimeout(eventTimer);
  timer = null; eventTimer = null; running = false; shouldRun = () => true; detachListeners();
}
