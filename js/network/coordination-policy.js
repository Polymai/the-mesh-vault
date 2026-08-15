export const COORDINATION_MODES = Object.freeze({
  SUPABASE_PRIMARY: "supabase-primary",
  HYBRID: "hybrid",
  ANCHOR_PRIMARY: "anchor-primary",
  MESH_DEGRADED: "mesh-degraded",
  ISOLATED: "isolated",
});

export const DEFAULT_COORDINATION_CONFIG = Object.freeze({
  targetAnchors: 3,
  minimumMeshAnchors: 1,
  reserveAnchors: 2,
  anchorStableMs: 120000,
  maximumPeerConnections: 4,
  minimumPeerCandidates: 4,
  discoveryCacheMs: 300000,
  backboneDiscoveryRefreshMs: 600000,
  supabaseHeartbeatMs: 600000,
  anchorPrimaryHeartbeatMs: 120000,
  anchorHeartbeatMs: 120000,
  supabaseBackboneHeartbeatMs: 600000,
  anchorBackboneHeartbeatMs: 600000,
  operationBackboneFlushMs: 300000,
  heartbeatJitterRatio: 0.15,
  minimumMeshParticipants: 2,
  minimumBackbonePeers: 1,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  // Final avalanche prevents sequential node identifiers from clustering in
  // adjacent rendezvous ranges while preserving deterministic assignments.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function candidateId(candidate) {
  return candidate?.nodeId || candidate?.peerId || candidate?.id || "";
}

export function isHealthyAnchor(candidate, now = Date.now()) {
  const capabilities = candidate?.capabilities || [];
  const advertised = capabilities.includes("anchor-control-v3");
  const protocol = Number(candidate?.anchorProtocolVersion ?? candidate?.anchor_protocol_version ?? 0);
  if (!advertised || protocol < 3 || !candidateId(candidate)) return false;
  const lease = candidate?.leaseExpiresAt || candidate?.lease_expires_at;
  return !lease || Date.parse(lease) > now;
}

export function isHealthyControlParticipant(candidate, now = Date.now()) {
  const capabilities = candidate?.capabilities || [];
  const advertised = capabilities.includes("mesh-control-lite-v3")
    || capabilities.includes("mesh-backbone-v3")
    || capabilities.includes("anchor-control-v3");
  if (!advertised || Number(candidate?.protocolVersion || 3) < 3 || !candidateId(candidate)) return false;
  const lease = candidate?.leaseExpiresAt || candidate?.lease_expires_at;
  return !lease || Date.parse(lease) > now;
}

export function isHealthyBackbone(candidate, now = Date.now()) {
  return isHealthyControlParticipant(candidate, now)
    && (candidate?.capabilities || []).includes("mesh-backbone-v3");
}

function rendezvousScore(nodeId, candidate) {
  const id = candidateId(candidate);
  const reliability = Math.max(0, Math.min(1, finite(candidate?.reliabilityScore ?? candidate?.reliability_score, 0.5)));
  const capacity = Math.max(0, finite(candidate?.anchorControlCapacityBytes ?? candidate?.anchor_control_capacity_bytes, 0));
  const used = Math.max(0, finite(candidate?.anchorControlUsedBytes ?? candidate?.anchor_control_used_bytes, 0));
  const load = Math.max(0, finite(candidate?.anchorConnectedNodes ?? candidate?.anchor_connected_nodes, 0));
  const freeRatio = capacity > 0 ? Math.max(0, Math.min(1, (capacity - used) / capacity)) : 0.5;
  const loadFactor = 1 / (1 + load / 100);
  const stable = stableHash(`${nodeId}:${id}`) / 0xffffffff;
  return stable * 0.55 + reliability * 0.25 + freeRatio * 0.12 + loadFactor * 0.08;
}

export function selectAnchorAssignments(candidates = [], nodeId, options = {}) {
  const config = { ...DEFAULT_COORDINATION_CONFIG, ...options };
  const count = Math.max(1, config.targetAnchors + config.reserveAnchors);
  const unique = new Map();
  for (const candidate of candidates) {
    const id = candidateId(candidate);
    if (!id || id === nodeId || !isHealthyAnchor(candidate, options.now)) continue;
    if (!unique.has(id)) unique.set(id, candidate);
  }
  const ranked = Array.from(unique.values()).sort((left, right) => rendezvousScore(nodeId, right) - rendezvousScore(nodeId, left));
  const selected = [];
  const domains = new Set();
  const countries = new Set();
  while (selected.length < count && ranked.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < ranked.length; index += 1) {
      const candidate = ranked[index];
      const domain = candidate.failureDomainId || candidate.failure_domain_id || candidate.browserProfileDomain || candidateId(candidate);
      const country = candidate.countryCode || candidate.country_code || "";
      const diversity = (domains.has(domain) ? 0 : 2) + (country && !countries.has(country) ? 0.5 : 0);
      const score = diversity + rendezvousScore(nodeId, candidate);
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    const [chosen] = ranked.splice(bestIndex, 1);
    selected.push(chosen);
    domains.add(chosen.failureDomainId || chosen.failure_domain_id || chosen.browserProfileDomain || candidateId(chosen));
    if (chosen.countryCode || chosen.country_code) countries.add(chosen.countryCode || chosen.country_code);
  }
  return {
    primary: selected.slice(0, config.targetAnchors),
    reserve: selected.slice(config.targetAnchors, count),
  };
}

export function evaluateCoordination(previous = {}, observation = {}, options = {}) {
  const config = { ...DEFAULT_COORDINATION_CONFIG, ...options };
  const now = finite(observation.now, Date.now());
  const anchorCount = Math.max(0, Math.trunc(finite(observation.anchorCount, 0)));
  const participantCount = Math.max(anchorCount, Math.trunc(finite(observation.participantCount, anchorCount)));
  const backboneCount = Math.max(0, Math.trunc(finite(observation.backboneCount, 0)));
  const supabaseUp = observation.supabaseUp !== false;
  const enoughForPrimary = backboneCount >= config.minimumBackbonePeers
    || participantCount >= config.minimumMeshParticipants;
  const anchorStableSince = enoughForPrimary
    ? (previous.anchorStableSince == null ? now : finite(previous.anchorStableSince, now))
    : null;
  const stableFor = anchorStableSince == null ? 0 : now - anchorStableSince;
  let mode;
  if (!supabaseUp) {
    mode = participantCount >= config.minimumMeshAnchors ? COORDINATION_MODES.MESH_DEGRADED : COORDINATION_MODES.ISOLATED;
  } else if (enoughForPrimary && stableFor >= config.anchorStableMs) {
    mode = COORDINATION_MODES.ANCHOR_PRIMARY;
  } else if (participantCount >= config.minimumMeshAnchors) {
    mode = COORDINATION_MODES.HYBRID;
  } else {
    mode = COORDINATION_MODES.SUPABASE_PRIMARY;
  }
  return {
    mode,
    anchorCount,
    participantCount,
    backboneCount,
    anchorStableSince,
    stableForMs: stableFor,
    supabaseUp,
    fallbackActive: mode === COORDINATION_MODES.SUPABASE_PRIMARY || mode === COORDINATION_MODES.HYBRID,
    changedAt: mode === previous.mode ? previous.changedAt || now : now,
  };
}

export function providerOrder(mode, kind) {
  const anchorFirst = ["local-peer", "anchor-peer", "backbone-seed", "invite-link", "supabase"];
  const supabaseFirst = ["local-peer", "backbone-seed", "anchor-peer", "invite-link", "supabase"];
  const meshOnly = ["local-peer", "anchor-peer", "backbone-seed", "invite-link"];
  if (mode === COORDINATION_MODES.ANCHOR_PRIMARY) return meshOnly;
  if (mode === COORDINATION_MODES.HYBRID) return anchorFirst;
  if (mode === COORDINATION_MODES.MESH_DEGRADED || mode === COORDINATION_MODES.ISOLATED) return meshOnly;
  return supabaseFirst;
}

export function heartbeatIntervalMs(mode, isAnchor, options = {}) {
  const config = { ...DEFAULT_COORDINATION_CONFIG, ...options };
  if (isAnchor) return config.anchorHeartbeatMs;
  if (mode === COORDINATION_MODES.ANCHOR_PRIMARY || mode === COORDINATION_MODES.MESH_DEGRADED) return config.anchorPrimaryHeartbeatMs;
  return config.supabaseHeartbeatMs;
}

export function shouldWriteSupabaseHeartbeat(mode, isAnchor, lastWriteAt = 0, now = Date.now(), options = {}) {
  const config = { ...DEFAULT_COORDINATION_CONFIG, ...options };
  if (mode === COORDINATION_MODES.MESH_DEGRADED || mode === COORDINATION_MODES.ISOLATED) return false;
  const interval = isAnchor
    ? config.anchorBackboneHeartbeatMs
    : mode === COORDINATION_MODES.ANCHOR_PRIMARY
      ? config.supabaseBackboneHeartbeatMs
      : config.supabaseHeartbeatMs;
  return now - Math.max(0, finite(lastWriteAt, 0)) >= Math.max(10000, finite(interval, 90000));
}

export function jitteredInterval(intervalMs, random = Math.random, options = {}) {
  const config = { ...DEFAULT_COORDINATION_CONFIG, ...options };
  const ratio = Math.max(0, Math.min(0.5, finite(config.heartbeatJitterRatio, 0.15)));
  return Math.round(intervalMs * (1 - ratio + random() * ratio * 2));
}
