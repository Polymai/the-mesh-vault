const MiB = 1024 * 1024;
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
const known = (value) => typeof value === "string" && value.length > 0;

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
  const context = { domains: new Set(), countries: new Set(), regions: new Set(), networks: new Set(), nodeCounts: new Map(), totalPlacements: 0 };
  for (const placement of existingPlacements) recordPlacementChoice(context, placement);
  return context;
}

export function recordPlacementChoice(context, candidate) {
  const domain = candidate.failure_domain_id || candidate.id || candidate.node_id;
  const nodeId = candidate.id || candidate.node_id;
  if (known(domain)) context.domains.add(domain);
  if (known(candidate.country_code)) context.countries.add(candidate.country_code);
  if (known(candidate.region_code)) context.regions.add(candidate.region_code);
  if (known(candidate.network_domain_hash)) context.networks.add(candidate.network_domain_hash);
  if (known(nodeId)) context.nodeCounts.set(nodeId, (context.nodeCounts.get(nodeId) || 0) + 1);
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

export function rankPlacementCandidates(candidates, { context = createPlacementContext(), shardBytes = 0, config = (typeof window !== "undefined" ? window.__DATA__?.placement : {}) || {} } = {}) {
  return candidates.map((candidate) => {
    const domain = candidate.failure_domain_id || candidate.id;
    const storage = capacity(candidate, shardBytes, config);
    const quality = observedQuality(candidate);
    const networkNovel = known(candidate.network_domain_hash) && !context.networks.has(candidate.network_domain_hash) ? 1 : 0;
    const nodeCount = context.nodeCounts.get(candidate.id) || 0;
    const concentration = (nodeCount + 1) / Math.max(1, context.totalPlacements + 1);
    const measuredAvailability = clamp(candidate.reliability_score ?? 0.6);
    return { candidate, domain, storage, quality, vector: [geographyTier(candidate, context), networkNovel, measuredAvailability, quality.score, 1 - concentration, 1 - storage.utilization, quality.throughputBps || 0, quality.rttMs == null ? -999999 : -quality.rttMs] };
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
