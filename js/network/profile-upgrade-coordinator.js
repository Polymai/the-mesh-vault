import {
  chooseErasureProfile, independentCandidateCount, loadPlacementCandidates, normalizeSegmentGeneration, claimSegmentProfileUpgrade,
  renewSegmentProfileUpgradeClaim, releaseSegmentProfileUpgrade, commitSegmentProfileUpgrade,
  registerSegmentShards, recordShardPlacement, transitionShardPlacement, queueShardRepair,
  refreshPhysicalStorageTotals, loadFilePlacementStateForSegment, listContentSegments,
  listContentSegmentReferences, mutateContentSegment, listShardRepairs, updateShardRepair,
} from "../services/segment-service.js";
import { hasActiveCapabilityForManifests } from "../services/capability-service.js";
import { acknowledgeLifecycleShardDeletion, processPendingLifecycleDeletions } from "../services/deletion-service.js";
import { currentVaultIdentity } from "../identity/vault-identity.js";
import { currentNode } from "./node-service.js";
import { connectedProtocols } from "./peer-manager.js";
import { getShard, putShard, deleteShard } from "../storage/fragment-store.js";
import { findFragment } from "./fragment-discovery.js";
import { reconstructShards, encodeShards } from "../security/erasure.js";
import { hashBytes } from "../security/keyring.js";
import { buildManifestV3, verifyManifestV3 } from "../security/manifest.js";
import { signSegmentDescriptor } from "../security/segment-descriptor.js";
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
const CLAIM_RENEW_INTERVAL_MS = 20_000;

function uuidV4() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}

