import {
  loadVaultCatalog, removeCatalogRow, upsertCatalogRow,
} from "../control/control-repository.js";
import { listKnownPeers } from "../network/peer-registry.js";
import {
  ACTIVE_PLACEMENT_STATUSES, PHYSICAL_PLACEMENT_STATUSES,
  planShardRepairs, selectErasureProfile,
} from "../network/shard-lifecycle.js";
import { finalizeFileVersion, listFiles, setFileStatus } from "./metadata-service.js";

const PROFILE_CLAIM_MS = 2 * 60 * 1000;

async function catalogPayload() {
  const opened = await loadVaultCatalog({ includeSupabase: false, includeAnchors: false }).catch(() => null);
  return opened?.payload || { folders: [], files: [], segments: [], versionSegments: [], tombstones: [], repairState: [] };
}

async function segmentById(segmentId) {
  return (await catalogPayload()).segments?.find((row) => row.id === segmentId) || null;
}

async function segmentContainingShard(shardId) {
  return (await catalogPayload()).segments?.find((row) => (row.segment_shards || []).some((shard) => shard.id === shardId)) || null;
}

function clone(value) { return structuredClone(value); }
function nowIso() { return new Date().toISOString(); }
function nodeValue(node, snake, camel, fallback = null) { return node?.[snake] ?? node?.[camel] ?? fallback; }

async function saveSegment(segment) {
  await upsertCatalogRow("segments", clone(segment));
  return segment;
}

export async function mutateContentSegment(vaultId, segmentId, mutate) {
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId) return null;
  const next = await mutate(clone(segment));
  if (!next) return null;
  await saveSegment(next);
  return clone(next);
}

export async function listContentSegmentReferences(vaultId, segmentId) {
  const payload = await catalogPayload();
  const versionIds = new Set((payload.versionSegments || [])
    .filter((row) => row.vault_id === vaultId && row.content_segment_id === segmentId)
    .map((row) => row.file_version_id));
  const references = [];
  for (const file of payload.files || []) {
    if (file.vault_id !== vaultId) continue;
    for (const version of file.file_versions || []) if (versionIds.has(version.id)) references.push({ ...clone(version), file_id: file.id });
  }
  return references;
}

export function currentGenerationShards(segment) {
  const generation = Number(segment?.coding_generation || 1);
  return (segment?.segment_shards || []).filter((shard) => Number(shard.coding_generation || 1) === generation);
}

export function normalizeSegmentGeneration(segment) {
  return segment ? { ...segment, coding_generation: Number(segment.coding_generation || 1), segment_shards: currentGenerationShards(segment) } : segment;
}

export function chooseErasureProfile(independentNodes, resilienceClass = window.__DATA__?.resilience?.defaultErasureClass || "auto", context = {}) {
  return selectErasureProfile(window.__DATA__?.erasureProfiles || [], independentNodes, resilienceClass, context);
}

export function independentCandidateCount(candidates = []) {
  return new Set(candidates.map((candidate) => candidate.failure_domain_id || candidate.id).filter(Boolean)).size;
}

export async function loadPlacementCandidates(localNode, connectedPeers = []) {
  const protocolByNode = new Map((connectedPeers || []).map((entry) => [entry.nodeId, entry]));
  const knownByNode = new Map(listKnownPeers().map((entry) => [entry.peerId, entry]));
  const candidates = [];
  if (localNode?.id && localNode.status === "online" && Number(localNode.capacity_bytes || 0) > Number(localNode.used_bytes || 0)) {
    candidates.push({
      ...localNode,
      isLocal: true,
      peer: null,
      freeBytes: Math.max(0, Number(localNode.capacity_bytes || 0) - Number(localNode.used_bytes || 0)),
    });
  }
  for (const [nodeId, peer] of protocolByNode) {
    const known = knownByNode.get(nodeId) || {};
    const capacity = Number(known.capacityBytes || 0);
    const used = Number(known.usedBytes || 0);
    if (!nodeId || capacity <= used) continue;
    candidates.push({
      id: nodeId,
      vault_id: null,
      device_public_key: known.devicePublicKey || null,
      failure_domain_id: known.failureDomainId || nodeId,
      country_code: known.countryCode || null,
      region_code: known.regionCode || null,
      network_domain_hash: known.networkDomainHash || null,
      reliability_score: Number(known.reliabilityScore || 0),
      capacity_bytes: capacity,
      used_bytes: used,
      status: "online",
      isLocal: false,
      peer,
      freeBytes: Math.max(0, capacity - used),
    });
  }
  candidates.sort((left, right) => Number(right.reliability_score) - Number(left.reliability_score) || right.freeBytes - left.freeBytes);
  return candidates;
}

