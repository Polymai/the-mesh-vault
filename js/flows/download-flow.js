import { createTask } from "../ui/task-state.js";
import { getFileBundle, markExactRecovery } from "../services/metadata-service.js";
import { reconstructShards } from "../security/erasure.js";
import { unwrapSegmentKey, decryptBytes, decryptJson, hashBytes } from "../security/keyring.js";
import { decompressSegment } from "../security/compression.js";
import { Sha256Stream } from "../vendor/sha256-stream.js";
import { recordAudit } from "../services/audit-service.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { currentNode, propagateManifestRequest, propagateFragmentRequest, connectToNode } from "../network/node-service.js";
import { findManifest } from "../network/manifest-discovery.js";
import { findFragment, announceHeldFragment } from "../network/fragment-discovery.js";
import { deleteShard } from "../storage/fragment-store.js";

async function createStreamingSink(file) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: file.name, types: [{ description: "Original file", accept: { [file.mime || "application/octet-stream"]: [`.${file.name.split(".").pop() || "bin"}`] } }] });
      const writable = await handle.createWritable(); return { write: (bytes) => writable.write(bytes), close: () => writable.close(), abort: () => writable.abort() };
    } catch (error) { if (error.name === "AbortError") throw error; }
  }
  if (!navigator.storage?.getDirectory) throw new Error("This browser cannot stream a large download to disk. Use a browser with File System Access or OPFS support.");
  const root = await navigator.storage.getDirectory(); const tempName = `meshvault-download-${crypto.randomUUID()}.tmp`; const handle = await root.getFileHandle(tempName, { create: true }); const writable = await handle.createWritable();
  return {
    write: (bytes) => writable.write(bytes), abort: async () => { await writable.abort().catch(() => {}); await root.removeEntry(tempName).catch(() => {}); },
    close: async () => { await writable.close(); const stored = await handle.getFile(); const url = URL.createObjectURL(stored); const link = document.createElement("a"); link.href = url; link.download = file.name; link.click(); window.setTimeout(() => { URL.revokeObjectURL(url); root.removeEntry(tempName).catch(() => {}); }, 60000); },
  };
}

async function acquireShards(segment, connectedPeers) {
  const required = Number(segment.requiredShards);
  const connectedNodeIds = new Set(connectedPeers.map((peer) => peer.nodeId));
  const candidates = segment.shardHashes.map((shardHash, index) => ({
    index, shardHash,
    preferredNodeId: (segment.placements || []).find((placement) => Number(placement.shardIndex) === index)?.nodeId,
  }));
  const fetchCandidate = async ({ index, shardHash, preferredNodeId }) => {
    let availablePeers = [...connectedPeers];
    if (preferredNodeId && !availablePeers.some((peer) => peer.nodeId === preferredNodeId)) {
      const preferred = await connectToNode(preferredNodeId).catch(() => null);
      if (preferred) availablePeers.unshift(preferred);
    }
    const orderedPeers = preferredNodeId
      ? availablePeers.sort((left, right) => Number(right.nodeId === preferredNodeId) - Number(left.nodeId === preferredNodeId))
      : availablePeers;
    const { bytes, source } = await findFragment(shardHash, { connectedPeers: orderedPeers, propagate: propagateFragmentRequest, connectToNode });
    if (!bytes) return null;
    if (source && source !== "local") await announceHeldFragment(shardHash, currentNode()?.id).catch(() => {});
    return { index, bytes, shardHash };
  };
  const connectedCandidates = candidates.filter((candidate) => connectedNodeIds.has(candidate.preferredNodeId));
  const firstWave = connectedCandidates.slice(0, required);
  if (firstWave.length < required) {
    const included = new Set(firstWave.map((candidate) => candidate.index));
    firstWave.push(...candidates.filter((candidate) => !included.has(candidate.index)));
  }
  let available = (await Promise.all(firstWave.map(fetchCandidate))).filter(Boolean);
  if (available.length < required && firstWave.length < candidates.length) {
    const attempted = new Set(firstWave.map((candidate) => candidate.index));
    available.push(...(await Promise.all(candidates.filter((candidate) => !attempted.has(candidate.index)).map(fetchCandidate))).filter(Boolean));
  }
  available.sort((left, right) => left.index - right.index);
  const selected = available.slice(0, required);
  const discarded = available.slice(required);
  for (const item of discarded) {
    const registeredHere = (segment.placements || []).some((placement) => placement.shardIndex === item.index && placement.nodeId === currentNode()?.id);
    if (!registeredHere) await deleteShard(item.shardHash).catch(() => {});
  }
  if (selected.length < required) {
    for (const item of selected) {
      const registeredHere = (segment.placements || []).some((placement) => placement.shardIndex === item.index && placement.nodeId === currentNode()?.id);
      if (!registeredHere) await deleteShard(item.shardHash).catch(() => {});
    }
    throw new Error(`Only ${selected.length} of ${required} required shards are currently reachable.`);
  }
  return selected;
}

