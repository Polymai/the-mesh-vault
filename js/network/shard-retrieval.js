import { delayWithSignal, withRetry } from "../ui/task-state.js";
import { readSegmentErasureProfile } from "../security/manifest.js";
import { connectedProtocols } from "./peer-manager.js";
import { currentNode, propagateFragmentRequest, connectToNode } from "./node-service.js";
import { findFragment, announceHeldFragment } from "./fragment-discovery.js";
import { deleteShard } from "../storage/fragment-store.js";

function registeredOnCurrentNode(segment, shardIndex) {
  const nodeId = currentNode()?.id;
  return !!nodeId && (segment.placements || []).some(
    (placement) => Number(placement.shardIndex) === Number(shardIndex) && placement.nodeId === nodeId,
  );
}

async function removeTemporaryShard(segment, item) {
  if (!item || registeredOnCurrentNode(segment, item.index)) return;
  await deleteShard(item.shardHash).catch(() => {});
}

export async function acquireRequiredShards(segment, {
  signal,
  onProgress,
  peers = connectedProtocols(),
} = {}) {
  const profile = readSegmentErasureProfile(segment);
  const required = profile.requiredShards;
  const shardHashes = Array.isArray(segment.shardHashes) ? segment.shardHashes : [];
  const connectedNodeIds = new Set(peers.map((peer) => peer.nodeId));
  const candidates = shardHashes.map((shardHash, index) => ({
    index,
    shardHash,
    preferredNodeId: (segment.placements || []).find((placement) => Number(placement.shardIndex) === index)?.nodeId,
  })).sort((left, right) => {
    const connectedDifference = Number(connectedNodeIds.has(right.preferredNodeId)) - Number(connectedNodeIds.has(left.preferredNodeId));
    return connectedDifference || left.index - right.index;
  });
  const transfer = window.__DATA__?.transport || {};
  const maximumConcurrency = Math.max(1, Math.min(4, Number(transfer.downloadShardConcurrency) || 4));
  const peersPerRequest = Math.max(1, Math.min(4, Number(transfer.peersPerShardRequest) || 2));
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason || new DOMException("Download cancelled", "AbortError"));
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const results = new Map();
  let cursor = 0;
  let complete = false;

  const fetchCandidate = async (candidate, attemptSignal) => {
    let availablePeers = [...peers];
    if (candidate.preferredNodeId && !availablePeers.some((peer) => peer.nodeId === candidate.preferredNodeId)) {
      const preferred = await connectToNode(candidate.preferredNodeId).catch(() => null);
      if (preferred) availablePeers.unshift(preferred);
    }
    const orderedPeers = candidate.preferredNodeId
      ? availablePeers.sort((left, right) => Number(right.nodeId === candidate.preferredNodeId) - Number(left.nodeId === candidate.preferredNodeId))
      : availablePeers;
    const { bytes, source } = await findFragment(candidate.shardHash, {
      connectedPeers: orderedPeers.slice(0, peersPerRequest),
      propagate: propagateFragmentRequest,
      connectToNode,
      signal: attemptSignal,
    });
    if (!bytes) throw new Error("Shard is not reachable from the current mesh.");
    if (source && source !== "local" && registeredOnCurrentNode(segment, candidate.index)) {
      await announceHeldFragment(candidate.shardHash, currentNode()?.id).catch(() => {});
    }
    return { ...candidate, bytes };
  };

  const worker = async () => {
    while (!complete && !controller.signal.aborted) {
      const candidate = candidates[cursor];
      cursor += 1;
      if (!candidate) return;
      let item = null;
      try {
        item = await withRetry(
          (_attempt, attemptSignal) => fetchCandidate(candidate, attemptSignal),
          {
            retries: Number(transfer.retryAttempts) || 2,
            baseDelayMs: Number(transfer.retryBaseDelayMs) || 500,
            timeoutMs: Number(transfer.downloadAttemptTimeoutMs) || 120000,
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (complete) return;
        if (signal?.aborted) throw signal.reason || error;
        continue;
      }
      if (complete || controller.signal.aborted) {
        await removeTemporaryShard(segment, item);
        return;
      }
      results.set(item.index, item);
      onProgress?.({ acquired: Math.min(results.size, required), required });
      if (results.size >= required) {
        complete = true;
        controller.abort(new DOMException("Enough verified shards received", "AbortError"));
      }
    }
  };

  try {
    const initialConcurrency = Math.max(1, Math.min(maximumConcurrency - 1 || 1, candidates.length));
    const workers = Array.from({ length: initialConcurrency }, worker);
    if (maximumConcurrency > initialConcurrency && candidates.length > initialConcurrency) {
      workers.push((async () => {
        try {
          await delayWithSignal(Number(transfer.hedgedRequestDelayMs) || 1200, controller.signal);
          await worker();
        } catch (error) {
          if (!complete && signal?.aborted) throw error;
        }
      })());
    }
    await Promise.allSettled(workers);
    const selected = [...results.values()].sort((left, right) => left.index - right.index).slice(0, required);
    if (signal?.aborted) {
      await Promise.all(selected.map((item) => removeTemporaryShard(segment, item)));
      throw signal.reason || new DOMException("Download cancelled", "AbortError");
    }
    if (selected.length < required) {
      await Promise.all(selected.map((item) => removeTemporaryShard(segment, item)));
      throw new Error(`Only ${selected.length} of ${required} required shards are currently reachable.`);
    }
    return { profile, shards: selected };
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function releaseAcquiredShards(segment, shards = []) {
  await Promise.all(shards.map((item) => removeTemporaryShard(segment, item)));
}
