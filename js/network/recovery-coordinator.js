import { supabase, appTable } from "../services/supabase.js";
import { currentNode } from "./node-service.js";
import { getShard, deleteShard } from "../storage/fragment-store.js";
import { connectedProtocols } from "./peer-manager.js";
import { hashBytes } from "../security/keyring.js";
import { reconstructShards, encodeShards } from "../security/erasure.js";
import { recordShardPlacement, auditAllVersionResilience, queueShardRepair, refreshPhysicalStorageTotals } from "../services/segment-service.js";
import { upgradeOneCodingProfile, cleanupRetiredCodingGeneration } from "./profile-upgrade-coordinator.js";
import { createPlacementContext, rankPlacementCandidates } from "./placement-engine.js";
import { ACTIVE_PLACEMENT_STATUSES, planReplicaReconciliation } from "./shard-lifecycle.js";
import { retryPendingVaultDeletions } from "../services/deletion-service.js";

let timer = null;
let initialTimer = null;
async function recoveryCycle() { const node = currentNode(); await verifyPlacementSamples(); if (node?.vault_id) { await retryPendingVaultDeletions(node.vault_id, node.id, connectedProtocols()); await auditAllVersionResilience(node.vault_id); } await repairOnce(); await reconcileSurplusPlacements(); await cleanupRetiredCodingGeneration(); await upgradeOneCodingProfile(); window.dispatchEvent(new CustomEvent("meshvault:resilience-updated")); }
export function startRecoveryCoordinator(intervalMs = 15000, initialDelayMs = 15000) {
  stopRecoveryCoordinator();
  initialTimer = window.setTimeout(() => {
    initialTimer = null;
    recoveryCycle().catch(() => {});
    timer = window.setInterval(() => recoveryCycle().catch(() => {}), intervalMs);
  }, Math.max(0, initialDelayMs));
}
export function stopRecoveryCoordinator() {
  if (initialTimer) clearTimeout(initialTimer);
  if (timer) clearInterval(timer);
  initialTimer = null;
  timer = null;
}
async function requeue(jobId) {
  await appTable("repair_jobs").update({
    status: "queued", claimed_by_node_id: null, claimed_at: null,
    created_at: new Date().toISOString(),
  }).eq("id", jobId);
}
async function oldestPlacementForNode(nodeId, vaultId = null) {
  let query = appTable("shard_placements").select("id,vault_id,shard_id,node_id,status,last_proof_at,segment_shards(shard_hash)").eq("node_id", nodeId).in("status", ["stored", "verified", "suspect", "unavailable", "surplus"]).order("last_proof_at", { ascending: true, nullsFirst: true }).limit(1);
  if (vaultId) query = query.eq("vault_id", vaultId);
  const { data, error } = await query.maybeSingle(); if (error) return null; return data || null;
}
async function recordProof(placement, verified) {
  if (verified) {
    const base = { status: "verified", last_proof_at: new Date().toISOString() }; let values = { ...base, unavailable_since: null };
    const { data: node } = await appTable("nodes").select("country_code,region_code,network_domain_hash").eq("id", placement.node_id).maybeSingle();
    if (node) values = { ...base, country_code: node.country_code || null, region_code: node.region_code || null, network_domain_hash: node.network_domain_hash || null };
    let { error } = await appTable("shard_placements").update(values).eq("id", placement.id); if (error && /country_code|region_code|network_domain_hash|unavailable_since/i.test(`${error.message || ""} ${error.details || ""}`)) ({ error } = await appTable("shard_placements").update(base).eq("id", placement.id)); if (error) throw error; return true;
  }
  await appTable("shard_placements").update({ status: "unavailable" }).eq("id", placement.id);
  const shardHash = placement.segment_shards?.shard_hash;
  if (shardHash) { try { await appTable("fragment_location_cache").delete().eq("shard_hash", shardHash).eq("node_id", placement.node_id); } catch {} }
  await queueShardRepair(placement.vault_id, placement.shard_id).catch(() => {}); return false;
}
async function verifyLocalPlacement(node) {
  const placement = await oldestPlacementForNode(node.id); if (!placement) return null;
  const proofCutoff = Date.now() - (window.__DATA__?.resilience?.proofFreshMs || 1800000);
  if (!["suspect", "unavailable"].includes(placement.status) && new Date(placement.last_proof_at || 0).getTime() > proofCutoff) return null;
  const expectedHash = placement.segment_shards?.shard_hash; const bytes = expectedHash ? await getShard(expectedHash).catch(() => null) : null;
  return recordProof(placement, !!bytes && (await hashBytes(bytes)) === expectedHash);
}
async function verifyRemotePlacement(node) {
  if (!node.vault_id) return null;
  const proofCutoff = Date.now() - (window.__DATA__?.resilience?.proofFreshMs || 1800000);
  const peers = connectedProtocols(); const peerById = new Map(peers.map((peer) => [peer.nodeId, peer]));
  if (!peers.length) return null;
  const { data: placement, error } = await appTable("shard_placements")
    .select("id,vault_id,shard_id,node_id,status,last_proof_at,segment_shards(shard_hash)")
    .eq("vault_id", node.vault_id).in("node_id", peers.map((peer) => peer.nodeId))
    .in("status", ["stored", "verified", "suspect", "unavailable", "surplus"])
    .order("last_proof_at", { ascending: true, nullsFirst: true }).limit(1).maybeSingle();
  if (error || !placement) return null;
  if (!["suspect", "unavailable"].includes(placement.status) && new Date(placement.last_proof_at || 0).getTime() > proofCutoff) return null;
  const expectedHash = placement.segment_shards?.shard_hash; const peer = peerById.get(placement.node_id);
  if (!expectedHash || !peer) return null;
  let verified = await peer.protocol.requestProof(expectedHash, expectedHash);
  if (!verified) verified = await peer.protocol.requestProof(expectedHash, expectedHash);
  return recordProof(placement, verified);
}
export async function verifyPlacementSamples() { const node = currentNode(); if (!node || node.status !== "online") return []; return Promise.all([verifyLocalPlacement(node), verifyRemotePlacement(node)]); }