export async function downloadFile(fileId, { vaultIdentity } = {}) {
  const task = createTask("Recovering file segment by segment", 6 * 60 * 60 * 1000); let sink = null; let vaultId = null;
  try {
    vaultId = vaultIdentity?.vaultId;
    if (!vaultId) throw new Error("Open this file from its owning vault.");
    const bundle = await getFileBundle(vaultId, fileId);
    if (!bundle.version.manifest_id) throw new Error("This file has no published manifest yet.");
    const { envelope: manifest } = await findManifest(bundle.version.manifest_id, {
      connectedPeers: connectedProtocols(), propagate: propagateManifestRequest,
      verifyOpts: { supportedManifestVersions: [2], supportedStorageVersions: [1, 2] },
    });
    if (!manifest) throw new Error("This file's manifest could not be found locally, from peers, or from the bootstrap provider.");
    if (manifest.vaultId !== vaultId) throw new Error("The manifest does not belong to this vault.");
    sink = await createStreamingSink(bundle.file); const wholeHash = new Sha256Stream(); let recovered = 0;
    for (let index = 0; index < manifest.segments.length; index++) {
      const segment = manifest.segments[index];
      const available = await acquireShards(segment, connectedProtocols());
      const cipher = await reconstructShards(available, Number(segment.cipherSize), Number(segment.dataShards), task.signal);
      for (const item of available) {
        const registeredHere = (segment.placements || []).some((placement) => placement.shardIndex === item.index && placement.nodeId === currentNode()?.id);
        if (!registeredHere) await deleteShard(item.shardHash).catch(() => {});
      }
      if ((await hashBytes(cipher)) !== segment.cipherHash) throw new Error(`Segment ${index + 1} failed ciphertext verification.`);
      const privateMetadata = await decryptJson(segment.encryptedPrivateMetadata); const key = await unwrapSegmentKey(segment.wrappedSegmentKey); const representation = await decryptBytes(cipher, key, privateMetadata.aad); key.fill(0);
      const plain = await decompressSegment(representation, segment.compression); if (plain.byteLength !== Number(segment.originalSize) || (await hashBytes(plain)) !== privateMetadata.plainHash) throw new Error(`Segment ${index + 1} did not reproduce its original bytes.`);
      wholeHash.update(plain); await sink.write(plain); recovered += plain.byteLength; task.progress(recovered / Math.max(1, Number(manifest.originalSize)), `Verified segment ${index + 1} of ${manifest.segments.length}`);
    }
    if (recovered !== manifest.originalSize || wholeHash.hex() !== manifest.originalHash) throw new Error("The restored file did not match the original byte for byte.");
    await sink.close(); sink = null; await markExactRecovery(vaultId, bundle.version.id); task.done("Exact recovery verified"); await recordAudit(vaultId, "file.download", "success", { fileId, bytes: recovered, exactRecovery: true }).catch(() => {}); return true;
  } catch (error) { await sink?.abort?.().catch(() => {}); task.fail(error); await recordAudit(vaultId, "file.download", "failure", { fileId }).catch(() => {}); throw error; }
}
