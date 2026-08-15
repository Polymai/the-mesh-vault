import { appTable, supabase } from "./supabase.js";
import { ACTIVE_PLACEMENT_STATUSES, PHYSICAL_PLACEMENT_STATUSES, nextOfflinePlacementState, planShardRepairs, selectErasureProfile } from "../network/shard-lifecycle.js";

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
  return new Set((candidates || []).map((candidate) => candidate.failure_domain_id || candidate.id).filter(Boolean)).size;
}

export async function loadPlacementCandidates(currentNode, connectedPeers = []) {
  const peerMap = new Map(connectedPeers.map((peer) => [peer.nodeId, peer]));
  const ids = [currentNode?.id, ...peerMap.keys()].filter(Boolean); if (!ids.length) return [];
  const ordinaryCutoff = Date.now() - Number(window.__DATA__?.resilience?.nodeStaleMs || 120000);
  const backboneCutoff = Date.now() - Number(window.__DATA__?.coordination?.supabaseBackboneLeaseMs || 900000);
  let { data, error } = await appTable("nodes").select("id,vault_id,device_public_key,failure_domain_id,country_code,region_code,network_domain_hash,reliability_score,survival_mode,lease_expires_at,capacity_bytes,used_bytes,status,last_seen_at").in("id", ids).eq("status", "online");
  if (error && /country_code|region_code|network_domain_hash|survival_mode|lease_expires_at/i.test(`${error.message || ""} ${error.details || ""}`)) ({ data, error } = await appTable("nodes").select("id,vault_id,device_public_key,failure_domain_id,reliability_score,capacity_bytes,used_bytes,status,last_seen_at").in("id", ids).eq("status", "online"));
  if (error) throw error;
  const databaseRows = data || [];
  // Placement rows still have a database FK to nodes.id. A Backbone storage
  // peer is therefore eligible only after its sparse compatibility
  // registration has completed; otherwise transfer could succeed while the
  // authoritative placement receipt fails to commit.
  const rows = databaseRows.filter((node) => {
    const isBackbone = !!node.survival_mode;
    const fresh = Date.parse(node.last_seen_at || 0) >= (isBackbone ? backboneCutoff : ordinaryCutoff);
    const leased = !isBackbone || Date.parse(node.lease_expires_at || 0) > Date.now();
    return fresh && leased && Number(node.capacity_bytes) > Number(node.used_bytes);
  }).map((node) => ({ ...node, peer: peerMap.get(node.id) || null, isLocal: node.id === currentNode?.id, freeBytes: Number(node.capacity_bytes) - Number(node.used_bytes) }));
  rows.sort((a, b) => Number(b.reliability_score) - Number(a.reliability_score) || b.freeBytes - a.freeBytes);
  const independent = []; const repeats = []; const seenIdentities = new Set(); const seenDomains = new Set();
  for (const row of rows) {
    const domain = row.failure_domain_id || row.id;
    const identity = row.vault_id || row.device_public_key || row.id;
    if (!seenIdentities.has(identity) && !seenDomains.has(domain)) { seenIdentities.add(identity); seenDomains.add(domain); independent.push(row); }
    else {
      // Multiple logical instances on one host remain useful capacity targets
      // for different segments. They never become independent within one
      // erasure group because placement context rejects a repeated domain.
      seenIdentities.add(identity); seenDomains.add(domain); repeats.push(row);
    }
  }
  return [...independent, ...repeats];
}

