import { appTable } from "../services/supabase.js";
import {
  chooseErasureProfile, loadPlacementCandidates, normalizeSegmentGeneration, claimSegmentProfileUpgrade,
  releaseSegmentProfileUpgrade, finishSegmentProfileUpgrade, registerSegmentShards, recordShardPlacement, queueShardRepair,
  refreshPhysicalStorageTotals, loadFilePlacementStateForSegment,
} from "../services/segment-service.js";
import { currentVaultIdentity } from "../identity/vault-identity.js";
import { currentNode } from "./node-service.js";
import { connectedProtocols } from "./peer-manager.js";
import { getShard, putShard, deleteShard } from "../storage/fragment-store.js";
import { findFragment } from "./fragment-discovery.js";
import { reconstructShards, encodeShards } from "../security/erasure.js";
import { hashBytes } from "../security/keyring.js";
import { buildManifestV2, verifyManifestV2 } from "../security/manifest.js";
import { getLocalManifest, saveManifestLocally } from "./manifest-discovery.js";
import { lookupManifest, announceManifest } from "./providers/provider-registry.js";
import { appendOperation } from "../oplog/oplog-engine.js";
import { OP_TYPES } from "../oplog/operation-types.js";
import {
  createFilePlacementContext,
  createPlacementContext,
  rankPlacementCandidates,
  recordFilePlacementChoice,
  recordPlacementChoice,
  releasePlacementChoice,
} from "./placement-engine.js";
import { getErasureClass } from "../services/vault-service.js";
import { runConcurrent, withRetry } from "../ui/task-state.js";

let running = false;
let nextAttemptAt = 0;
const RETRY_DELAY_MS = 60_000;

function signerFor(identity) { return { publicKey: identity.ownerPublicKey, algorithm: identity.algorithm, sign: identity.sign }; }
async function storeLocalVerified(shardHash, bytes) {
  await putShard(shardHash, bytes);
  const stored = await getShard(shardHash);
  if (!stored || (await hashBytes(stored)) !== shardHash) { await deleteShard(shardHash).catch(() => {}); throw new Error("Local profile-upgrade shard verification failed."); }
}

async function verifiedManifest(manifestId, vaultId, ownerPublicKey) {
  const envelope = await getLocalManifest(manifestId).catch(() => null) || await lookupManifest(manifestId).catch(() => null);
  if (!envelope || envelope.vaultId !== vaultId || envelope.ownerPublicKey !== ownerPublicKey) return null;
  const result = await verifyManifestV2(envelope, { supportedManifestVersions: [2], supportedStorageVersions: [1, 2] });
  return result.valid ? envelope : null;
}

async function referencingVersions(segment, identity) {
  const { data: links, error: linksError } = await appTable("version_segments").select("file_version_id").eq("vault_id", identity.vaultId).eq("content_segment_id", segment.id);
  if (linksError) throw linksError;
  const versionIds = Array.from(new Set((links || []).map((link) => link.file_version_id)));
  if (!versionIds.length) return [];
  const { data: versions, error } = await appTable("file_versions").select("*").eq("vault_id", identity.vaultId).in("id", versionIds);
  if (error) throw error;
  const bundles = [];
  for (const version of versions || []) {
    const manifest = await verifiedManifest(version.manifest_id, identity.vaultId, identity.ownerPublicKey);
    if (!manifest) throw new Error("A current signed manifest was unavailable; profile upgrade postponed.");
    if (!manifest.segments.some((entry) => entry.segmentId === segment.id)) throw new Error("The current manifest does not reference the segment being upgraded.");
    bundles.push({ version, manifest });
  }
  const oldManifestIds = bundles.map((bundle) => bundle.manifest.manifestId);
  if (oldManifestIds.length) {
    const { data: activeCapabilities, error: capabilityError } = await appTable("capability_links").select("capability_id").in("manifest_id", oldManifestIds).eq("revoked", false).gt("expires_at", new Date().toISOString()).limit(1);
    if (capabilityError) throw capabilityError;
    if (activeCapabilities?.length) throw new Error("An active share link still references this coding generation; profile upgrade postponed.");
  }
  return bundles;
}

