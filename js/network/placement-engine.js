const MiB = 1024 * 1024;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
const known = (value) => typeof value === "string" && value.length > 0;
const nodeIdFor = (candidate) => candidate?.id || candidate?.node_id || "";
const domainFor = (candidate) => candidate?.failure_domain_id || nodeIdFor(candidate);

function stableUnitInterval(value) {
  // Two independent 32-bit accumulators provide a stable browser-safe score
  // without exposing placement to a process-local random source.
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const character of String(value || "")) {
    const code = character.charCodeAt(0);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
    right ^= right >>> 13;
  }
  const combined = ((left >>> 0) * 0x100000000) + (right >>> 0);
  return (combined + 1) / 0x10000000000000000;
}

function protocolMetrics(candidate) {
  try { return candidate?.peer?.protocol?.metrics?.() || null; } catch { return null; }
}

export function observedQuality(candidate) {
  if (candidate?.isLocal) return { score: 1, samples: Infinity, rttMs: 0, throughputBps: Infinity, rejected: false };
  const metrics = protocolMetrics(candidate);
  if (!metrics) return { score: 0.6, samples: 0, rttMs: null, throughputBps: null, rejected: false };
  const transfers = Number(metrics.successfulTransfers || 0) + Number(metrics.failedTransfers || 0);
  const proofs = Number(metrics.successfulProofs || 0) + Number(metrics.failedProofs || 0);
  const samples = transfers + proofs;
  const transferRate = transfers ? Number(metrics.successfulTransfers || 0) / transfers : 0.75;
  const proofRate = proofs ? Number(metrics.successfulProofs || 0) / proofs : 0.75;
  const score = clamp(transferRate * 0.55 + proofRate * 0.45);
  return {
    score, samples, rttMs: Number.isFinite(metrics.rttEwmaMs) ? metrics.rttEwmaMs : null,
    throughputBps: Number.isFinite(metrics.throughputEwmaBps) ? metrics.throughputEwmaBps : null,
    rejected: false,
  };
}

export function createPlacementContext(existingPlacements = []) {
  const context = {
    domains: new Set(), countries: new Set(), regions: new Set(), networks: new Set(),
    domainCounts: new Map(), countryCounts: new Map(), regionCounts: new Map(), networkCounts: new Map(),
    nodeCounts: new Map(), totalPlacements: 0,
  };
  for (const placement of existingPlacements) recordPlacementChoice(context, placement);
  return context;
}

function incrementDimension(context, setName, countName, value) {
  if (!known(value)) return;
  context[setName].add(value);
  context[countName].set(value, (context[countName].get(value) || 0) + 1);
}

function decrementDimension(context, setName, countName, value) {
  if (!known(value)) return;
  const next = Math.max(0, (context[countName].get(value) || 0) - 1);
  if (next) context[countName].set(value, next);
  else { context[countName].delete(value); context[setName].delete(value); }
}

export function recordPlacementChoice(context, candidate) {
  const domain = domainFor(candidate);
  const nodeId = nodeIdFor(candidate);
  incrementDimension(context, "domains", "domainCounts", domain);
  incrementDimension(context, "countries", "countryCounts", candidate.country_code);
  incrementDimension(context, "regions", "regionCounts", candidate.region_code);
  incrementDimension(context, "networks", "networkCounts", candidate.network_domain_hash);
  if (known(nodeId)) context.nodeCounts.set(nodeId, (context.nodeCounts.get(nodeId) || 0) + 1);
  context.totalPlacements += 1;
  return context;
}

export function releasePlacementChoice(context, candidate) {
  if (!context || context.totalPlacements <= 0) return context;
  const domain = domainFor(candidate);
  const nodeId = nodeIdFor(candidate);
  decrementDimension(context, "domains", "domainCounts", domain);
  decrementDimension(context, "countries", "countryCounts", candidate.country_code);
  decrementDimension(context, "regions", "regionCounts", candidate.region_code);
  decrementDimension(context, "networks", "networkCounts", candidate.network_domain_hash);
  if (known(nodeId)) {
    const next = Math.max(0, (context.nodeCounts.get(nodeId) || 0) - 1);
    if (next) context.nodeCounts.set(nodeId, next); else context.nodeCounts.delete(nodeId);
  }
  context.totalPlacements = Math.max(0, context.totalPlacements - 1);
  return context;
}

export function createFilePlacementContext(existingPlacements = [], { expectedPlacements = 0, candidateCount = 0 } = {}) {
  const expected = Math.max(0, Math.trunc(Number(expectedPlacements) || 0));
  const candidates = Math.max(0, Math.trunc(Number(candidateCount) || 0));
  const context = {
    nodeCounts: new Map(),
    domainCounts: new Map(),
    bytesByNode: new Map(),
    totalPlacements: 0,
    expectedPlacements: expected,
    candidateCount: candidates,
    softNodeCap: candidates ? Math.max(1, Math.ceil(expected / candidates)) : Infinity,
    recordedPlacementKeys: new Set(),
  };
  for (const placement of existingPlacements) recordFilePlacementChoice(context, placement, Number(placement.size_bytes || 0));
  return context;
}