export async function findReusableSegment(vaultId, fingerprint) {
  const segment = (await catalogPayload()).segments?.find((row) => row.vault_id === vaultId && row.dedup_fingerprint === fingerprint && row.status === "ready");
  return normalizeSegmentGeneration(segment || null);
}

export async function getContentSegment(vaultId, segmentId) {
  const segment = await segmentById(segmentId);
  return segment?.vault_id === vaultId ? normalizeSegmentGeneration(clone(segment)) : null;
}

export async function listContentSegments(vaultId) {
  return (await catalogPayload()).segments
    ?.filter((row) => !vaultId || row.vault_id === vaultId)
    .map((row) => normalizeSegmentGeneration(clone(row))) || [];
}

export async function createContentSegment(values) {
  const segment = { ...clone(values), id: values.id || crypto.randomUUID(), status: values.status || "building", reference_count: Number(values.reference_count || 0), physical_storage_bytes: Number(values.physical_storage_bytes || 0), segment_shards: [] };
  await saveSegment(segment);
  return clone(segment);
}

export async function removeContentSegment(_vaultId, segmentId) {
  await removeCatalogRow("segments", segmentId);
  const payload = await catalogPayload();
  await Promise.all((payload.versionSegments || []).filter((row) => row.content_segment_id === segmentId).map((row) => removeCatalogRow("versionSegments", row.id)));
}

export async function updateSegmentPhysicalBytes(vaultId, segmentId, physicalBytes) {
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId) throw new Error("The encrypted segment is not available locally.");
  await saveSegment({ ...segment, physical_storage_bytes: Math.max(0, Number(physicalBytes) || 0) });
}

export async function markSegmentReady(vaultId, segmentId, descriptor) {
  if (!descriptor?.descriptorHash || !descriptor?.signature) throw new Error("A signed segment descriptor is required before a segment becomes reusable.");
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId) throw new Error("The encrypted segment is not available locally.");
  await saveSegment({ ...segment, status: "ready", owner_descriptor_hash: descriptor.descriptorHash, owner_descriptor_signature: descriptor.signature, updated_at: nowIso() });
}

export async function registerSegmentShards(vaultId, segmentId, shards, codingGeneration = 1) {
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId) throw new Error("The encrypted segment is not available locally.");
  const rows = shards.map((shard, index) => ({
    id: crypto.randomUUID(), vault_id: vaultId, content_segment_id: segmentId,
    coding_generation: codingGeneration, shard_index: index, shard_hash: shard.hash,
    size_bytes: shard.bytes.byteLength, status: "verified", shard_placements: [],
  }));
  await saveSegment({ ...segment, segment_shards: [...(segment.segment_shards || []).filter((row) => Number(row.coding_generation || 1) !== Number(codingGeneration)), ...rows] });
  return clone(rows);
}

export async function recordShardPlacement({ vaultId, shardId, node, role = "durable", replacementForPlacementId = null, status = "verified" }) {
  if (!["pending", "verified"].includes(status)) throw new Error("A new shard placement must be pending or verified.");
  const segment = await segmentContainingShard(shardId);
  if (!segment || segment.vault_id !== vaultId) throw new Error("The shard is not available in this vault index.");
  const timestamp = nowIso();
  let stored = null;
  const shards = (segment.segment_shards || []).map((shard) => {
    if (shard.id !== shardId) return shard;
    const existing = (shard.shard_placements || []).find((row) => row.node_id === node.id);
    stored = {
      ...(existing || {}), id: existing?.id || crypto.randomUUID(), vault_id: vaultId,
      shard_id: shardId, node_id: node.id,
      failure_domain_id: nodeValue(node, "failure_domain_id", "failureDomainId", node.id),
      country_code: nodeValue(node, "country_code", "countryCode"),
      region_code: nodeValue(node, "region_code", "regionCode"),
      network_domain_hash: nodeValue(node, "network_domain_hash", "networkDomainHash"),
      role, status, verified_at: status === "verified" ? timestamp : null,
      last_proof_at: status === "verified" ? timestamp : null,
      replacement_for_placement_id: replacementForPlacementId,
      unavailable_since: null, retire_after: null, deletion_authorization: null, deleted_at: null,
    };
    return { ...shard, shard_placements: [stored, ...(shard.shard_placements || []).filter((row) => row.id !== stored.id && row.node_id !== node.id)] };
  });
  await saveSegment({ ...segment, segment_shards: shards });
  return clone(stored);
}

