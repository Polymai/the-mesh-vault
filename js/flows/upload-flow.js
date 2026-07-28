import { createTask } from "../ui/task-state.js";
import { createSegmentKey, dedupFingerprint, encryptBytes, encryptJson, hashBytes, bytesToBase64 } from "../security/keyring.js";
import { streamFileSegments } from "../security/segmenter.js";
import { compressAdaptive } from "../security/compression.js";
import { Sha256Stream } from "../vendor/sha256-stream.js";
import { encodeShards } from "../security/erasure.js";
import { putShard, getShard, deleteShard } from "../storage/fragment-store.js";
import { createFileRecord, createFileVersion, finalizeFileVersion, setFileStatus } from "../services/metadata-service.js";
import { chooseErasureProfile, loadPlacementCandidates, findReusableSegment, createContentSegment, incrementSegmentReference, updateSegmentPhysicalBytes, markSegmentReady, registerSegmentShards, recordShardPlacement, linkVersionSegment, queueShardRepair, summarizeVersionSegments } from "../services/segment-service.js";
import { appTable } from "../services/supabase.js";
import { currentNode } from "../network/node-service.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { recordAudit } from "../services/audit-service.js";
import { buildManifestV2 } from "../security/manifest.js";
import { saveManifestLocally } from "../network/manifest-discovery.js";
import { announceManifest } from "../network/providers/provider-registry.js";
import { appendOperation } from "../oplog/oplog-engine.js";
import { OP_TYPES } from "../oplog/operation-types.js";
import {
  createFilePlacementContext,
  createPlacementContext,
  rankPlacementCandidates,
  recordFilePlacementChoice,
  recordPlacementChoice,
} from "../network/placement-engine.js";

const aadFor = (fingerprint) => `meshvault-segment-v1:${fingerprint}`;
async function storeLocalVerified(shardHash, bytes, expectedHash) { await putShard(shardHash, bytes); const stored = await getShard(shardHash); if (!stored || (await hashBytes(stored)) !== expectedHash) { await deleteShard(shardHash).catch(() => {}); throw new Error("Local shard storage failed verification."); } }

function segmentManifestEntry(segment, privateMetadataEnvelope) {
  return {
    segmentId: segment.id, originalSize: Number(segment.original_size_bytes), storedSize: Number(segment.stored_size_bytes), cipherSize: Number(segment.cipher_size_bytes),
    codingGeneration: Number(segment.coding_generation || 1),
    compression: segment.compression_method, dataShards: segment.data_shards, parityShards: segment.parity_shards,
    requiredShards: segment.required_shards, repairThreshold: segment.repair_threshold || segment.required_shards, totalShards: segment.total_shards, cipherHash: segment.cipher_hash,
    wrappedSegmentKey: segment.wrapped_segment_key, encryptedPrivateMetadata: privateMetadataEnvelope,
    shardHashes: (segment.segment_shards || []).map((shard) => shard.shard_hash),
    placements: (segment.segment_shards || []).flatMap((shard) => (shard.shard_placements || [])
      .filter((placement) => ["stored", "verified"].includes(placement.status))
      .map((placement) => ({ shardIndex: shard.shard_index, nodeId: placement.node_id, failureDomain: placement.failure_domain_id, role: placement.role }))),
  };
}
async function replicateManifestToPeers(manifestId, envelope, peers, targetCount = 3) {
  await Promise.all(peers.slice(0, targetCount).map((peer) => peer.protocol.sendManifest(manifestId, envelope).catch(() => {})));
}

