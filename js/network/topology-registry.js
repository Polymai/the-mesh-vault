const STALE_MS = 2 * 60 * 1000;
const observations = new Map();

export function recordTopologyObservation({ nodeId, devicePublicKey, connectedNodeIds = [], observedAt = Date.now() }) {
  if (!nodeId || !devicePublicKey) return false;
  const peers = Array.from(new Set((Array.isArray(connectedNodeIds) ? connectedNodeIds : []).filter((id) => typeof id === "string" && id && id !== nodeId)))
    .sort()
    .slice(0, 64);
  const previous = observations.get(nodeId);
  const changed = !previous
    || previous.devicePublicKey !== devicePublicKey
    || previous.connectedNodeIds.length !== peers.length
    || previous.connectedNodeIds.some((peerId, index) => peerId !== peers[index]);
  const observedAtMs = Number.isFinite(Number(observedAt)) ? Number(observedAt) : Date.parse(observedAt) || Date.now();
  observations.set(nodeId, { nodeId, devicePublicKey, connectedNodeIds: peers, observedAt: observedAtMs });
  if (changed) window.dispatchEvent(new CustomEvent("meshvault:topology-updated", { detail: { nodeId, reason: previous ? "connections-changed" : "node-added" } }));
  return changed;
}

export function listTopologyObservations() {
  const cutoff = Date.now() - STALE_MS;
  let removed = false;
  for (const [nodeId, observation] of observations) {
    if (observation.observedAt >= cutoff) continue;
    observations.delete(nodeId);
    removed = true;
  }
  if (removed) queueMicrotask(() => window.dispatchEvent(new CustomEvent("meshvault:topology-updated", { detail: { reason: "expired" } })));
  return Array.from(observations.values());
}

export function clearTopologyObservations() {
  observations.clear();
}