async function acquireCipher(segment, peers) {
  const available = [];
  for (const shard of segment.segment_shards || []) {
    let bytes = await getShard(shard.shard_hash).catch(() => null);
    if (!bytes) ({ bytes } = await findFragment(shard.shard_hash, { connectedPeers: peers }));
    if (bytes && (await hashBytes(bytes)) === shard.shard_hash) available.push({ index: Number(shard.shard_index), bytes });
    if (available.length >= Number(segment.required_shards)) break;
  }
  if (available.length < Number(segment.required_shards)) throw new Error(`Only ${available.length} of ${segment.required_shards} shards were reachable for profile upgrade.`);
  const cipher = await reconstructShards(available, Number(segment.cipher_size_bytes), Number(segment.data_shards));
  if ((await hashBytes(cipher)) !== segment.cipher_hash) throw new Error("Reconstructed ciphertext failed verification before profile upgrade.");
  return cipher;
}

async function placeGeneration({ identity, node, peers, candidates, segment, generation, profile, cipher, filePlacementContext, placementScope }) {
  const layout = await encodeShards(cipher, profile.dataShards, profile.parityShards);
  const payloads = await Promise.all(layout.shards.map(async (bytes) => ({ bytes: new Uint8Array(bytes), hash: await hashBytes(bytes) })));
  const shardRows = await registerSegmentShards(identity.vaultId, segment.id, payloads, generation);
  const placements = [];
  const placementContext = createPlacementContext();
  const transfer = window.__DATA__?.transport || {};
  let physicalBytes = 0;
  await runConcurrent(shardRows, Math.max(1, Math.min(3, Number(transfer.uploadShardConcurrency) || 3)), async (shard, index, signal) => {
    const payload = payloads[index]; let target = null; let role = "cache"; let stored = false;
    const placementKey = `${placementScope}:${segment.id}:${generation}:${shard.shard_index}`;
    const attemptedCandidateIds = new Set();
    while (!stored) {
      const candidate = rankPlacementCandidates(candidates, {
        context: placementContext,
        fileContext: filePlacementContext,
        placementKey,
        shardBytes: payload.bytes.byteLength,
      }).find((entry) => !attemptedCandidateIds.has(entry.id));
      if (!candidate) break;
      attemptedCandidateIds.add(candidate.id);
      recordPlacementChoice(placementContext, candidate);
      try {
        await withRetry(async (_attempt, attemptSignal) => {
          if (candidate.isLocal) await storeLocalVerified(shard.shard_hash, payload.bytes);
          else await candidate.peer.protocol.sendShard(shard.shard_hash, payload.bytes, payload.hash, undefined, { signal: attemptSignal });
        }, {
          retries: Number(transfer.retryAttempts) || 2,
          baseDelayMs: Number(transfer.retryBaseDelayMs) || 500,
          timeoutMs: Number(transfer.uploadAttemptTimeoutMs) || 50000,
          signal,
        });
        target = candidate; stored = true; role = "durable";
        recordFilePlacementChoice(filePlacementContext, candidate, payload.bytes.byteLength, `${segment.id}:${shard.id}:${candidate.id}`);
      } catch (error) {
        releasePlacementChoice(placementContext, candidate);
        if (signal.aborted || error?.name === "AbortError") throw error;
      }
    }
    if (!stored) {
      await storeLocalVerified(shard.shard_hash, payload.bytes); target = node;
      role = placementContext.domains.has(node.failure_domain_id || node.id) ? "cache" : "durable";
      if (role === "durable") { recordPlacementChoice(placementContext, node); recordFilePlacementChoice(filePlacementContext, node, payload.bytes.byteLength, `${segment.id}:${shard.id}:${node.id}`); }
      await queueShardRepair(identity.vaultId, shard.id).catch(() => {});
    }
    placements.push(await recordShardPlacement({ vaultId: identity.vaultId, shardId: shard.id, node: target, role }));
    physicalBytes += payload.bytes.byteLength;
  });
  return { shardRows, payloads, placements, physicalBytes };
}

