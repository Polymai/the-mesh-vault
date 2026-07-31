const STALE_MS = 2 * 60 * 1000;
const observations = new Map();

export function recordTopologyObservation({ nodeId, devicePublicKey, connectedNodeIds = [], observedAt = Date.now() }) {
  if (!nodeId || !devicePublicKey) return;
  const peers = Array.from(new Set((Array.isArray(connectedNodeIds) ? connectedNodeIds : []).filter((id) => typeof id === "string" && id && id !== nodeId))).slice(0, 64);
  observations.set(nodeId, { nodeId, devicePublicKey, connectedNodeIds: peers, observedAt });
  window.dispatchEvent(new CustomEvent("meshvault:topology-updated", { detail: { nodeId } }));
}

export function listTopologyObservations() {
  const cutoff = Date.now() - STALE_MS;
  for (const [nodeId, observation] of observations) if (observation.observedAt < cutoff) observations.delete(nodeId);
  return Array.from(observations.values());
}

export function clearTopologyObservations() {
  observations.clear();
}