export async function updatePlacementAuthorization(vaultId, placementId, authorization) {
  const payload = await catalogPayload();
  const segment = (payload.segments || []).find((entry) => (entry.segment_shards || []).some((shard) => (shard.shard_placements || []).some((placement) => placement.id === placementId)));
  if (!segment || segment.vault_id !== vaultId) throw new Error("The shard placement is not available locally.");
  let stored = null;
  const shards = segment.segment_shards.map((shard) => ({ ...shard, shard_placements: (shard.shard_placements || []).map((placement) => {
    if (placement.id !== placementId) return placement;
    stored = { ...placement, deletion_authorization: authorization };
    return stored;
  }) }));
  await saveSegment({ ...segment, segment_shards: shards });
  return clone(stored);
}

export async function transitionShardPlacement(vaultId, placementId, status) {
  if (!["verified", "deleting", "deleted", "unavailable", "suspect", "surplus", "retiring"].includes(status)) throw new Error("Unsupported shard placement transition.");
  const payload = await catalogPayload();
  const segment = (payload.segments || []).find((entry) => (entry.segment_shards || []).some((shard) => (shard.shard_placements || []).some((placement) => placement.id === placementId)));
  if (!segment || segment.vault_id !== vaultId) throw new Error(`Shard placement could not transition to ${status}.`);
  let stored = null;
  const timestamp = nowIso();
  const shards = segment.segment_shards.map((shard) => ({ ...shard, shard_placements: (shard.shard_placements || []).map((placement) => {
    if (placement.id !== placementId) return placement;
    stored = { ...placement, status, verified_at: status === "verified" ? timestamp : placement.verified_at, last_proof_at: status === "verified" ? timestamp : placement.last_proof_at, deleted_at: status === "deleted" ? timestamp : null };
    return stored;
  }) }));
  await saveSegment({ ...segment, segment_shards: shards });
  return clone(stored);
}

export async function linkVersionSegment({ vaultId, versionId, segmentId, segmentIndex, originalOffset, expectedGeneration, expectedDescriptorHash }) {
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId || segment.status !== "ready") return false;
  if (Number(segment.coding_generation || 1) !== Number(expectedGeneration || 1) || segment.owner_descriptor_hash !== expectedDescriptorHash) return false;
  const id = `${versionId}:${segmentIndex}`;
  const payload = await catalogPayload();
  if (!(payload.versionSegments || []).some((row) => row.id === id)) {
    await upsertCatalogRow("versionSegments", { id, vault_id: vaultId, file_version_id: versionId, content_segment_id: segmentId, segment_index: segmentIndex, original_offset: originalOffset, created_at: nowIso() });
    await saveSegment({ ...segment, reference_count: Number(segment.reference_count || 0) + 1 });
  }
  return true;
}

export async function getVersionSegments(vaultId, versionId) {
  const payload = await catalogPayload();
  const segments = new Map((payload.segments || []).map((row) => [row.id, row]));
  return (payload.versionSegments || []).filter((row) => row.vault_id === vaultId && row.file_version_id === versionId).sort((a, b) => Number(a.segment_index) - Number(b.segment_index)).map((link) => ({ ...clone(link), content_segments: normalizeSegmentGeneration(clone(segments.get(link.content_segment_id))) })).filter((link) => link.content_segments);
}