export async function findReusableSegment(vaultId, fingerprint) {
  const { data, error } = await appTable("content_segments").select("*,segment_shards(*,shard_placements(*))").eq("vault_id", vaultId).eq("dedup_fingerprint", fingerprint).eq("status", "ready").maybeSingle();
  if (error) throw error; return normalizeSegmentGeneration(data);
}
export async function createContentSegment(values) {
  const { data, error } = await appTable("content_segments").insert(values).select().single(); if (error) throw error; return data;
}
export async function updateSegmentPhysicalBytes(vaultId, segmentId, physicalBytes) {
  const { error } = await appTable("content_segments").update({ physical_storage_bytes: physicalBytes }).eq("vault_id", vaultId).eq("id", segmentId); if (error) throw error;
}
export async function markSegmentReady(vaultId, segmentId, descriptor) {
  const values = {
    status: "ready",
    owner_descriptor_hash: descriptor?.descriptorHash,
    owner_descriptor_signature: descriptor?.signature,
  };
  if (!values.owner_descriptor_hash || !values.owner_descriptor_signature) throw new Error("A signed segment descriptor is required before a segment becomes reusable.");
  const { error } = await appTable("content_segments").update(values).eq("vault_id", vaultId).eq("id", segmentId);
  if (error) throw error;
}
export async function registerSegmentShards(vaultId, segmentId, shards, codingGeneration = 1) {
  const rows = shards.map((shard, index) => ({ vault_id: vaultId, content_segment_id: segmentId, coding_generation: codingGeneration, shard_index: index, shard_hash: shard.hash, size_bytes: shard.bytes.byteLength, status: "verified" }));
  const { data, error } = await appTable("segment_shards").insert(rows).select(); if (error) throw error; return (data || []).sort((a, b) => a.shard_index - b.shard_index);
}
export async function recordShardPlacement({ vaultId, shardId, node, role = "durable", replacementForPlacementId = null, status = "verified" }) {
  if (!["pending", "verified"].includes(status)) throw new Error("A new shard placement must be pending or verified.");
  const now = new Date().toISOString();
  const verified = status === "verified";
  const base = {
    vault_id: vaultId, shard_id: shardId, node_id: node.id,
    failure_domain_id: node.failure_domain_id || node.id, role, status,
    verified_at: verified ? now : null, last_proof_at: verified ? now : null,
  };
  const values = { ...base, country_code: node.country_code || null, region_code: node.region_code || null, network_domain_hash: node.network_domain_hash || null, unavailable_since: null, retire_after: null, replacement_for_placement_id: replacementForPlacementId, deletion_authorization: null, deleted_at: null };
  let { data, error } = await appTable("shard_placements").upsert(values, { onConflict: "shard_id,node_id" }).select().single();
  if (error && /country_code|region_code|network_domain_hash|unavailable_since|retire_after|replacement_for_placement_id/i.test(`${error.message || ""} ${error.details || ""}`)) ({ data, error } = await appTable("shard_placements").upsert(base, { onConflict: "shard_id,node_id" }).select().single());
  if (error) throw error; return data;
}
export async function transitionShardPlacement(vaultId, placementId, status) {
  if (!["verified", "deleting"].includes(status)) throw new Error("Unsupported shard placement transition.");
  const now = new Date().toISOString();
  const values = status === "verified"
    ? { status, verified_at: now, last_proof_at: now, unavailable_since: null, deleted_at: null }
    : { status, deleted_at: null };
  const { data, error } = await appTable("shard_placements")
    .update(values).eq("vault_id", vaultId).eq("id", placementId)
    .in("status", status === "verified" ? ["pending", "verified"] : ["pending", "stored", "verified", "suspect", "unavailable", "surplus", "retiring", "deleting"])
    .select().maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Shard placement could not transition to ${status}.`);
  return data;
}
export async function linkVersionSegment({ vaultId, versionId, segmentId, segmentIndex, originalOffset, expectedGeneration, expectedDescriptorHash }) {
  const { data, error } = await supabase.schema("app717_meshvault").rpc("link_version_segment", {
    p_vault_id: vaultId,
    p_file_version_id: versionId,
    p_segment_id: segmentId,
    p_segment_index: segmentIndex,
    p_original_offset: originalOffset,
    p_expected_generation: expectedGeneration,
    p_expected_descriptor_hash: expectedDescriptorHash,
  });
  if (error) throw error;
  return data === true;
}
export async function beginAtomicFileDeletion(vaultId, fileId) {
  const { data, error } = await supabase.schema("app717_meshvault").rpc("begin_file_deletion", {
    p_vault_id: vaultId,
    p_file_id: fileId,
  });
  if (error) throw error;
  if (!data || data.fileId !== fileId) throw new Error("The atomic file-deletion result was invalid.");
  return {
    ...data,
    deletionOrders: Array.isArray(data.deletionOrders) ? data.deletionOrders : [],
    sharedSegmentIds: Array.isArray(data.sharedSegmentIds) ? data.sharedSegmentIds : [],
    deletingSegmentIds: Array.isArray(data.deletingSegmentIds) ? data.deletingSegmentIds : [],
  };
}
export async function getVersionSegments(vaultId, versionId) {
  const { data, error } = await appTable("version_segments").select("*,content_segments(*,segment_shards(*,shard_placements(*)))").eq("vault_id", vaultId).eq("file_version_id", versionId).order("segment_index"); if (error) throw error; return (data || []).map((link) => ({ ...link, content_segments: normalizeSegmentGeneration(link.content_segments) }));
}
export async function loadFilePlacementStateForSegment(vaultId, segmentId) {
  const empty = { placements: [], expectedPlacements: 0, placementScope: segmentId };
  const { data: references, error: referenceError } = await appTable("version_segments").select("file_version_id").eq("vault_id", vaultId).eq("content_segment_id", segmentId);
  if (referenceError) throw referenceError;
  const versionIds = [...new Set((references || []).map((row) => row.file_version_id).filter(Boolean))].sort();
  if (!versionIds.length) return empty;
  const { data: links, error } = await appTable("version_segments")
    .select("file_version_id,content_segment_id,content_segments(id,coding_generation,total_shards,segment_shards(id,coding_generation,size_bytes,shard_placements(id,node_id,failure_domain_id,country_code,region_code,network_domain_hash,role,status)))")
    .eq("vault_id", vaultId).in("file_version_id", versionIds);
  if (error) throw error;
  const placements = [];
  const seenPlacements = new Set();
  let expectedPlacements = 0;
  for (const link of links || []) {
    const segment = link.content_segments;
    if (!segment) continue;
    expectedPlacements += Math.max(0, Number(segment.total_shards || 0));
    const generation = Number(segment.coding_generation || 1);
    for (const shard of segment.segment_shards || []) {
      if (Number(shard.coding_generation || 1) !== generation) continue;
      for (const placement of shard.shard_placements || []) {
        if (placement.role !== "durable" || !ACTIVE_PLACEMENT_STATUSES.includes(placement.status) || seenPlacements.has(placement.id)) continue;
        seenPlacements.add(placement.id);
        placements.push({ ...placement, size_bytes: Number(shard.size_bytes || 0) });
      }
    }
  }
  return {
    placements,
    expectedPlacements,
    placementScope: versionIds.join(":"),
  };
}
export async function claimSegmentProfileUpgrade(vaultId, segmentId, generation, claimToken) {
  const { data, error } = await supabase.schema("app717_meshvault").rpc("claim_segment_profile_upgrade", {
    p_vault_id: vaultId,
    p_segment_id: segmentId,
    p_expected_generation: generation,
    p_claim_token: claimToken,
  });
  if (error) throw error;
  return data === true;
}
export async function renewSegmentProfileUpgradeClaim(vaultId, segmentId, claimToken) {
  const { data, error } = await supabase.schema("app717_meshvault").rpc("renew_segment_profile_upgrade_claim", {
    p_vault_id: vaultId,
    p_segment_id: segmentId,
    p_claim_token: claimToken,
  });
  if (error) throw error;
  if (data !== true) throw new Error("The profile-upgrade claim expired or changed.");
  return true;
}
export async function commitSegmentProfileUpgrade(vaultId, segmentId, expectedGeneration, claimToken, values, versionUpdates) {
  if (!Array.isArray(versionUpdates) || !versionUpdates.length) throw new Error("A profile upgrade must atomically update at least one file version.");
  const { data, error } = await supabase.schema("app717_meshvault").rpc("commit_segment_profile_upgrade", {
    p_vault_id: vaultId,
    p_segment_id: segmentId,
    p_expected_generation: expectedGeneration,
    p_claim_token: claimToken,
    p_next_generation: values.coding_generation,
    p_data_shards: values.data_shards,
    p_parity_shards: values.parity_shards,
    p_required_shards: values.required_shards,
    p_repair_threshold: values.repair_threshold,
    p_total_shards: values.total_shards,
    p_owner_descriptor_hash: values.owner_descriptor_hash,
    p_owner_descriptor_signature: values.owner_descriptor_signature,
    p_physical_storage_bytes: values.physical_storage_bytes,
    p_version_updates: versionUpdates,
  });
  if (error) throw error;
  if (data !== true) throw new Error("The profile-upgrade transaction was not committed.");
  return true;
}
export async function releaseSegmentProfileUpgrade(vaultId, segmentId, claimToken) {
  const { error } = await supabase.schema("app717_meshvault").rpc("release_segment_profile_upgrade_claim", {
    p_vault_id: vaultId,
    p_segment_id: segmentId,
    p_claim_token: claimToken,
  });
  if (error) throw error;
}
export async function queueShardRepair(vaultId, shardId, targetNodeId = null, options = {}) {
  const request = {
    vaultId,
    shardId,
    targetNodeId,
    requestId: options.requestId || crypto.randomUUID(),
    requestedAt: Date.now(),
    expiresAt: Date.now() + 30 * 60 * 1000,
  };
  if (options.announce !== false) {
    window.dispatchEvent(new CustomEvent("meshvault:repair-needed", { detail: request }));
  }
  try {
    const { data: existing, error: existingError } = await appTable("repair_jobs").select("id").eq("vault_id", vaultId).eq("shard_id", shardId).in("status", ["queued", "claimed"]).limit(1).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return existing;
    let { data, error } = await appTable("repair_jobs").insert({
      vault_id: vaultId,
      shard_id: shardId,
      target_node_id: targetNodeId,
      request_id: request.requestId,
      status: "queued",
    }).select().single();
    if (error && /request_id/i.test(`${error.message || ""} ${error.details || ""}`)) {
      ({ data, error } = await appTable("repair_jobs").insert({
        vault_id: vaultId,
        shard_id: shardId,
        target_node_id: targetNodeId,
        status: "queued",
      }).select().single());
    }
    if (error) throw error;
    return data;
  } catch (error) {
    if (options.requireSupabase) throw error;
    return { id: `distributed:${request.requestId}`, status: "announced", distributed: true, ...request };
  }
}
export function summarizeVersionSegments(versionSegments) {
  const rows = versionSegments.map((link) => link.content_segments || link.segment || link).filter(Boolean); const devices = new Set(); const countries = new Set(); const regions = new Set(); const networks = new Set(); let activeShards = rows.length ? Infinity : 0; let allRecoverable = !!rows.length; let allResilient = !!rows.length;
  for (const segment of rows) {
    const usedDomains = new Set(); let independentlyPlaced = 0;
    for (const shard of segment.segment_shards || []) {
      const placements = (shard.shard_placements || []).filter((p) => p.role === "durable" && ACTIVE_PLACEMENT_STATUSES.includes(p.status));
      const placement = placements.find((p) => !usedDomains.has(p.failure_domain_id));
      if (placement) { usedDomains.add(placement.failure_domain_id); devices.add(placement.node_id); if (placement.country_code) countries.add(placement.country_code); if (placement.region_code) regions.add(placement.region_code); if (placement.network_domain_hash) networks.add(placement.network_domain_hash); independentlyPlaced++; }
    }
    activeShards = Math.min(activeShards, independentlyPlaced);
    allRecoverable = allRecoverable && independentlyPlaced >= Number(segment.required_shards);
    allResilient = allResilient && independentlyPlaced >= Number(segment.total_shards);
  }
  return { activeShards: Number.isFinite(activeShards) ? activeShards : 0, independentNodes: devices.size, independentDevices: devices.size, countryCount: countries.size, regionCount: regions.size, networkDomainCount: networks.size, verifiedPhysicalDevices: 0, recoveryStatus: allResilient ? "resilient" : allRecoverable ? "recoverable" : devices.size > 1 ? "distributing" : "local_pending" };
}

export async function refreshPhysicalStorageTotals(vaultId, segmentId) {
  const { data: segment, error } = await appTable("content_segments").select("id,segment_shards(id,shard_hash,size_bytes,shard_placements(id,node_id,status))").eq("vault_id", vaultId).eq("id", segmentId).single();
  if (error || !segment) { if (error) throw error; return null; }
  const allocations = new Set(); let physicalBytes = 0; let physicalCopies = 0; let surplusPlacements = 0;
  for (const shard of segment.segment_shards || []) {
    for (const placement of shard.shard_placements || []) {
      if (!PHYSICAL_PLACEMENT_STATUSES.includes(placement.status)) continue;
      const key = `${placement.node_id}:${shard.shard_hash}`; if (allocations.has(key)) continue;
      allocations.add(key); physicalBytes += Number(shard.size_bytes || 0); physicalCopies += 1;
      if (["surplus", "retiring"].includes(placement.status)) surplusPlacements += 1;
    }
  }
  await appTable("content_segments").update({ physical_storage_bytes: physicalBytes }).eq("vault_id", vaultId).eq("id", segmentId);
  const { data: links } = await appTable("version_segments").select("file_version_id").eq("vault_id", vaultId).eq("content_segment_id", segmentId);
  const versionIds = [...new Set((links || []).map((link) => link.file_version_id))];
  for (const versionId of versionIds) {
    const { data: versionLinks } = await appTable("version_segments").select("content_segments(id,physical_storage_bytes,segment_shards(shard_hash,shard_placements(node_id,status)))").eq("vault_id", vaultId).eq("file_version_id", versionId);
    const seenSegments = new Set(); let versionBytes = 0; let versionCopies = 0; let versionSurplus = 0;
    for (const link of versionLinks || []) {
      const content = link.content_segments; if (!content || seenSegments.has(content.id)) continue; seenSegments.add(content.id);
      versionBytes += Number(content.physical_storage_bytes || 0);
      for (const shard of content.segment_shards || []) for (const placement of shard.shard_placements || []) {
        if (!PHYSICAL_PLACEMENT_STATUSES.includes(placement.status)) continue;
        versionCopies += 1; if (["surplus", "retiring"].includes(placement.status)) versionSurplus += 1;
      }
    }
    const values = { physical_storage_bytes: versionBytes, physical_shard_copies: versionCopies, surplus_placements: versionSurplus };
    let { error: versionError } = await appTable("file_versions").update(values).eq("vault_id", vaultId).eq("id", versionId);
    if (versionError && /physical_shard_copies|surplus_placements/i.test(`${versionError.message || ""} ${versionError.details || ""}`)) ({ error: versionError } = await appTable("file_versions").update({ physical_storage_bytes: versionBytes }).eq("vault_id", vaultId).eq("id", versionId));
    if (versionError) throw versionError;
  }
  return { physicalBytes, physicalCopies, surplusPlacements };
}

export async function auditVersionResilience(version) {
  const links = await getVersionSegments(version.vault_id, version.id); const ordinaryCutoff = Date.now() - (window.__DATA__?.resilience?.nodeStaleMs || 120000); const backboneCutoff = Date.now() - (window.__DATA__?.coordination?.supabaseBackboneLeaseMs || 900000); const proofCutoff = new Date(Date.now() - (window.__DATA__?.resilience?.proofFreshMs || 1800000)).toISOString();
  const { data: nodes, error: nodesError } = await appTable("nodes").select("id,survival_mode,lease_expires_at,last_seen_at").eq("status", "online"); if (nodesError) throw nodesError; const liveIds = new Set((nodes || []).filter((node) => Date.parse(node.last_seen_at || 0) >= (node.survival_mode ? backboneCutoff : ordinaryCutoff) && (!node.survival_mode || Date.parse(node.lease_expires_at || 0) > Date.now())).map((node) => node.id));
  const liveList = [...liveIds]; let recentlyProven = new Set();
  if (liveList.length) { const { data: proofs, error: proofError } = await appTable("shard_placements").select("node_id").eq("vault_id", version.vault_id).in("node_id", liveList).in("status", ACTIVE_PLACEMENT_STATUSES).gte("last_proof_at", proofCutoff); if (proofError) throw proofError; recentlyProven = new Set((proofs || []).map((row) => row.node_id)); }
  const activeIds = new Set(liveList.filter((id) => recentlyProven.has(id))); const offlineUpdates = [];
  const activeLinks = links.map((link) => ({ content_segments: { ...link.content_segments, segment_shards: (link.content_segments?.segment_shards || []).map((shard) => ({ ...shard, shard_placements: (shard.shard_placements || []).filter((placement) => {
    const active = activeIds.has(placement.node_id) && ACTIVE_PLACEMENT_STATUSES.includes(placement.status);
    if (!active && placement.role === "durable") {
      const next = nextOfflinePlacementState(placement, Date.now(), window.__DATA__?.resilience?.repairGraceMs || 1800000);
      if (next && (next.status !== placement.status || next.unavailableSince !== placement.unavailable_since)) offlineUpdates.push({ id: placement.id, status: next.status, unavailable_since: next.unavailableSince });
    }
    return active;
  }) })) } }));
  for (const update of offlineUpdates) {
    let { error } = await appTable("shard_placements").update({ status: update.status, unavailable_since: update.unavailable_since }).eq("id", update.id);
    if (error && /unavailable_since|suspect/i.test(`${error.message || ""} ${error.details || ""}`)) ({ error } = await appTable("shard_placements").update({ status: "unavailable" }).eq("id", update.id));
    if (error) throw error;
  }
  const summary = summarizeVersionSegments(activeLinks); if (["recoverable", "resilient", "degraded", "repairing"].includes(version.recovery_status) && !["recoverable", "resilient"].includes(summary.recoveryStatus)) summary.recoveryStatus = "degraded";
  for (let index = 0; index < links.length; index += 1) {
    const original = links[index].content_segments; const active = activeLinks[index].content_segments;
    const activeShardIds = new Set((active.segment_shards || []).filter((shard) => (shard.shard_placements || []).some((placement) => placement.role === "durable" && ACTIVE_PLACEMENT_STATUSES.includes(placement.status))).map((shard) => shard.id));
    for (const shardId of planShardRepairs(original, activeShardIds)) await queueShardRepair(version.vault_id, shardId).catch(() => {});
  }
  const repairThreshold = links.length ? Math.max(...links.map((link) => Number(link.content_segments?.repair_threshold || link.content_segments?.required_shards || 0))) : 0;
  const baseValues = { active_shards: summary.activeShards, independent_devices: summary.independentDevices, recovery_status: summary.recoveryStatus, repair_threshold_shards: repairThreshold }; const diversityValues = { country_count: summary.countryCount, region_count: summary.regionCount, network_domain_count: summary.networkDomainCount }; let { error } = await appTable("file_versions").update({ ...baseValues, ...diversityValues }).eq("id", version.id); if (error && /country_count|region_count|network_domain_count|repair_threshold_shards/i.test(`${error.message || ""} ${error.details || ""}`)) { const compatible = { ...baseValues }; delete compatible.repair_threshold_shards; ({ error } = await appTable("file_versions").update(compatible).eq("id", version.id)); } if (error) throw error; const { error: fileError } = await appTable("files").update({ status: summary.recoveryStatus }).eq("id", version.file_id); if (fileError) throw fileError; return summary;
}

export async function auditAllVersionResilience(vaultId) {
  if (!vaultId) return 0;
  const { data, error } = await appTable("file_versions").select("id,file_id,vault_id,recovery_status,files!inner(deleted_at)").eq("vault_id", vaultId).is("files.deleted_at", null); if (error) throw error; for (const version of data || []) await auditVersionResilience(version); return (data || []).length;
}

// Scoped to this vault only (indexed on shard_placements.vault_id) - never a
// network-wide scan, regardless of how many other vaults/users exist.
export async function listMyStorageNodes(vaultId) {
  const { data, error } = await appTable("shard_placements").select("node_id").eq("vault_id", vaultId).in("status", ["stored", "verified"]);
  if (error) throw error;
  return Array.from(new Set((data || []).map((row) => row.node_id)));
}

export async function loadVaultStorageSummary(vaultId) {
  const empty = { uniqueSegments: 0, uniqueOriginalBytes: 0, representationBytes: 0, compressionSavedBytes: 0, physicalBytes: 0, physicalShardCopies: 0, surplusPlacements: 0, profiles: [] };
  if (!vaultId) return empty;
  const { data, error } = await appTable("content_segments")
    .select("id,status,original_size_bytes,stored_size_bytes,required_shards,total_shards,segment_shards(shard_hash,size_bytes,shard_placements(node_id,status))")
    .eq("vault_id", vaultId).in("status", ["ready", "rebalancing", "deleting"]);
  if (error) throw error;
  const allocations = new Set(); const profileCounts = new Map(); const summary = { ...empty };
  for (const segment of data || []) {
    if (segment.status !== "deleting") {
      summary.uniqueSegments += 1;
      summary.uniqueOriginalBytes += Number(segment.original_size_bytes || 0);
      summary.representationBytes += Number(segment.stored_size_bytes || 0);
      const profile = `${Number(segment.required_shards || 0)}+${Math.max(0, Number(segment.total_shards || 0) - Number(segment.required_shards || 0))}`;
      profileCounts.set(profile, (profileCounts.get(profile) || 0) + 1);
    }
    for (const shard of segment.segment_shards || []) for (const placement of shard.shard_placements || []) {
      if (!PHYSICAL_PLACEMENT_STATUSES.includes(placement.status)) continue;
      const key = `${placement.node_id}:${shard.shard_hash}`; if (allocations.has(key)) continue;
      allocations.add(key); summary.physicalBytes += Number(shard.size_bytes || 0); summary.physicalShardCopies += 1;
      if (["surplus", "retiring"].includes(placement.status)) summary.surplusPlacements += 1;
    }
  }
  summary.compressionSavedBytes = Math.max(0, summary.uniqueOriginalBytes - summary.representationBytes);
  summary.profiles = [...profileCounts].map(([profile, segmentCount]) => ({ profile, segmentCount }));
  return summary;
}

// Per-node verified shard/byte counts for exactly one file version, scoped to
// this vault - used to size "Data locations" globe markers by real, currently
// verified placement data only (never a network-wide scan, never estimated).
// country_code/region_code/network_domain_hash are read from the placement
// row itself (recorded at storage time), not a live node lookup.
export async function listShardPlacementsForVersion(vaultId, versionId) {
  if (!vaultId || !versionId) return [];
  const { data, error } = await appTable("version_segments").select("content_segments(segment_shards(id,size_bytes,shard_placements(node_id,status,role,country_code,region_code,network_domain_hash)))").eq("vault_id", vaultId).eq("file_version_id", versionId);
  if (error) throw error;
  const byNode = new Map();
  for (const link of data || []) {
    for (const shard of link.content_segments?.segment_shards || []) {
      for (const placement of shard.shard_placements || []) {
        if (placement.role !== "durable" || !["stored", "verified"].includes(placement.status)) continue;
        const existing = byNode.get(placement.node_id) || { nodeId: placement.node_id, shardCount: 0, bytes: 0, countryCode: placement.country_code || null, regionCode: placement.region_code || null, networkDomainHash: placement.network_domain_hash || null };
        existing.shardCount += 1; existing.bytes += Number(shard.size_bytes) || 0;
        byNode.set(placement.node_id, existing);
      }
    }
  }
  return Array.from(byNode.values());
}