function upgradedManifestSegment(oldEntry, segment, generation, profile, placed) {
  const erasureCoding = {
    algorithm: profile.algorithm || "reed-solomon",
    profileVersion: Number(profile.profileVersion || 2),
    dataShards: profile.dataShards,
    parityShards: profile.parityShards,
    requiredShards: profile.requiredShards,
    repairThreshold: profile.repairThreshold,
    totalShards: profile.totalShards,
  };
  return {
    ...oldEntry, codingGeneration: generation, dataShards: profile.dataShards, parityShards: profile.parityShards,
    requiredShards: profile.requiredShards, repairThreshold: profile.repairThreshold, totalShards: profile.totalShards,
    codingProfileVersion: erasureCoding.profileVersion, erasureCoding,
    shardHashes: placed.shardRows.map((shard) => shard.shard_hash),
    placements: placed.shardRows.flatMap((shard) => placed.placements.filter((placement) => placement.shard_id === shard.id && placement.role === "durable").map((placement) => ({ shardIndex: shard.shard_index, nodeId: placement.node_id, failureDomain: placement.failure_domain_id }))),
  };
}

async function publishUpgradedManifests(identity, bundles, segment, generation, profile, placed) {
  const signer = signerFor(identity);
  const published = [];
  for (const { version, manifest } of bundles) {
    const segments = manifest.segments.map((entry) => entry.segmentId === segment.id ? upgradedManifestSegment(entry, segment, generation, profile, placed) : entry);
    const envelope = await buildManifestV2({ storageProtocolVersion: 2, vaultId: identity.vaultId, fileVersionId: version.id, originalHash: manifest.originalHash, originalSize: manifest.originalSize, segmentCount: manifest.segmentCount, boundaryMethod: manifest.boundaryMethod, segments }, signer);
    await saveManifestLocally(envelope);
    await announceManifest(envelope);
    await appendOperation(signer, identity.vaultId, OP_TYPES.PUBLISH_MANIFEST, { fileId: version.file_id, fileVersionId: version.id, manifestId: envelope.manifestId, manifestHash: envelope.manifestHash });
    const minimum = Math.max(...segments.map((entry) => Number(entry.requiredShards || 0)));
    const total = Math.max(...segments.map((entry) => Number(entry.totalShards || 0)));
    const repairThreshold = Math.max(...segments.map((entry) => Number(entry.repairThreshold || entry.requiredShards || 0)));
    const { error } = await appTable("file_versions").update({ manifest_id: envelope.manifestId, format_version: 2, minimum_required_shards: minimum, repair_threshold_shards: repairThreshold, total_shards: total, recovery_status: "distributing", physical_storage_bytes: Number(version.physical_storage_bytes || 0) + placed.physicalBytes }).eq("vault_id", identity.vaultId).eq("id", version.id);
    if (error) throw error;
    await appTable("files").update({ status: "distributing" }).eq("vault_id", identity.vaultId).eq("id", version.file_id);
    peersReplicate(envelope, connectedProtocols());
    published.push(envelope);
  }
  return published;
}

function peersReplicate(envelope, peers) { peers.slice(0, 3).forEach((peer) => peer.protocol.sendManifest(envelope.manifestId, envelope).catch(() => {})); }

async function shardHashCanBeRemoved(vaultId, shardHash, retiredShardId) {
  const { data } = await appTable("segment_shards").select("id").eq("vault_id", vaultId).eq("shard_hash", shardHash).neq("id", retiredShardId).in("status", ["pending", "verified"]).limit(1);
  return !data?.length;
}