export async function beginAtomicFileDeletion(vaultId, fileId) {
  const payload = await catalogPayload();
  const file = (payload.files || []).find((row) => row.id === fileId && row.vault_id === vaultId);
  if (!file) throw new Error("This file is not available in the signed vault index.");
  const versionIds = new Set((file.file_versions || []).map((row) => row.id));
  const removedLinks = (payload.versionSegments || []).filter((row) => versionIds.has(row.file_version_id));
  const removedSegmentIds = new Set(removedLinks.map((row) => row.content_segment_id));
  const remainingLinks = (payload.versionSegments || []).filter((row) => !versionIds.has(row.file_version_id));
  const deletionOrders = [];
  const deletingSegmentIds = [];
  const sharedSegmentIds = [];
  for (const segmentId of removedSegmentIds) {
    const segment = (payload.segments || []).find((row) => row.id === segmentId);
    if (!segment) continue;
    if (remainingLinks.some((row) => row.content_segment_id === segmentId)) { sharedSegmentIds.push(segmentId); await saveSegment({ ...segment, reference_count: Math.max(0, Number(segment.reference_count || 1) - removedLinks.filter((row) => row.content_segment_id === segmentId).length) }); continue; }
    deletingSegmentIds.push(segmentId);
    const shards = (segment.segment_shards || []).map((shard) => ({ ...shard, status: "deleting", shard_placements: (shard.shard_placements || []).map((placement) => {
      if (placement.status === "deleted") return placement;
      const deleting = { ...placement, status: "deleting" };
      if (deleting.deletion_authorization) deletionOrders.push({ ...deleting, shard_hash: shard.shard_hash, authorization: deleting.deletion_authorization });
      return deleting;
    }) }));
    await saveSegment({ ...segment, status: "deleting", reference_count: 0, segment_shards: shards });
  }
  await Promise.all(removedLinks.map((row) => removeCatalogRow("versionSegments", row.id)));
  return { fileId, deletionOrders, sharedSegmentIds, deletingSegmentIds };
}

export async function loadFilePlacementStateForSegment(vaultId, segmentId) {
  const payload = await catalogPayload();
  const referencedVersions = new Set((payload.versionSegments || []).filter((row) => row.content_segment_id === segmentId).map((row) => row.file_version_id));
  const linkedSegmentIds = new Set((payload.versionSegments || []).filter((row) => referencedVersions.has(row.file_version_id)).map((row) => row.content_segment_id));
  const placements = [];
  let expectedPlacements = 0;
  for (const segment of payload.segments || []) {
    if (segment.vault_id !== vaultId || !linkedSegmentIds.has(segment.id)) continue;
    expectedPlacements += Number(segment.total_shards || 0);
    for (const shard of currentGenerationShards(segment)) for (const placement of shard.shard_placements || []) {
      if (placement.role === "durable" && ACTIVE_PLACEMENT_STATUSES.includes(placement.status)) placements.push({ ...placement, size_bytes: Number(shard.size_bytes || 0) });
    }
  }
  return { placements, expectedPlacements, placementScope: [...referencedVersions].sort().join(":") || segmentId };
}

export async function claimSegmentProfileUpgrade(vaultId, segmentId, generation, claimToken) {
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId || Number(segment.coding_generation || 1) !== Number(generation)) return false;
  if (segment.profile_upgrade_claim && Number(segment.profile_upgrade_claim.expiresAt || 0) > Date.now() && segment.profile_upgrade_claim.token !== claimToken) return false;
  await saveSegment({ ...segment, status: "rebalancing", profile_upgrade_claim: { token: claimToken, expiresAt: Date.now() + PROFILE_CLAIM_MS } });
  return true;
}

export async function renewSegmentProfileUpgradeClaim(vaultId, segmentId, claimToken) {
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId || segment.profile_upgrade_claim?.token !== claimToken || Number(segment.profile_upgrade_claim.expiresAt || 0) <= Date.now()) throw new Error("The profile-upgrade claim expired or changed.");
  await saveSegment({ ...segment, profile_upgrade_claim: { token: claimToken, expiresAt: Date.now() + PROFILE_CLAIM_MS } });
  return true;
}

export async function commitSegmentProfileUpgrade(vaultId, segmentId, expectedGeneration, claimToken, values, versionUpdates) {
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId || Number(segment.coding_generation || 1) !== Number(expectedGeneration) || segment.profile_upgrade_claim?.token !== claimToken) throw new Error("The profile-upgrade transaction was not committed.");
  const { profile_upgrade_claim: _claim, ...clean } = segment;
  await saveSegment({ ...clean, ...clone(values), status: "ready" });
  for (const update of versionUpdates || []) if (update?.id || update?.version_id) {
    const id = update.id || update.version_id;
    const files = await listFiles(vaultId);
    const file = files.find((entry) => entry.version?.id === id || (entry.file_versions || []).some((version) => version.id === id));
    if (file) await finalizeFileVersion(vaultId, id, file.id, update);
  }
  return true;
}

export async function releaseSegmentProfileUpgrade(vaultId, segmentId, claimToken) {
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId || segment.profile_upgrade_claim?.token !== claimToken) return;
  const { profile_upgrade_claim: _claim, ...clean } = segment;
  await saveSegment({ ...clean, status: segment.status === "rebalancing" ? "ready" : segment.status });
}

