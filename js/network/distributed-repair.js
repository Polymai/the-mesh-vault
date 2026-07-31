import { publishControlObject, queryAnchors } from "./anchor-service.js";

const REQUEST_TTL_MS = 30 * 60 * 1000;
const LEASE_TTL_MS = 2 * 60 * 1000;
const COMPLETE_TTL_MS = 30 * 86400000;

function validRequest(request) {
  return request?.vaultId && request?.shardId
    && Number(request.expiresAt || 0) > Date.now();
}

export async function publishRepairAdvisory(request) {
  if (!request?.vaultId || !request?.shardId) return null;
  const payload = {
    ...request,
    requestId: request.requestId || crypto.randomUUID(),
    requestedAt: Number(request.requestedAt) || Date.now(),
    expiresAt: Number(request.expiresAt) || Date.now() + REQUEST_TTL_MS,
  };
  const object = await publishControlObject("repair-request", "open", payload, REQUEST_TTL_MS);
  return { payload, replicaCount: Number(object?.replicaCount || 0) };
}

export async function listRepairAdvisories(vaultId, limit = 50) {
  const [rows, completions] = await Promise.all([
    queryAnchors("repair-request", "open", limit).catch(() => []),
    vaultId ? queryAnchors("repair-complete", vaultId, limit * 2).catch(() => []) : Promise.resolve([]),
  ]);
  const completedRequestIds = new Set(completions.map((row) => row?.payload?.requestId).filter(Boolean));
  const byRequest = new Map();
  for (const row of rows) {
    const request = row?.payload;
    if (!validRequest(request) || (vaultId && request.vaultId !== vaultId)) continue;
    if (completedRequestIds.has(request.requestId)) continue;
    if (!byRequest.has(request.requestId)) byRequest.set(request.requestId, request);
  }
  return [...byRequest.values()].sort((left, right) => Number(left.requestedAt) - Number(right.requestedAt));
}

export async function claimDistributedRepairLease(request, workerNodeId) {
  if (!validRequest(request) || !workerNodeId) return { acquired: false, reason: "invalid_request" };
  const payload = {
    requestId: request.requestId,
    vaultId: request.vaultId,
    shardId: request.shardId,
    workerNodeId,
    leaseId: crypto.randomUUID(),
    createdAt: Date.now(),
    expiresAt: Date.now() + LEASE_TTL_MS,
  };
  const published = await publishControlObject("repair-lease", request.shardId, payload, LEASE_TTL_MS).catch(() => null);
  if (!published || Number(published.replicaCount || 0) < 1) return { acquired: false, reason: "no_anchor_quorum" };
  await new Promise((resolve) => setTimeout(resolve, 120));
  const rows = await queryAnchors("repair-lease", request.shardId, 30).catch(() => []);
  const candidates = rows.map((row) => row.payload).filter((lease) => (
    lease?.requestId === request.requestId
    && lease?.vaultId === request.vaultId
    && lease?.shardId === request.shardId
    && Number(lease.expiresAt || 0) > Date.now()
  ));
  candidates.push(payload);
  const winner = candidates.sort((left, right) => (
    Number(left.createdAt) - Number(right.createdAt)
    || String(left.workerNodeId).localeCompare(String(right.workerNodeId))
    || String(left.leaseId).localeCompare(String(right.leaseId))
  ))[0];
  return {
    acquired: winner?.leaseId === payload.leaseId,
    lease: winner || payload,
    reason: winner?.leaseId === payload.leaseId ? null : "lease_lost",
  };
}

export async function publishRepairCompletion(request, workerNodeId, targetNodeId = null) {
  if (!request?.requestId || !request?.vaultId || !request?.shardId || !workerNodeId) return null;
  return publishControlObject("repair-complete", request.vaultId, {
    requestId: request.requestId,
    vaultId: request.vaultId,
    shardId: request.shardId,
    workerNodeId,
    targetNodeId,
    completedAt: Date.now(),
  }, COMPLETE_TTL_MS);
}