async function updatePlacementLifecycle(placementId, values, fallback = null) {
  let { error } = await appTable("shard_placements").update(values).eq("id", placementId);
  if (error && fallback) ({ error } = await appTable("shard_placements").update(fallback).eq("id", placementId));
  if (error) throw error;
}

async function hashHasOtherPlacementOnNode(vaultId, shardHash, nodeId, excludedPlacementId) {
  const { data, error } = await appTable("segment_shards").select("id,shard_placements(id,node_id,status)").eq("vault_id", vaultId).eq("shard_hash", shardHash);
  if (error) return true;
  return (data || []).some((shard) => (shard.shard_placements || []).some((placement) => placement.id !== excludedPlacementId && placement.node_id === nodeId && !["deleted", "deleting", "retiring"].includes(placement.status)));
}

export async function reconcileSurplusPlacements() {
  const node = currentNode(); if (!node?.vault_id) return 0;
  const cutoff = new Date(Date.now() - (window.__DATA__?.resilience?.nodeStaleMs || 120000)).toISOString();
  const { data: liveNodes, error: nodeError } = await appTable("nodes").select("id,reliability_score,status,last_seen_at").eq("status", "online").gte("last_seen_at", cutoff);
  if (nodeError) throw nodeError;
  const nodes = new Map((liveNodes || []).map((entry) => [entry.id, entry]));
  const { data: groups, error } = await appTable("content_segments").select("id,vault_id,coding_generation,segment_shards(id,coding_generation,shard_hash,shard_placements(*))").eq("vault_id", node.vault_id).eq("status", "ready").limit(12);
  if (error) throw error;
  const peers = connectedProtocols(); const peerById = new Map(peers.map((peer) => [peer.nodeId, peer])); let changed = 0;
  for (const group of groups || []) {
    const generation = Number(group.coding_generation || 1);
    const shards = (group.segment_shards || []).filter((shard) => Number(shard.coding_generation || 1) === generation).map((shard) => ({
      ...shard,
      shard_placements: (shard.shard_placements || []).map((placement) => ({ ...placement, node: nodes.get(placement.node_id) || null, live: nodes.has(placement.node_id) })),
    }));
    const actions = planReplicaReconciliation(shards, { surplusGraceMs: window.__DATA__?.resilience?.surplusGraceMs || 300000 });
    for (const action of actions) {
      if (action.type === "promote") {
        await updatePlacementLifecycle(action.placement.id, { status: "verified", retire_after: null, retire_reason: null }, { status: "verified" }); changed += 1; continue;
      }
      if (action.type === "mark-surplus") {
        await updatePlacementLifecycle(action.placement.id, { status: "surplus", retire_after: new Date(action.retireAt).toISOString(), retire_reason: "duplicate_after_repair" }, { status: "verified" }); changed += 1; continue;
      }
      const peer = peerById.get(action.placement.node_id);
      if (action.placement.node_id !== node.id && !peer) continue;
      const shardHash = shards.find((shard) => shard.id === action.shardId)?.shard_hash;
      await updatePlacementLifecycle(action.placement.id, { status: "retiring", retire_reason: "duplicate_after_repair" }, { status: "deleting" });
      const sharedLocally = await hashHasOtherPlacementOnNode(node.vault_id, shardHash, action.placement.node_id, action.placement.id);
      if (sharedLocally) {
        await appTable("shard_placements").update({ status: "deleted", deleted_at: new Date().toISOString() }).eq("id", action.placement.id);
      } else if (action.placement.node_id === node.id) {
        await deleteShard(shardHash).catch(() => {});
        await appTable("shard_placements").update({ status: "deleted", deleted_at: new Date().toISOString() }).eq("id", action.placement.id);
      } else {
        peer.protocol.requestDelete(shardHash);
      }
      changed += 1;
    }
    if (actions.length) await refreshPhysicalStorageTotals(node.vault_id, group.id).catch(() => {});
  }
  return changed;
}