export async function queueShardRepair(vaultId, shardId, targetNodeId = null, options = {}) {
  const payload = await catalogPayload();
  const existing = (payload.repairState || []).find((row) => row.vault_id === vaultId && row.shard_id === shardId && ["queued", "claimed", "announced"].includes(row.status));
  if (existing) return existing;
  const request = { id: options.requestId || crypto.randomUUID(), vault_id: vaultId, shard_id: shardId, target_node_id: targetNodeId, status: "announced", requested_at: nowIso(), expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(), distributed: true };
  await upsertCatalogRow("repairState", request);
  if (options.announce !== false) window.dispatchEvent(new CustomEvent("meshvault:repair-needed", { detail: { vaultId, shardId, targetNodeId, requestId: request.id, requestedAt: Date.now(), expiresAt: Date.parse(request.expires_at) } }));
  return clone(request);
}

export async function listShardRepairs(vaultId) {
  return (await catalogPayload()).repairState
    ?.filter((row) => !vaultId || row.vault_id === vaultId)
    .map((row) => clone(row)) || [];
}

export async function updateShardRepair(vaultId, repairId, values = {}) {
  const payload = await catalogPayload();
  const row = (payload.repairState || []).find((entry) => entry.id === repairId && entry.vault_id === vaultId);
  if (!row) return null;
  const next = { ...row, ...clone(values), updated_at: nowIso() };
  await upsertCatalogRow("repairState", next);
  return clone(next);
}

export function summarizeVersionSegments(versionSegments) {
  const rows = versionSegments.map((link) => link.content_segments || link.segment || link).filter(Boolean);
  const devices = new Set(); const countries = new Set(); const regions = new Set(); const networks = new Set();
  let activeShards = rows.length ? Infinity : 0; let allRecoverable = !!rows.length; let allResilient = !!rows.length;
  for (const segment of rows) {
    const domains = new Set(); let independent = 0;
    for (const shard of currentGenerationShards(segment)) {
      const placement = (shard.shard_placements || []).find((entry) => entry.role === "durable" && ACTIVE_PLACEMENT_STATUSES.includes(entry.status) && !domains.has(entry.failure_domain_id || entry.node_id));
      if (!placement) continue;
      domains.add(placement.failure_domain_id || placement.node_id); devices.add(placement.node_id); independent += 1;
      if (placement.country_code) countries.add(placement.country_code); if (placement.region_code) regions.add(placement.region_code); if (placement.network_domain_hash) networks.add(placement.network_domain_hash);
    }
    activeShards = Math.min(activeShards, independent);
    allRecoverable = allRecoverable && independent >= Number(segment.required_shards || 0);
    allResilient = allResilient && independent >= Number(segment.total_shards || 0);
  }
  return { activeShards: Number.isFinite(activeShards) ? activeShards : 0, independentNodes: devices.size, independentDevices: devices.size, countryCount: countries.size, regionCount: regions.size, networkDomainCount: networks.size, verifiedPhysicalDevices: devices.size, recoveryStatus: allResilient ? "resilient" : allRecoverable ? "recoverable" : devices.size > 1 ? "distributing" : "local_pending" };
}

export async function refreshPhysicalStorageTotals(vaultId, segmentId) {
  const segment = await segmentById(segmentId);
  if (!segment || segment.vault_id !== vaultId) return null;
  const allocations = new Set(); let physicalBytes = 0; let physicalCopies = 0; let surplusPlacements = 0;
  for (const shard of segment.segment_shards || []) for (const placement of shard.shard_placements || []) {
    if (!PHYSICAL_PLACEMENT_STATUSES.includes(placement.status)) continue;
    const key = `${placement.node_id}:${shard.shard_hash}`; if (allocations.has(key)) continue;
    allocations.add(key); physicalBytes += Number(shard.size_bytes || 0); physicalCopies += 1;
    if (["surplus", "retiring"].includes(placement.status)) surplusPlacements += 1;
  }
  await saveSegment({ ...segment, physical_storage_bytes: physicalBytes });
  return { physicalBytes, physicalCopies, surplusPlacements };
}