export function recordFilePlacementChoice(context, candidate, shardBytes = 0, placementKey = null) {
  if (!context) return context;
  const nodeId = nodeIdFor(candidate);
  const domain = domainFor(candidate);
  if (!known(nodeId)) return context;
  const uniqueKey = placementKey || candidate.placement_key || candidate.placement_id || candidate.id && candidate.node_id && `${candidate.id}:${candidate.node_id}` || null;
  if (uniqueKey && context.recordedPlacementKeys.has(uniqueKey)) return context;
  if (uniqueKey) context.recordedPlacementKeys.add(uniqueKey);
  context.nodeCounts.set(nodeId, (context.nodeCounts.get(nodeId) || 0) + 1);
  if (known(domain)) context.domainCounts.set(domain, (context.domainCounts.get(domain) || 0) + 1);
  context.bytesByNode.set(nodeId, (context.bytesByNode.get(nodeId) || 0) + Math.max(0, Number(shardBytes) || 0));
  context.totalPlacements += 1;
  return context;
}

function geographyTier(candidate, context) {
  if (known(candidate.country_code) && !context.countries.has(candidate.country_code)) return 3;
  if (known(candidate.region_code) && !context.regions.has(candidate.region_code)) return 2;
  // Location is an optional edge hint. Unknown must remain neutral rather than
  // being treated as evidence that a node shares a failure domain.
  return 1;
}

function capacity(candidate, shardBytes, config) {
  const total = Math.max(0, Number(candidate.capacity_bytes || 0));
  const used = Math.max(0, Number(candidate.used_bytes || 0));
  const free = Math.max(0, total - used);
  const reserve = Math.max(Number(config.minimumReserveBytes ?? 32 * MiB), total * Number(config.reserveRatio ?? 0.05));
  const required = Math.max(Number(shardBytes || 0) * Number(config.shardHeadroomRatio ?? 1.2), Number(shardBytes || 0));
  return { total, used, free, usable: free - reserve >= required, utilization: total ? used / total : 1, headroom: Math.max(0, free - reserve) };
}

export function stablePlacementScore(placementKey, candidate, weight = 1) {
  if (!placementKey) return 0;
  const identity = domainFor(candidate) || nodeIdFor(candidate);
  const unit = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, stableUnitInterval(`${placementKey}:${identity}`)));
  return Math.max(0.01, Number(weight) || 0.01) / -Math.log(unit);
}

export function rankPlacementCandidates(candidates, {
  context = createPlacementContext(),
  fileContext = null,
  placementKey = "",
  shardBytes = 0,
  config = (typeof window !== "undefined" ? window.__DATA__?.placement : {}) || {},
} = {}) {
  return candidates.map((candidate) => {
    const nodeId = nodeIdFor(candidate);
    const domain = domainFor(candidate);
    const storage = capacity(candidate, shardBytes, config);
    const quality = observedQuality(candidate);
    const networkNovel = known(candidate.network_domain_hash) && !context.networks.has(candidate.network_domain_hash) ? 1 : 0;
    const nodeCount = context.nodeCounts.get(nodeId) || 0;
    const concentration = (nodeCount + 1) / Math.max(1, context.totalPlacements + 1);
    const measuredAvailability = clamp(candidate.reliability_score ?? 0.6);
    const fileNodeCount = fileContext?.nodeCounts.get(nodeId) || 0;
    const fileDomainCount = fileContext?.domainCounts.get(domain) || 0;
    const fileBytes = fileContext?.bytesByNode.get(nodeId) || 0;
    const withinFileCap = !fileContext || fileNodeCount < fileContext.softNodeCap ? 1 : 0;
    const unusedByFile = fileNodeCount === 0 ? 1 : 0;
    const fileBalance = 1 / (1 + fileNodeCount);
    const fileByteBalance = 1 / (1 + fileBytes / MiB);
    const domainBalance = 1 / (1 + fileDomainCount);
    const capacityWeight = clamp(storage.total ? storage.headroom / storage.total : 0, 0.05, 1);
    const rendezvousWeight = 0.2 + measuredAvailability * 0.35 + quality.score * 0.3 + capacityWeight * 0.15;
    const rendezvous = stablePlacementScore(placementKey, candidate, rendezvousWeight);
    return {
      candidate,
      domain,
      storage,
      quality,
      vector: [
        withinFileCap,
        unusedByFile,
        geographyTier(candidate, context),
        networkNovel,
        fileBalance,
        fileByteBalance,
        domainBalance,
        rendezvous,
        measuredAvailability,
        quality.score,
        1 - concentration,
        1 - storage.utilization,
        quality.throughputBps || 0,
        quality.rttMs == null ? -999999 : -quality.rttMs,
      ],
    };
  }).filter((entry) => !context.domains.has(entry.domain) && entry.storage.usable && (entry.quality.samples < Number(config.qualityRejectAfterSamples ?? 3) || entry.quality.score >= Number(config.minimumObservedQuality ?? 0.5)))
    .sort((left, right) => {
      for (let index = 0; index < left.vector.length; index += 1) if (left.vector[index] !== right.vector[index]) return right.vector[index] - left.vector[index];
      return String(left.candidate.id).localeCompare(String(right.candidate.id));
    }).map((entry) => ({ ...entry.candidate, placementQuality: entry.quality, placementCapacity: entry.storage }));
}

export function placementDiversity(placements = []) {
  const active = placements.filter((placement) => placement.role === "durable" && ["stored", "verified"].includes(placement.status));
  return {
    countryCount: new Set(active.map((placement) => placement.country_code).filter(known)).size,
    regionCount: new Set(active.map((placement) => placement.region_code).filter(known)).size,
    networkDomainCount: new Set(active.map((placement) => placement.network_domain_hash).filter(known)).size,
  };
}