export async function repairOnce() {
  const node = currentNode(); if (!node || node.status !== "online") return null;
  const { data, error } = await supabase.schema("app717_meshvault").rpc("claim_repair_job", { p_node_id: node.id }); if (error || !data?.length) return null; const job = data[0];
  const { data: shard, error: shardError } = await appTable("segment_shards").select("*,shard_placements(*)").eq("id", job.shard_id).single(); if (shardError) { await requeue(job.id); return job; }
  const { data: groupRow, error: groupError } = await appTable("content_segments").select("*,segment_shards(*,shard_placements(*))").eq("id", shard.content_segment_id).single(); if (groupError) { await requeue(job.id); return job; }
  if (groupRow.status === "deleting") { await appTable("repair_jobs").update({ status: "complete" }).eq("id", job.id); return job; }
  const generation = Number(shard.coding_generation || groupRow.coding_generation || 1);
  if (generation !== Number(groupRow.coding_generation || 1)) { await appTable("repair_jobs").update({ status: "complete" }).eq("id", job.id); return job; }
  const group = { ...groupRow, segment_shards: (groupRow.segment_shards || []).filter((entry) => Number(entry.coding_generation || 1) === generation) };
  let bytes = await getShard(shard.shard_hash);
  if (!bytes || (await hashBytes(bytes)) !== shard.shard_hash) {
    const segment = group;
    const available = []; const have = new Set(); const inspect = async () => { for (const candidate of segment.segment_shards || []) { if (have.has(candidate.shard_index)) continue; const local = await getShard(candidate.shard_hash); if (local && (await hashBytes(local)) === candidate.shard_hash) { available.push({ index: candidate.shard_index, bytes: local }); have.add(candidate.shard_index); } if (available.length >= Number(segment.required_shards)) break; } };
    await inspect(); if (available.length < Number(segment.required_shards)) { const requestPeers = connectedProtocols(); for (const candidate of segment.segment_shards || []) if (!have.has(candidate.shard_index)) requestPeers.forEach((peer) => peer.protocol.requestShard(candidate.shard_hash)); if (requestPeers.length) await new Promise((resolve) => setTimeout(resolve, 2500)); await inspect(); }
    if (available.length < Number(segment.required_shards)) { await requeue(job.id); return job; } const cipher = await reconstructShards(available, Number(segment.cipher_size_bytes), Number(segment.data_shards)); const layout = await encodeShards(cipher, Number(segment.data_shards), Number(segment.parity_shards)); bytes = new Uint8Array(layout.shards[Number(shard.shard_index)]); for (const item of available) { const candidate = (segment.segment_shards || []).find((entry) => entry.shard_index === item.index); const registered = (candidate?.shard_placements || []).some((placement) => placement.node_id === node.id && !["deleted", "deleting"].includes(placement.status)); if (!registered) await deleteShard(candidate.shard_hash).catch(() => {}); }
  }
  if ((await hashBytes(bytes)) !== shard.shard_hash) { await requeue(job.id); return job; }
  const peers = connectedProtocols(); const peerIds = peers.map((peer) => peer.nodeId); if (!peerIds.length) { await requeue(job.id); return job; }
  let { data: nodes, error: nodesError } = await appTable("nodes").select("id,vault_id,device_public_key,failure_domain_id,country_code,region_code,network_domain_hash,reliability_score,capacity_bytes,used_bytes,status").in("id", peerIds).eq("status", "online");
  if (nodesError && /country_code|region_code|network_domain_hash/i.test(`${nodesError.message || ""} ${nodesError.details || ""}`)) ({ data: nodes, error: nodesError } = await appTable("nodes").select("id,vault_id,device_public_key,failure_domain_id,reliability_score,capacity_bytes,used_bytes,status").in("id", peerIds).eq("status", "online"));
  if (nodesError) { await requeue(job.id); return job; }
  const existingPlacements = (group.segment_shards || []).flatMap((item) => item.shard_placements || []).filter((placement) => placement.role === "durable" && ACTIVE_PLACEMENT_STATUSES.includes(placement.status));
  const placementContext = createPlacementContext(existingPlacements);
  const ranked = rankPlacementCandidates((nodes || []).map((candidate) => ({ ...candidate, peer: peers.find((entry) => entry.nodeId === candidate.id) })), { context: placementContext, shardBytes: Number(shard.size_bytes || bytes.byteLength) });
  const target = ranked[0];
  const peer = peers.find((candidate) => candidate.nodeId === target?.id); if (!target || !peer) { await requeue(job.id); return job; }
  try {
    await peer.protocol.sendShard(shard.shard_hash, bytes, shard.shard_hash);
    const replaced = (shard.shard_placements || []).find((placement) => placement.role === "durable" && ["suspect", "unavailable"].includes(placement.status));
    await recordShardPlacement({ vaultId: job.vault_id, shardId: shard.id, node: target, role: "durable", replacementForPlacementId: replaced?.id || null });
    const localCache = (shard.shard_placements || []).find((placement) => placement.node_id === node.id && placement.role === "cache" && ["stored", "verified"].includes(placement.status));
    if (localCache) { await deleteShard(shard.shard_hash); await appTable("shard_placements").update({ status: "deleted", deleted_at: new Date().toISOString() }).eq("id", localCache.id); }
    await appTable("repair_jobs").update({ status: "complete", target_node_id: target.id }).eq("id", job.id);
    await refreshPhysicalStorageTotals(job.vault_id, shard.content_segment_id).catch(() => {});
    return job;
  } catch { await requeue(job.id); return job; }
}