export async function auditVersionResilience(version) {
  const links = await getVersionSegments(version.vault_id, version.id);
  const liveIds = new Set(listKnownPeers().map((peer) => peer.peerId));
  if (version.local_node_id) liveIds.add(version.local_node_id);
  const activeLinks = links.map((link) => ({ ...link, content_segments: { ...link.content_segments, segment_shards: currentGenerationShards(link.content_segments).map((shard) => ({ ...shard, shard_placements: (shard.shard_placements || []).filter((placement) => liveIds.has(placement.node_id)) })) } }));
  const summary = summarizeVersionSegments(activeLinks);
  for (let index = 0; index < links.length; index += 1) {
    const activeShardIds = new Set(currentGenerationShards(activeLinks[index].content_segments).filter((shard) => (shard.shard_placements || []).some((placement) => ACTIVE_PLACEMENT_STATUSES.includes(placement.status))).map((shard) => shard.id));
    for (const shardId of planShardRepairs(links[index].content_segments, activeShardIds)) await queueShardRepair(version.vault_id, shardId).catch(() => {});
  }
  await finalizeFileVersion(version.vault_id, version.id, version.file_id, { active_shards: summary.activeShards, independent_devices: summary.independentDevices, recovery_status: summary.recoveryStatus }).catch(() => {});
  await setFileStatus(version.vault_id, version.file_id, summary.recoveryStatus).catch(() => {});
  return summary;
}

export async function auditAllVersionResilience(vaultId) {
  const files = await listFiles(vaultId);
  let count = 0;
  for (const file of files) for (const version of file.file_versions || []) { await auditVersionResilience({ ...version, vault_id: vaultId, file_id: file.id }); count += 1; }
  return count;
}

export async function listMyStorageNodes(vaultId) {
  const payload = await catalogPayload(); const nodes = new Set();
  for (const segment of payload.segments || []) if (segment.vault_id === vaultId) for (const shard of segment.segment_shards || []) for (const placement of shard.shard_placements || []) if (["stored", "verified"].includes(placement.status)) nodes.add(placement.node_id);
  return [...nodes];
}

export async function loadVaultStorageSummary(vaultId) {
  const empty = { uniqueSegments: 0, uniqueOriginalBytes: 0, representationBytes: 0, compressionSavedBytes: 0, physicalBytes: 0, physicalShardCopies: 0, surplusPlacements: 0, profiles: [] };
  if (!vaultId) return empty;
  const payload = await catalogPayload(); const allocations = new Set(); const profileCounts = new Map(); const summary = { ...empty };
  for (const segment of payload.segments || []) {
    if (segment.vault_id !== vaultId || !["ready", "rebalancing", "deleting"].includes(segment.status)) continue;
    if (segment.status !== "deleting") { summary.uniqueSegments += 1; summary.uniqueOriginalBytes += Number(segment.original_size_bytes || 0); summary.representationBytes += Number(segment.stored_size_bytes || 0); const profile = `${Number(segment.required_shards || 0)}+${Math.max(0, Number(segment.total_shards || 0) - Number(segment.required_shards || 0))}`; profileCounts.set(profile, (profileCounts.get(profile) || 0) + 1); }
    for (const shard of segment.segment_shards || []) for (const placement of shard.shard_placements || []) {
      if (!PHYSICAL_PLACEMENT_STATUSES.includes(placement.status)) continue;
      const key = `${placement.node_id}:${shard.shard_hash}`; if (allocations.has(key)) continue;
      allocations.add(key); summary.physicalBytes += Number(shard.size_bytes || 0); summary.physicalShardCopies += 1; if (["surplus", "retiring"].includes(placement.status)) summary.surplusPlacements += 1;
    }
  }
  summary.compressionSavedBytes = Math.max(0, summary.uniqueOriginalBytes - summary.representationBytes);
  summary.profiles = [...profileCounts].map(([profile, segmentCount]) => ({ profile, segmentCount }));
  return summary;
}

export async function listShardPlacementsForVersion(vaultId, versionId) {
  const byNode = new Map();
  for (const link of await getVersionSegments(vaultId, versionId)) for (const shard of link.content_segments?.segment_shards || []) for (const placement of shard.shard_placements || []) {
    if (placement.role !== "durable" || !["stored", "verified"].includes(placement.status)) continue;
    const existing = byNode.get(placement.node_id) || { nodeId: placement.node_id, shardCount: 0, bytes: 0, countryCode: placement.country_code || null, regionCode: placement.region_code || null, networkDomainHash: placement.network_domain_hash || null };
    existing.shardCount += 1; existing.bytes += Number(shard.size_bytes || 0); byNode.set(placement.node_id, existing);
  }
  return [...byNode.values()];
}