async function retireOldGeneration(identity, node, peers, segment) {
  for (const shard of segment.segment_shards || []) {
    const removable = await shardHashCanBeRemoved(identity.vaultId, shard.shard_hash, shard.id);
    const localPlacement = (shard.shard_placements || []).find((placement) => placement.node_id === node.id && !["deleted", "deleting"].includes(placement.status));
    if (localPlacement) {
      if (removable) await deleteShard(shard.shard_hash).catch(() => {});
      await appTable("shard_placements").update({ status: "deleted", deleted_at: new Date().toISOString() }).eq("id", localPlacement.id);
    }
    for (const placement of shard.shard_placements || []) {
      if (placement.node_id === node.id || ["deleted", "deleting"].includes(placement.status)) continue;
      const peer = peers.find((entry) => entry.nodeId === placement.node_id);
      if (removable && peer) peer.protocol.requestDelete(shard.shard_hash);
      await appTable("shard_placements").update({ status: removable ? "deleting" : "deleted", deleted_at: removable ? null : new Date().toISOString() }).eq("id", placement.id);
    }
    await appTable("segment_shards").update({ status: "deleting" }).eq("id", shard.id);
  }
}

export async function cleanupRetiredCodingGeneration() {
  const identity = currentVaultIdentity(); const node = currentNode(); if (!identity || !node) return 0;
  const peers = connectedProtocols();
  const { data: rows, error } = await appTable("segment_shards").select("*,shard_placements(*)").eq("vault_id", identity.vaultId).eq("status", "deleting").limit(20);
  if (error) throw error;
  let removed = 0;
  for (const shard of rows || []) {
    const removable = await shardHashCanBeRemoved(identity.vaultId, shard.shard_hash, shard.id);
    for (const placement of shard.shard_placements || []) {
      if (["deleted"].includes(placement.status)) continue;
      if (placement.node_id === node.id) {
        if (removable) await deleteShard(shard.shard_hash).catch(() => {});
        await appTable("shard_placements").update({ status: "deleted", deleted_at: new Date().toISOString() }).eq("id", placement.id);
      } else {
        const peer = peers.find((entry) => entry.nodeId === placement.node_id);
        if (removable && peer) peer.protocol.requestDelete(shard.shard_hash);
      }
    }
    const allDeleted = (shard.shard_placements || []).every((placement) => placement.status === "deleted" || (!removable && placement.status === "deleting"));
    if (!allDeleted) continue;
    const { data: segment } = await appTable("content_segments").select("physical_storage_bytes").eq("vault_id", identity.vaultId).eq("id", shard.content_segment_id).single();
    if (segment) await appTable("content_segments").update({ physical_storage_bytes: Math.max(0, Number(segment.physical_storage_bytes || 0) - Number(shard.size_bytes || 0)) }).eq("id", shard.content_segment_id);
    const { data: links } = await appTable("version_segments").select("file_version_id").eq("vault_id", identity.vaultId).eq("content_segment_id", shard.content_segment_id);
    const versionIds = Array.from(new Set((links || []).map((link) => link.file_version_id)));
    if (versionIds.length) {
      const { data: versions } = await appTable("file_versions").select("id,physical_storage_bytes").eq("vault_id", identity.vaultId).in("id", versionIds);
      for (const version of versions || []) await appTable("file_versions").update({ physical_storage_bytes: Math.max(0, Number(version.physical_storage_bytes || 0) - Number(shard.size_bytes || 0)) }).eq("id", version.id);
    }
    await appTable("segment_shards").delete().eq("id", shard.id); removed += 1;
  }
  return removed;
}

async function cleanupFailedGeneration(identity, placed) {
  if (!placed) return;
  for (const shard of placed.shardRows || []) {
    await deleteShard(shard.shard_hash).catch(() => {});
    connectedProtocols().forEach((peer) => peer.protocol.requestDelete(shard.shard_hash));
  }
  const ids = (placed.shardRows || []).map((shard) => shard.id);
  if (ids.length) { try { await appTable("segment_shards").delete().eq("vault_id", identity.vaultId).in("id", ids); } catch {} }
}