export async function uploadFile(file, { vaultIdentity, folderId = null, resilienceClass = "standard" } = {}) {
  const max = window.__DATA__.limits.maxUploadBytes;
  if (!file || file.size > max) throw new Error(`Files must be ${Math.round(max / 1000000)} MB or smaller.`);
  const vaultId = vaultIdentity.vaultId;
  const signer = { publicKey: vaultIdentity.ownerPublicKey, algorithm: vaultIdentity.algorithm, sign: vaultIdentity.sign };
  const segmentTarget = window.__DATA__.segments.targetBytes; const totalSegments = Math.max(1, Math.ceil(file.size / segmentTarget));
  const task = createTask(`Securing ${file.name}`, 6 * 60 * 60 * 1000, { kind: "upload", fileName: file.name, fileSize: file.size, phase: "preparing", segmentIndex: 1, totalSegments, preventUnload: true }); let record = null; let transferId = null; let buildingSegmentId = null; let buildingShardHashes = []; let cleanupPeers = [];
  try {
    task.phase("preparing", "Creating the encrypted upload record", { progress: .01 });
    const transfer = await appTable("transfers").insert({ vault_id: vaultId, direction: "upload", status: "running", bytes_total: file.size }).select().single(); if (transfer.error) throw transfer.error; transferId = transfer.data.id;
    record = await createFileRecord({ vaultId, folderId, metadata: { name: file.name, mime: file.type || "application/octet-stream", modified: file.lastModified }, sizeBytes: file.size });
    await appTable("transfers").update({ file_id: record.id }).eq("vault_id", vaultId).eq("id", transferId);
    const version = await createFileVersion({ vaultId, fileId: record.id, originalSizeBytes: file.size });
    const node = currentNode(); if (!node || node.status !== "online") throw new Error("Enable this device before uploading a file."); const peers = connectedProtocols(); cleanupPeers = peers; const candidates = await loadPlacementCandidates(node, peers); const profile = chooseErasureProfile(candidates.length, resilienceClass);
    const filePlacementContext = createFilePlacementContext([], { expectedPlacements: totalSegments * profile.totalShards, candidateCount: candidates.length });
    const wholeHash = new Sha256Stream(); const manifestSegments = []; const summaryLinks = []; const physicalSeen = new Set();
    let processed = 0, representationSize = 0, physicalStorage = 0, compressionSaved = 0, minimumRequired = 0, repairThreshold = 0, totalShards = 0, physicalShardCopies = 0;
    const reportRead = ({ segmentIndex, segmentBytes }) => {
      const base = processed / Math.max(1, file.size); const span = Math.min(segmentTarget, Math.max(0, file.size - processed)) / Math.max(1, file.size);
      task.phase("reading", `Reading segment ${segmentIndex + 1}`, { segmentIndex: segmentIndex + 1, progress: Math.min(.9, base + span * .08 * Math.min(1, segmentBytes / segmentTarget)) });
    };
    for await (const input of streamFileSegments(file, segmentTarget, reportRead)) {
      if (task.signal.aborted) throw new DOMException("Operation cancelled", "AbortError");
      const plain = input.bytes; const segmentNumber = input.index + 1; const baseProgress = processed / Math.max(1, file.size); const segmentShare = plain.byteLength / Math.max(1, file.size); const stageProgress = (fraction) => Math.min(.94, baseProgress + segmentShare * fraction);
      wholeHash.update(plain); const fingerprint = await dedupFingerprint(plain); let segment = await findReusableSegment(vaultId, fingerprint); let privateMetadataEnvelope; let created = false;
      if (segment) {
        task.phase("sending", "Reusing an already verified encrypted segment", { segmentIndex: segmentNumber, progress: stageProgress(.9) });
        segment = await incrementSegmentReference(vaultId, segment); privateMetadataEnvelope = segment.encrypted_private_metadata;
        for (const shard of segment.segment_shards || []) for (const placement of shard.shard_placements || []) {
          if (placement.role !== "durable" || !["stored", "verified", "surplus"].includes(placement.status)) continue;
          recordFilePlacementChoice(filePlacementContext, placement, Number(shard.size_bytes || 0), placement.id);
        }
      } else {
        task.phase("compressing", "Checking whether compression reduces this segment", { segmentIndex: segmentNumber, progress: stageProgress(.12) });
        const plainHash = await hashBytes(plain); const compressed = await compressAdaptive(plain, { name: file.name, mime: file.type, minimumSavings: window.__DATA__.segments.minimumSavings });
        const compressionMessage = compressed.method === "none" ? "Compression skipped; encrypting original bytes" : `Compressed ${Math.round(compressed.savings * 100)}%; encrypting smaller representation`;
        task.phase("encrypting", compressionMessage, { segmentIndex: segmentNumber, progress: stageProgress(.3) });
        const { raw, wrapped } = await createSegmentKey(); const cipher = await encryptBytes(compressed.bytes, raw, aadFor(fingerprint)); raw.fill(0);
        const cipherHash = await hashBytes(cipher); const privateMetadata = { plainHash, nonce: bytesToBase64(cipher.slice(0, 12)), aad: aadFor(fingerprint) };
        privateMetadataEnvelope = await encryptJson(privateMetadata, "segment-private-metadata-v1");
        segment = await createContentSegment({ vault_id: vaultId, dedup_fingerprint: fingerprint, format_version: window.__DATA__.storageFormatVersion, coding_generation: 1, original_size_bytes: plain.byteLength, stored_size_bytes: compressed.bytes.byteLength, cipher_size_bytes: cipher.byteLength, compression_method: compressed.method, cipher_hash: cipherHash, wrapped_segment_key: wrapped, encrypted_private_metadata: privateMetadataEnvelope, data_shards: profile.dataShards, parity_shards: profile.parityShards, required_shards: profile.requiredShards, repair_threshold: profile.repairThreshold, total_shards: profile.totalShards }); created = true; buildingSegmentId = segment.id;
        task.phase("sharding", `Creating ${profile.dataShards} data and ${profile.parityShards} recovery shards`, { segmentIndex: segmentNumber, progress: stageProgress(.48) });
        const layout = await encodeShards(cipher, profile.dataShards, profile.parityShards, task.signal);
        const shardPayloads = await Promise.all(layout.shards.map(async (bytes) => ({ bytes: new Uint8Array(bytes), hash: await hashBytes(bytes) })));
        const shardRows = await registerSegmentShards(vaultId, segment.id, shardPayloads, 1); buildingShardHashes = shardRows.map((shard) => shard.shard_hash); const placementContext = createPlacementContext(); let physical = 0; const placementRows = [];
        for (let index = 0; index < shardRows.length; index++) {
          if (task.signal.aborted) throw task.signal.reason || new DOMException("Operation cancelled", "AbortError");
          task.phase("sending", `Sending and verifying shard ${index + 1} of ${shardRows.length}`, { segmentIndex: segmentNumber, progress: stageProgress(.55 + ((index + 1) / shardRows.length) * .38) });
          const shard = shardRows[index], payload = shardPayloads[index]; let target = null; let stored = false; let role = "cache";
          const placementKey = `${version.id}:${input.index}:${shard.shard_index}:1`;
          for (const candidate of rankPlacementCandidates(candidates, { context: placementContext, fileContext: filePlacementContext, placementKey, shardBytes: payload.bytes.byteLength })) {
            try { if (candidate.isLocal) await storeLocalVerified(shard.shard_hash, payload.bytes, payload.hash); else await candidate.peer.protocol.sendShard(shard.shard_hash, payload.bytes, payload.hash); target = candidate; stored = true; role = "durable"; recordPlacementChoice(placementContext, candidate); recordFilePlacementChoice(filePlacementContext, candidate, payload.bytes.byteLength, `${segment.id}:${shard.id}:${candidate.id}`); break; }
            catch {}
          }
          if (!stored) { await storeLocalVerified(shard.shard_hash, payload.bytes, payload.hash); target = node; stored = true; role = placementContext.domains.has(node.failure_domain_id || node.id) ? "cache" : "durable"; if (role === "durable") { recordPlacementChoice(placementContext, node); recordFilePlacementChoice(filePlacementContext, node, payload.bytes.byteLength, `${segment.id}:${shard.id}:${node.id}`); } await queueShardRepair(vaultId, shard.id).catch(() => {}); }
          if (target) placementRows.push(await recordShardPlacement({ vaultId, shardId: shard.id, node: target, role })); physical += payload.bytes.byteLength;
        }
        await updateSegmentPhysicalBytes(vaultId, segment.id, physical); segment = { ...segment, physical_storage_bytes: physical, segment_shards: shardRows.map((shard) => ({ ...shard, shard_placements: placementRows.filter((placement) => placement.shard_id === shard.id) })) };
      }
      await linkVersionSegment({ vaultId, versionId: version.id, segmentId: segment.id, segmentIndex: input.index, originalOffset: input.offset });
      if (created) { await markSegmentReady(vaultId, segment.id); segment.status = "ready"; buildingSegmentId = null; buildingShardHashes = []; }
      representationSize += Number(segment.stored_size_bytes); compressionSaved += Math.max(0, Number(segment.original_size_bytes) - Number(segment.stored_size_bytes));
      if (!physicalSeen.has(segment.id)) { physicalSeen.add(segment.id); physicalStorage += Number(segment.physical_storage_bytes || 0); physicalShardCopies += Number(segment.total_shards || 0); }
      minimumRequired = Math.max(minimumRequired, Number(segment.required_shards)); repairThreshold = Math.max(repairThreshold, Number(segment.repair_threshold || segment.required_shards)); totalShards = Math.max(totalShards, Number(segment.total_shards)); summaryLinks.push({ content_segments: segment }); manifestSegments.push(segmentManifestEntry(segment, privateMetadataEnvelope));
      processed += plain.byteLength; task.progress(Math.min(.94, processed / Math.max(1, file.size) * .94), `Segment ${segmentNumber} verified`); await appTable("transfers").update({ bytes_complete: processed }).eq("vault_id", vaultId).eq("id", transferId);
    }
    if (task.signal.aborted) throw task.signal.reason || new DOMException("Operation cancelled", "AbortError");
    const resilience = summarizeVersionSegments(summaryLinks);
    task.phase("publishing", "Signing and publishing the recovery manifest", { segmentIndex: totalSegments, progress: .96 });
    const manifestEnvelope = await buildManifestV2({ storageProtocolVersion: window.__DATA__.storageFormatVersion, vaultId, fileVersionId: version.id, originalHash: wholeHash.hex(), originalSize: file.size, segmentCount: manifestSegments.length, boundaryMethod: "fixed-8MiB", segments: manifestSegments }, signer);
    await saveManifestLocally(manifestEnvelope);
    await appendOperation(signer, vaultId, OP_TYPES.PUBLISH_MANIFEST, { fileId: record.id, fileVersionId: version.id, manifestId: manifestEnvelope.manifestId, manifestHash: manifestEnvelope.manifestHash });
    await replicateManifestToPeers(manifestEnvelope.manifestId, manifestEnvelope, peers);
    await announceManifest(manifestEnvelope).catch(() => {});
    task.phase("publishing", "Saving final storage and resilience totals", { segmentIndex: totalSegments, progress: .98 });
    await finalizeFileVersion(vaultId, version.id, record.id, { format_version: window.__DATA__.storageFormatVersion, segment_count: manifestSegments.length, representation_size_bytes: representationSize, physical_storage_bytes: physicalStorage, physical_shard_copies: physicalShardCopies, surplus_placements: 0, compression_saved_bytes: compressionSaved, active_shards: resilience.activeShards, independent_devices: resilience.independentDevices, country_count: resilience.countryCount, region_count: resilience.regionCount, network_domain_count: resilience.networkDomainCount, minimum_required_shards: minimumRequired, repair_threshold_shards: repairThreshold, total_shards: totalShards, recovery_status: resilience.recoveryStatus, manifest_id: manifestEnvelope.manifestId });
    await appTable("transfers").update({ status: "complete", bytes_complete: file.size }).eq("vault_id", vaultId).eq("id", transferId); task.done(resilience.recoveryStatus === "resilient" ? "File resilient" : "File stored; waiting for independent devices");
    await recordAudit(vaultId, "file.upload", "success", { fileId: record.id, size: file.size, segments: manifestSegments.length, status: resilience.recoveryStatus }); return record;
  } catch (error) {
    if (buildingSegmentId) { for (const shardHash of buildingShardHashes) { await deleteShard(shardHash).catch(() => {}); cleanupPeers.forEach((peer) => peer.protocol.requestDelete(shardHash)); } try { await appTable("content_segments").delete().eq("vault_id", vaultId).eq("id", buildingSegmentId); } catch {} } if (record) await setFileStatus(vaultId, record.id, "failed").catch(() => {}); if (transferId) { try { await appTable("transfers").update({ status: "failed" }).eq("vault_id", vaultId).eq("id", transferId); } catch {} } task.fail(error); await recordAudit(vaultId, "file.upload", "failure", { fileId: record?.id || null }).catch(() => {}); throw error;
  }
}