function createClaimLease(vaultId, segmentId, claimToken) {
  let stopped = false;
  let failure = null;
  let pending = null;
  let lastRenewedAt = Date.now();
  const renew = async (force = false) => {
    if (stopped) throw new Error("The profile-upgrade claim lease is no longer active.");
    if (failure) throw failure;
    if (!force && Date.now() - lastRenewedAt < CLAIM_RENEW_INTERVAL_MS / 2) return true;
    if (!pending) {
      pending = renewSegmentProfileUpgradeClaim(vaultId, segmentId, claimToken)
        .then((renewed) => {
          if (!renewed) throw new Error("The profile-upgrade claim lease was lost.");
          lastRenewedAt = Date.now();
          return true;
        })
        .catch((error) => { failure = error; throw error; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
  const timer = setInterval(() => { renew(true).catch(() => {}); }, CLAIM_RENEW_INTERVAL_MS);
  return {
    renew,
    assertHealthy() { if (failure) throw failure; },
    stop() { stopped = true; clearInterval(timer); },
  };
}

function signerFor(identity) { return { publicKey: identity.ownerPublicKey, algorithm: identity.algorithm, sign: identity.sign }; }
async function storeLocalVerified(shardHash, bytes) {
  await putShard(shardHash, bytes);
  const stored = await getShard(shardHash);
  if (!stored || (await hashBytes(stored)) !== shardHash) { await deleteShard(shardHash).catch(() => {}); throw new Error("Local profile-upgrade shard verification failed."); }
}

function replacePlacedRecord(placed, placement) {
  const index = placed.placements.findIndex((entry) => entry.id === placement.id);
  if (index >= 0) placed.placements[index] = placement;
  else placed.placements.push(placement);
  return placement;
}

async function retireStagedPlacement(identity, node, peer, shardHash, placed, placement) {
  if (!placement || placement.status === "deleted") return placement;
  const deleting = await transitionShardPlacement(identity.vaultId, placement.id, "deleting");
  replacePlacedRecord(placed, deleting);
  if (deleting.node_id === node.id) await acknowledgeLifecycleShardDeletion(node.id, shardHash).catch(() => false);
  else if (peer) await peer.protocol.requestDelete(shardHash).catch(() => false);
  return deleting;
}

async function verifiedManifest(manifestId, vaultId, ownerPublicKey, fileVersionId) {
  const envelope = await getLocalManifest(manifestId).catch(() => null) || await lookupManifest(manifestId).catch(() => null);
  if (!envelope || envelope.vaultId !== vaultId || envelope.ownerPublicKey !== ownerPublicKey) return null;
  const result = await verifyManifestV3(envelope, {
    expectedManifestId: manifestId,
    expectedVaultId: vaultId,
    expectedOwnerPublicKey: ownerPublicKey,
    expectedFileVersionId: fileVersionId,
  });
  return result.valid ? envelope : null;
}

async function referencingVersions(segment, identity) {
  const versions = await listContentSegmentReferences(identity.vaultId, segment.id);
  if (!versions.length) return [];
  const bundles = [];
  for (const version of versions) {
    const manifest = await verifiedManifest(version.manifest_id, identity.vaultId, identity.ownerPublicKey, version.id);
    if (!manifest) throw new Error("A current signed manifest was unavailable; profile upgrade postponed.");
    if (!manifest.segments.some((entry) => entry.segmentId === segment.id)) throw new Error("The current manifest does not reference the segment being upgraded.");
    bundles.push({ version, manifest });
  }
  const oldManifestIds = Array.from(new Set(bundles.map((bundle) => bundle.manifest.manifestId)));
  if (await hasActiveCapabilityForManifests(oldManifestIds)) throw new Error("An active share link still references this coding generation; profile upgrade postponed.");
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

async function placeGeneration({ identity, node, peers, candidates, segment, generation, profile, cipher, filePlacementContext, placementScope, renewClaim, stagedGeneration }) {
  const placed = stagedGeneration || {};
  const layout = await encodeShards(cipher, profile.dataShards, profile.parityShards);
  placed.payloads = await Promise.all(layout.shards.map(async (bytes) => ({ bytes: new Uint8Array(bytes), hash: await hashBytes(bytes) })));
  placed.shardRows = await registerSegmentShards(identity.vaultId, segment.id, placed.payloads, generation);
  placed.placements = [];
  placed.physicalBytes = 0;
  const placementContext = createPlacementContext();
  const transfer = window.__DATA__?.transport || {};
  await runConcurrent(placed.shardRows, Math.max(1, Math.min(3, Number(transfer.uploadShardConcurrency) || 3)), async (shard, index, signal) => {
    await renewClaim();
    const payload = placed.payloads[index]; let role = "cache"; let stored = false;
    const placementKey = `${placementScope}:${segment.id}:${generation}:${shard.shard_index}`;
    const attemptedCandidateIds = new Set();
    while (!stored) {
      await renewClaim();
      const candidate = rankPlacementCandidates(candidates, {
        context: placementContext,
        fileContext: filePlacementContext,
        placementKey,
        shardBytes: payload.bytes.byteLength,
      }).find((entry) => !attemptedCandidateIds.has(entry.id));
      if (!candidate) break;
      attemptedCandidateIds.add(candidate.id);
      recordPlacementChoice(placementContext, candidate);
      let reservation = null;
      try {
        reservation = await recordShardPlacement({ vaultId: identity.vaultId, shardId: shard.id, node: candidate, role: "durable", status: "pending" });
        replacePlacedRecord(placed, reservation);
        await withRetry(async (_attempt, attemptSignal) => {
          if (candidate.isLocal) await storeLocalVerified(shard.shard_hash, payload.bytes);
          else await candidate.peer.protocol.sendShard(shard.shard_hash, payload.bytes, payload.hash, undefined, { signal: attemptSignal });
        }, {
          retries: Number(transfer.retryAttempts) || 2,
          baseDelayMs: Number(transfer.retryBaseDelayMs) || 500,
          timeoutMs: Number(transfer.uploadAttemptTimeoutMs) || 50000,
          signal,
        });
        reservation = await transitionShardPlacement(identity.vaultId, reservation.id, "verified");
        replacePlacedRecord(placed, reservation);
        stored = true; role = "durable";
        recordFilePlacementChoice(filePlacementContext, candidate, payload.bytes.byteLength, `${segment.id}:${shard.id}:${candidate.id}`);
      } catch (error) {
        if (reservation) await retireStagedPlacement(identity, node, candidate.peer, shard.shard_hash, placed, reservation);
        releasePlacementChoice(placementContext, candidate);
        if (signal.aborted || error?.name === "AbortError") throw error;
      }
    }
    if (!stored) {
      role = placementContext.domains.has(node.failure_domain_id || node.id) ? "cache" : "durable";
      let reservation = await recordShardPlacement({ vaultId: identity.vaultId, shardId: shard.id, node, role, status: "pending" });
      replacePlacedRecord(placed, reservation);
      try {
        await storeLocalVerified(shard.shard_hash, payload.bytes);
        reservation = await transitionShardPlacement(identity.vaultId, reservation.id, "verified");
        replacePlacedRecord(placed, reservation);
      } catch (error) {
        await retireStagedPlacement(identity, node, null, shard.shard_hash, placed, reservation);
        throw error;
      }
      if (role === "durable") { recordPlacementChoice(placementContext, node); recordFilePlacementChoice(filePlacementContext, node, payload.bytes.byteLength, `${segment.id}:${shard.id}:${node.id}`); }
      await queueShardRepair(identity.vaultId, shard.id).catch(() => {});
    }
    await renewClaim();
    placed.physicalBytes += payload.bytes.byteLength;
  });
  return placed;
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
    ownerDescriptorHash: segment.owner_descriptor_hash,
    ownerDescriptorSignature: segment.owner_descriptor_signature,
    shardHashes: placed.shardRows.map((shard) => shard.shard_hash),
    placements: placed.shardRows.flatMap((shard) => placed.placements.filter((placement) => placement.shard_id === shard.id && placement.role === "durable" && placement.status === "verified").map((placement) => ({ shardIndex: shard.shard_index, nodeId: placement.node_id, failureDomain: placement.failure_domain_id }))),
  };
}

async function stageUpgradedManifests(identity, bundles, segment, generation, profile, placed, renewClaim) {
  if (!bundles.length) throw new Error("A referenced segment needs at least one file-version manifest before profile upgrade.");
  const signer = signerFor(identity);
  const staged = [];
  for (const { version, manifest } of bundles) {
    await renewClaim();
    const segments = manifest.segments.map((entry) => entry.segmentId === segment.id ? upgradedManifestSegment(entry, segment, generation, profile, placed) : entry);
    const envelope = await buildManifestV3({ storageProtocolVersion: 3, vaultId: identity.vaultId, fileVersionId: version.id, originalHash: manifest.originalHash, originalSize: manifest.originalSize, segmentCount: manifest.segmentCount, boundaryMethod: manifest.boundaryMethod, segments }, signer);
    await saveManifestLocally(envelope);
    await announceManifest(envelope);
    const minimum = Math.max(...segments.map((entry) => Number(entry.requiredShards || 0)));
    const total = Math.max(...segments.map((entry) => Number(entry.totalShards || 0)));
    const repairThreshold = Math.max(...segments.map((entry) => Number(entry.repairThreshold || entry.requiredShards || 0)));
    staged.push({
      version,
      envelope,
      versionUpdate: {
        fileVersionId: version.id,
        fileId: version.file_id,
        previousManifestId: version.manifest_id || null,
        manifestId: envelope.manifestId,
        minimumRequiredShards: minimum,
        repairThresholdShards: repairThreshold,
        totalShards: total,
        physicalStorageBytes: Number(version.physical_storage_bytes || 0) + placed.physicalBytes,
      },
    });
  }
  return staged;
}

async function publishCommittedManifests(identity, staged) {
  const signer = signerFor(identity);
  for (const { version, envelope } of staged) {
    try {
      await appendOperation(signer, identity.vaultId, OP_TYPES.PUBLISH_MANIFEST, { fileId: version.file_id, fileVersionId: version.id, manifestId: envelope.manifestId, manifestHash: envelope.manifestHash });
    } catch {
      window.dispatchEvent(new CustomEvent("meshvault:catalog-sync-needed", { detail: { fileVersionId: version.id, manifestId: envelope.manifestId } }));
    }
    peersReplicate(envelope, connectedProtocols());
  }
}

function peersReplicate(envelope, peers) { peers.slice(0, 3).forEach((peer) => peer.protocol.sendManifest(envelope.manifestId, envelope).catch(() => {})); }

async function shardHashCanBeRemoved(vaultId, shardHash, retiredShardId) {
  const segments = await listContentSegments(vaultId);
  return !segments.some((segment) => (segment.segment_shards || []).some((shard) => shard.id !== retiredShardId && shard.shard_hash === shardHash && ["pending", "verified"].includes(shard.status)));
}

async function retireOldGeneration(identity, node, peers, segment) {
  for (const shard of segment.segment_shards || []) {
    await shardHashCanBeRemoved(identity.vaultId, shard.shard_hash, shard.id);
    const retiring = [];
    for (const placement of shard.shard_placements || []) {
      if (placement.status === "deleted") continue;
      const deleting = placement.status === "deleting"
        ? placement
        : await transitionShardPlacement(identity.vaultId, placement.id, "deleting");
      retiring.push(deleting);
    }
    await mutateContentSegment(identity.vaultId, shard.content_segment_id || segment.id, (current) => ({
      ...current,
      segment_shards: (current.segment_shards || []).map((entry) => entry.id === shard.id ? { ...entry, status: "deleting" } : entry),
    }));
    if (retiring.some((placement) => placement.node_id === node.id)) {
      await acknowledgeLifecycleShardDeletion(node.id, shard.shard_hash).catch(() => false);
    }
    const remoteNodeIds = new Set(retiring.filter((placement) => placement.node_id !== node.id).map((placement) => placement.node_id));
    for (const peer of peers) if (remoteNodeIds.has(peer.nodeId)) await peer.protocol.requestDelete(shard.shard_hash).catch(() => false);
  }
}

async function markOrphanedCodingGenerations(identity, node, peers) {
  const orphaned = [];
  for (const segment of await listContentSegments(identity.vaultId)) {
    if (segment.status !== "ready") continue;
    const shards = (segment.segment_shards || []).filter((shard) => ["pending", "verified", "missing"].includes(shard.status) && Number(shard.coding_generation || 1) !== Number(segment.coding_generation || 1));
    if (shards.length) { orphaned.push(...shards); await retireOldGeneration(identity, node, peers, { id: segment.id, segment_shards: shards }); }
  }
  return orphaned.length;
}

async function retryRemoteLifecycleDeletions(identity, node, peers, limit = 100) {
  const data = [];
  for (const segment of await listContentSegments(identity.vaultId)) for (const shard of segment.segment_shards || []) for (const placement of shard.shard_placements || []) {
    if (data.length >= limit) break;
    if (placement.status === "deleting" && !placement.deletion_authorization && placement.node_id !== node.id) data.push({ ...placement, shard_hash: shard.shard_hash });
  }
  const peerById = new Map(peers.map((peer) => [peer.nodeId, peer]));
  const requested = new Set();
  for (const placement of data) {
    const shardHash = placement.shard_hash;
    const peer = peerById.get(placement.node_id);
    const key = `${placement.node_id}:${shardHash || ""}`;
    if (!peer || !shardHash || requested.has(key)) continue;
    requested.add(key);
    await peer.protocol.requestDelete(shardHash).catch(() => false);
  }
  return requested.size;
}

export async function cleanupRetiredCodingGeneration() {
  const identity = currentVaultIdentity(); const node = currentNode(); if (!identity || !node) return 0;
  const peers = connectedProtocols();
  await processPendingLifecycleDeletions(node.id);
  await retryRemoteLifecycleDeletions(identity, node, peers);
  await markOrphanedCodingGenerations(identity, node, peers);
  const rows = (await listContentSegments(identity.vaultId)).flatMap((segment) => (segment.segment_shards || []).filter((shard) => shard.status === "deleting").map((shard) => ({ ...shard, content_segment_id: segment.id }))).slice(0, 20);
  let removed = 0;
  for (const shard of rows) {
    await shardHashCanBeRemoved(identity.vaultId, shard.shard_hash, shard.id);
    for (const placement of shard.shard_placements || []) {
      if (["deleted"].includes(placement.status)) continue;
      if (placement.status !== "deleting") await transitionShardPlacement(identity.vaultId, placement.id, "deleting");
      if (placement.node_id === node.id) {
        await acknowledgeLifecycleShardDeletion(node.id, shard.shard_hash).catch(() => false);
      } else {
        const peer = peers.find((entry) => entry.nodeId === placement.node_id);
        if (peer) await peer.protocol.requestDelete(shard.shard_hash).catch(() => false);
      }
    }
    const allDeleted = (shard.shard_placements || []).every((placement) => placement.status === "deleted");
    if (!allDeleted) continue;
    await mutateContentSegment(identity.vaultId, shard.content_segment_id, (segment) => ({ ...segment, segment_shards: (segment.segment_shards || []).filter((entry) => entry.id !== shard.id) })); removed += 1;
    await refreshPhysicalStorageTotals(identity.vaultId, shard.content_segment_id).catch(() => {});
  }
  return removed;
}

async function cleanupFailedGeneration(identity, node, peers, placed) {
  if (!placed?.shardRows?.length) return true;
  const shardIds = placed.shardRows.map((shard) => shard.id);
  const current = await listContentSegments(identity.vaultId);
  const placementsByShard = new Map();
  for (const segment of current) for (const shard of segment.segment_shards || []) if (shardIds.includes(shard.id)) placementsByShard.set(shard.id, shard.shard_placements || []);
  for (const shard of placed.shardRows || []) {
    const placements = placementsByShard.get(shard.id) || [];
    for (const placement of placements) {
      if (!["deleting", "deleted"].includes(placement.status)) await transitionShardPlacement(identity.vaultId, placement.id, "deleting");
    }
    const marked = await mutateContentSegment(identity.vaultId, shard.content_segment_id, (segment) => ({ ...segment, segment_shards: (segment.segment_shards || []).map((entry) => entry.id === shard.id ? { ...entry, status: "deleting" } : entry) }));
    if (!marked) throw new Error("Failed profile-generation cleanup intent was not recorded.");
    if (placements.some((placement) => placement.node_id === node.id)) {
      await acknowledgeLifecycleShardDeletion(node.id, shard.shard_hash).catch(() => false);
    }
    const remoteNodeIds = new Set(placements.filter((placement) => placement.node_id !== node.id).map((placement) => placement.node_id));
    for (const peer of peers) if (remoteNodeIds.has(peer.nodeId)) await peer.protocol.requestDelete(shard.shard_hash).catch(() => false);
  }
  const segmentId = placed.shardRows?.[0]?.content_segment_id;
  if (segmentId) await refreshPhysicalStorageTotals(identity.vaultId, segmentId).catch(() => {});
  return true;
}

export async function upgradeOneCodingProfile() {
  if (running || Date.now() < nextAttemptAt) return null;
  const identity = currentVaultIdentity(); const node = currentNode(); const peers = connectedProtocols();
  if (!identity || !node || node.status !== "online") return null;
  for (const stale of await listContentSegments(identity.vaultId)) {
    if (stale.status === "rebalancing" && stale.profile_upgrade_claim && Number(stale.profile_upgrade_claim.expiresAt || 0) < Date.now()) {
      await mutateContentSegment(identity.vaultId, stale.id, (segment) => { const { profile_upgrade_claim: _claim, ...clean } = segment; return { ...clean, status: "ready" }; });
    }
  }
  const candidates = await loadPlacementCandidates(node, peers);
  const profile = chooseErasureProfile(independentCandidateCount(candidates), await getErasureClass());
  if (!profile.placementReady) return null;
  const candidatesForUpgrade = (await listContentSegments(identity.vaultId)).filter((entry) => entry.status === "ready").sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0)).slice(0, 20);
  const segment = normalizeSegmentGeneration(candidatesForUpgrade.find((entry) => Number(entry.total_shards) < profile.totalShards || (Number(entry.total_shards) === profile.totalShards && (Number(entry.data_shards) !== profile.dataShards || Number(entry.parity_shards) !== profile.parityShards || Number(entry.repair_threshold || 0) !== profile.repairThreshold))));
  if (!segment) return null;
  running = true;
  const claimToken = uuidV4();
  let claimed = false; let claimLease = null; let placed = null; let committed = false; let durableCleanupError = null;
  try {
    const claim = await claimSegmentProfileUpgrade(identity.vaultId, segment.id, segment.coding_generation, claimToken); if (!claim) return null; claimed = true;
    claimLease = createClaimLease(identity.vaultId, segment.id, claimToken);
    await claimLease.renew(true);
    const generationRows = segment.segment_shards || [];
    const maxExistingGeneration = Math.max(Number(segment.coding_generation || 1), ...generationRows.map((shard) => Number(shard.coding_generation || 1)));
    const staleGenerationRows = generationRows.filter((shard) => Number(shard.coding_generation || 1) > Number(segment.coding_generation || 1) && ["pending", "verified", "missing", "deleting"].includes(shard.status));
    if (staleGenerationRows.length) {
      try { await cleanupFailedGeneration(identity, node, peers, { shardRows: staleGenerationRows }); }
      catch (cleanupError) { durableCleanupError = cleanupError; throw cleanupError; }
    }
    const bundles = await referencingVersions(segment, identity);
    await claimLease.renew();
    const cipher = await acquireCipher(segment, peers);
    await claimLease.renew();
    const generation = maxExistingGeneration + 1;
    const filePlacementState = await loadFilePlacementStateForSegment(identity.vaultId, segment.id);
    const expectedPlacements = Math.max(0, Number(filePlacementState.expectedPlacements || 0) - Number(segment.total_shards || 0) + profile.totalShards);
    const filePlacementContext = createFilePlacementContext(filePlacementState.placements, { expectedPlacements, candidateCount: candidates.length });
    placed = {};
    await placeGeneration({ identity, node, peers, candidates, segment, generation, profile, cipher, filePlacementContext, placementScope: filePlacementState.placementScope, renewClaim: claimLease.renew, stagedGeneration: placed });
    const upgradedSegment = {
      ...segment,
      format_version: 3,
      coding_generation: generation,
      data_shards: profile.dataShards,
      parity_shards: profile.parityShards,
      required_shards: profile.requiredShards,
      repair_threshold: profile.repairThreshold,
      total_shards: profile.totalShards,
      segment_shards: placed.shardRows,
    };
    const descriptor = await signSegmentDescriptor(upgradedSegment, signerFor(identity));
    upgradedSegment.owner_descriptor_hash = descriptor.descriptorHash;
    upgradedSegment.owner_descriptor_signature = descriptor.signature;
    const stagedManifests = await stageUpgradedManifests(identity, bundles, upgradedSegment, generation, profile, placed, claimLease.renew);
    await claimLease.renew(true);
    claimLease.assertHealthy();
    claimLease.stop(); claimLease = null;
    await commitSegmentProfileUpgrade(identity.vaultId, segment.id, Number(segment.coding_generation || 1), claimToken, { format_version: 3, coding_generation: generation, data_shards: profile.dataShards, parity_shards: profile.parityShards, required_shards: profile.requiredShards, repair_threshold: profile.repairThreshold, total_shards: profile.totalShards, owner_descriptor_hash: descriptor.descriptorHash, owner_descriptor_signature: descriptor.signature, physical_storage_bytes: Number(segment.physical_storage_bytes || 0) + placed.physicalBytes }, stagedManifests.map((entry) => entry.versionUpdate));
    committed = true;
    await publishCommittedManifests(identity, stagedManifests);
    await retireOldGeneration(identity, node, peers, segment).catch(() => {});
    await refreshPhysicalStorageTotals(identity.vaultId, segment.id).catch(() => {});
    const oldShardIds = new Set((segment.segment_shards || []).map((shard) => shard.id));
    for (const repair of await listShardRepairs(identity.vaultId)) if (oldShardIds.has(repair.shard_id) && ["queued", "claimed", "announced"].includes(repair.status)) await updateShardRepair(identity.vaultId, repair.id, { status: "complete" });
    window.dispatchEvent(new CustomEvent("meshvault:resilience-updated"));
    return { segmentId: segment.id, generation, profile };
  } catch (error) {
    nextAttemptAt = Date.now() + RETRY_DELAY_MS;
    let cleanupRecorded = committed;
    if (!committed && !durableCleanupError) {
      try { cleanupRecorded = await cleanupFailedGeneration(identity, node, peers, placed); }
      catch (cleanupError) { durableCleanupError = cleanupError; }
    }
    if (claimed && !committed && cleanupRecorded && !durableCleanupError) await releaseSegmentProfileUpgrade(identity.vaultId, segment.id, claimToken).catch(() => {});
    if (durableCleanupError) throw new AggregateError([error, durableCleanupError], "Profile upgrade failed before cleanup intent was durably recorded.");
    return null;
  } finally { claimLease?.stop(); running = false; }
}