export async function upgradeOneCodingProfile() {
  if (running || Date.now() < nextAttemptAt) return null;
  const identity = currentVaultIdentity(); const node = currentNode(); const peers = connectedProtocols();
  if (!identity || !node || node.status !== "online") return null;
  await appTable("content_segments").update({ status: "ready" }).eq("vault_id", identity.vaultId).eq("status", "rebalancing").lt("updated_at", new Date(Date.now() - 10 * 60_000).toISOString());
  const candidates = await loadPlacementCandidates(node, peers);
  const profile = chooseErasureProfile(candidates.length, await getErasureClass());
  if (!profile.placementReady) return null;
  const { data: candidatesForUpgrade, error } = await appTable("content_segments").select("*,segment_shards(*,shard_placements(*))").eq("vault_id", identity.vaultId).eq("status", "ready").order("created_at").limit(20);
  if (error) throw error;
  const segment = normalizeSegmentGeneration((candidatesForUpgrade || []).find((entry) => Number(entry.total_shards) < profile.totalShards || (Number(entry.total_shards) === profile.totalShards && (Number(entry.data_shards) !== profile.dataShards || Number(entry.parity_shards) !== profile.parityShards || Number(entry.repair_threshold || 0) !== profile.repairThreshold))));
  if (!segment) return null;
  running = true; let claimed = false; let placed = null; let transferId = null; let committed = false;
  try {
    const claim = await claimSegmentProfileUpgrade(identity.vaultId, segment.id, segment.coding_generation); if (!claim) return null; claimed = true;
    const bundles = await referencingVersions(segment, identity);
    const { data: transfer } = await appTable("transfers").insert({ vault_id: identity.vaultId, direction: "rebalance", status: "running", bytes_total: Number(segment.cipher_size_bytes) }).select().single(); transferId = transfer?.id || null;
    const cipher = await acquireCipher(segment, peers);
    const generation = Number(segment.coding_generation || 1) + 1;
    const filePlacementState = await loadFilePlacementStateForSegment(identity.vaultId, segment.id);
    const expectedPlacements = Math.max(0, Number(filePlacementState.expectedPlacements || 0) - Number(segment.total_shards || 0) + profile.totalShards);
    const filePlacementContext = createFilePlacementContext(filePlacementState.placements, { expectedPlacements, candidateCount: candidates.length });
    placed = await placeGeneration({ identity, node, peers, candidates, segment, generation, profile, cipher, filePlacementContext, placementScope: filePlacementState.placementScope });
    await publishUpgradedManifests(identity, bundles, segment, generation, profile, placed);
    await finishSegmentProfileUpgrade(identity.vaultId, segment.id, { format_version: 2, coding_generation: generation, data_shards: profile.dataShards, parity_shards: profile.parityShards, required_shards: profile.requiredShards, repair_threshold: profile.repairThreshold, total_shards: profile.totalShards, physical_storage_bytes: Number(segment.physical_storage_bytes || 0) + placed.physicalBytes });
    committed = true;
    await retireOldGeneration(identity, node, peers, segment).catch(() => {});
    await refreshPhysicalStorageTotals(identity.vaultId, segment.id).catch(() => {});
    const oldShardIds = (segment.segment_shards || []).map((shard) => shard.id); if (oldShardIds.length) await appTable("repair_jobs").update({ status: "complete" }).eq("vault_id", identity.vaultId).in("shard_id", oldShardIds).in("status", ["queued", "claimed"]);
    if (transferId) await appTable("transfers").update({ status: "complete", bytes_complete: Number(segment.cipher_size_bytes) }).eq("id", transferId);
    window.dispatchEvent(new CustomEvent("meshvault:resilience-updated"));
    return { segmentId: segment.id, generation, profile };
  } catch (error) {
    nextAttemptAt = Date.now() + RETRY_DELAY_MS;
    if (!committed) await cleanupFailedGeneration(identity, placed);
    if (claimed && !committed) await releaseSegmentProfileUpgrade(identity.vaultId, segment.id).catch(() => {});
    if (transferId) { try { await appTable("transfers").update({ status: "failed" }).eq("id", transferId); } catch {} }
    return null;
  } finally { running = false; }
}
