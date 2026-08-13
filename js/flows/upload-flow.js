import { createTask, runConcurrent, withRetry } from "../ui/task-state.js";
import {
  dedupFingerprint, deriveSegmentKey, encryptBytes, encryptJson, hashBytes,
  segmentEncryptionAad, segmentPrivateMetadataAad,
} from "../security/keyring.js";
import { streamFileSegments } from "../security/segmenter.js";
import { compressAdaptive } from "../security/compression.js";
import { Sha256Stream } from "../vendor/sha256-stream.js";
import { encodeShards } from "../security/erasure.js";
import { putShard, getShard } from "../storage/fragment-store.js";
import { createFileRecord, createFileVersion, finalizeFileVersion, setFileStatus } from "../services/metadata-service.js";
import { chooseErasureProfile, independentCandidateCount, loadPlacementCandidates, findReusableSegment, createContentSegment, updateSegmentPhysicalBytes, markSegmentReady, registerSegmentShards, recordShardPlacement, transitionShardPlacement, linkVersionSegment, queueShardRepair, summarizeVersionSegments } from "../services/segment-service.js";
import { acknowledgeLifecycleShardDeletion } from "../services/deletion-service.js";
import { appTable } from "../services/supabase.js";
import { currentNode } from "../network/node-service.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { recordAudit } from "../services/audit-service.js";
import { buildManifestV3 } from "../security/manifest.js";
import { signSegmentDescriptor, verifySegmentDescriptor } from "../security/segment-descriptor.js";
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
  releasePlacementChoice,
} from "../network/placement-engine.js";

async function storeLocalVerified(shardHash, bytes, expectedHash) { await putShard(shardHash, bytes); const stored = await getShard(shardHash); if (!stored || (await hashBytes(stored)) !== expectedHash) throw new Error("Local shard storage failed verification."); }

async function retireUploadPlacement(vaultId, placement, shardHash, node, peers) {
  if (!placement || placement.status === "deleted") return placement;
  const deleting = placement.status === "deleting"
    ? placement
    : await transitionShardPlacement(vaultId, placement.id, "deleting");
  if (deleting.node_id === node?.id) {
    await acknowledgeLifecycleShardDeletion(node.id, shardHash).catch(() => false);
  } else {
    const peer = peers.find((entry) => entry.nodeId === deleting.node_id);
    if (peer) await peer.protocol.requestDelete(shardHash).catch(() => false);
  }
  return deleting;
}

async function retainFailedSegmentCleanup(vaultId, segmentId, node, peers) {
  const { data: shards, error: shardError } = await appTable("segment_shards")
    .select("id,shard_hash,status,shard_placements(id,node_id,status)")
    .eq("vault_id", vaultId).eq("content_segment_id", segmentId);
  if (shardError) throw shardError;
  const { data: marked, error: segmentError } = await appTable("content_segments")
    .update({ status: "deleting" }).eq("vault_id", vaultId).eq("id", segmentId)
    .in("status", ["building", "deleting"]).select("id").maybeSingle();
  if (segmentError) throw segmentError;
  if (!marked) throw new Error("Failed upload cleanup intent could not be retained.");
  for (const shard of shards || []) {
    for (const placement of shard.shard_placements || []) {
      await retireUploadPlacement(vaultId, placement, shard.shard_hash, node, peers);
    }
    const { data: shardMarked, error: markError } = await appTable("segment_shards")
      .update({ status: "deleting" }).eq("vault_id", vaultId).eq("id", shard.id)
      .in("status", ["pending", "verified", "missing", "deleting"]).select("id").maybeSingle();
    if (markError) throw markError;
    if (!shardMarked) throw new Error("Failed shard cleanup intent could not be retained.");
    // Acknowledgement above can update placement state after this query. The
    // durable deleting rows remain available to retry when a remote node is offline.
  }
}

function segmentManifestEntry(segment, privateMetadataEnvelope) {
  const erasureCoding = {
    algorithm: "reed-solomon",
    profileVersion: 2,
    dataShards: Number(segment.data_shards),
    parityShards: Number(segment.parity_shards),
    requiredShards: Number(segment.required_shards),
    repairThreshold: Number(segment.repair_threshold || segment.required_shards),
    totalShards: Number(segment.total_shards),
  };
  return {
    segmentId: segment.id, storageFormatVersion: Number(segment.format_version || 3), originalSize: Number(segment.original_size_bytes), storedSize: Number(segment.stored_size_bytes), cipherSize: Number(segment.cipher_size_bytes),
    codingGeneration: Number(segment.coding_generation || 1),
    compression: segment.compression_method, dataShards: segment.data_shards, parityShards: segment.parity_shards,
    requiredShards: segment.required_shards, repairThreshold: segment.repair_threshold || segment.required_shards, totalShards: segment.total_shards, codingProfileVersion: 2, erasureCoding, cipherHash: segment.cipher_hash,
    keyDerivationVersion: Number(segment.key_derivation_version || 3),
    encryptionGeneration: Number(segment.encryption_generation || 1),
    dedupToken: segment.dedup_fingerprint,
    encryptedPrivateMetadata: privateMetadataEnvelope,
    ownerDescriptorHash: segment.owner_descriptor_hash,
    ownerDescriptorSignature: segment.owner_descriptor_signature,
    shardHashes: (segment.segment_shards || []).map((shard) => shard.shard_hash),
    placements: (segment.segment_shards || []).flatMap((shard) => (shard.shard_placements || [])
      .filter((placement) => ["stored", "verified"].includes(placement.status))
      .map((placement) => ({ shardIndex: shard.shard_index, nodeId: placement.node_id, failureDomain: placement.failure_domain_id, role: placement.role }))),
  };
}
async function replicateManifestToPeers(manifestId, envelope, peers, targetCount = 3) {
  await Promise.all(peers.slice(0, targetCount).map((peer) => peer.protocol.sendManifest(manifestId, envelope).catch(() => {})));
}

function waitForSegment(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException("Operation cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", cancel); resolve(); }
    function cancel() { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal.reason || new DOMException("Operation cancelled", "AbortError")); }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function linkStableSegment({ vaultId, versionId, segmentIndex, originalOffset, fingerprint, initialSegment, vaultIdentity, signal }) {
  let segment = initialSegment;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new DOMException("Operation cancelled", "AbortError");
    if (segment?.status === "ready") {
      const authenticity = await verifySegmentDescriptor(segment, vaultIdentity.ownerPublicKey);
      if (!authenticity.valid) throw new Error(`A reusable segment failed owner verification (${authenticity.reason}).`);
      const linked = await linkVersionSegment({
        vaultId,
        versionId,
        segmentId: segment.id,
        segmentIndex,
        originalOffset,
        expectedGeneration: Number(segment.coding_generation || 1),
        expectedDescriptorHash: segment.owner_descriptor_hash,
      });
      if (linked) return { ...segment, reference_count: Number(segment.reference_count || 0) + 1 };
    }
    await waitForSegment(500, signal);
    segment = await findReusableSegment(vaultId, fingerprint);
  }
  throw new Error("This encrypted segment is still being rebalanced. Try the upload again shortly.");
}

export async function uploadFile(file, { vaultIdentity, folderId = null, resilienceClass = window.__DATA__?.resilience?.defaultErasureClass || "auto" } = {}) {
  const max = window.__DATA__.limits.maxUploadBytes;
  if (!file || file.size > max) throw new Error(`Files must be ${Math.round(max / 1000000)} MB or smaller.`);
  const vaultId = vaultIdentity.vaultId;
  const signer = { publicKey: vaultIdentity.ownerPublicKey, algorithm: vaultIdentity.algorithm, sign: vaultIdentity.sign };
  const segmentTarget = window.__DATA__.segments.targetBytes; const totalSegments = Math.max(1, Math.ceil(file.size / segmentTarget));
  const task = createTask(`Securing ${file.name}`, 6 * 60 * 60 * 1000, { kind: "upload", fileName: file.name, fileSize: file.size, phase: "preparing", segmentIndex: 1, totalSegments, preventUnload: true }); let record = null; let transferId = null; let buildingSegmentId = null; let cleanupPeers = [];
  try {
    task.phase("preparing", "Creating the encrypted upload record", { progress: .01 });
    const transfer = await appTable("transfers").insert({ vault_id: vaultId, direction: "upload", status: "running", bytes_total: file.size }).select().single(); if (transfer.error) throw transfer.error; transferId = transfer.data.id;
    record = await createFileRecord({ vaultId, folderId, metadata: { name: file.name, mime: file.type || "application/octet-stream", modified: file.lastModified }, sizeBytes: file.size });
    await appTable("transfers").update({ file_id: record.id }).eq("vault_id", vaultId).eq("id", transferId);
    const version = await createFileVersion({ vaultId, fileId: record.id, originalSizeBytes: file.size });
    const node = currentNode(); if (!node || node.status !== "online") throw new Error("Enable this device before uploading a file."); const peers = connectedProtocols(); cleanupPeers = peers; const candidates = await loadPlacementCandidates(node, peers); const profile = chooseErasureProfile(independentCandidateCount(candidates), resilienceClass, { segmentCount: totalSegments, candidates });
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
        privateMetadataEnvelope = segment.encrypted_private_metadata;
      } else {
        task.phase("compressing", "Checking whether compression reduces this segment", { segmentIndex: segmentNumber, progress: stageProgress(.12) });
        const plainHash = await hashBytes(plain); const compressed = await compressAdaptive(plain, { name: file.name, mime: file.type, minimumSavings: window.__DATA__.segments.minimumSavings });
        const compressionMessage = compressed.method === "none" ? "Compression skipped; encrypting original bytes" : `Compressed ${Math.round(compressed.savings * 100)}%; encrypting smaller representation`;
        task.phase("encrypting", compressionMessage, { segmentIndex: segmentNumber, progress: stageProgress(.3) });
        const keyContext = {
          vaultId,
          segmentId: crypto.randomUUID(),
          keyDerivationVersion: 3,
          encryptionGeneration: 1,
          storageFormatVersion: 3,
          dedupToken: fingerprint,
          originalSize: plain.byteLength,
          storedSize: compressed.bytes.byteLength,
          compression: compressed.method,
        };
        const raw = await deriveSegmentKey(keyContext);
        let cipher;
        try { cipher = await encryptBytes(compressed.bytes, raw, segmentEncryptionAad(keyContext)); }
        finally { raw.fill(0); }
        const cipherHash = await hashBytes(cipher);
        privateMetadataEnvelope = await encryptJson({ plainHash }, segmentPrivateMetadataAad(keyContext));
        segment = await createContentSegment({
          id: keyContext.segmentId,
          vault_id: vaultId,
          dedup_fingerprint: fingerprint,
          format_version: 3,
          key_derivation_version: 3,
          encryption_generation: 1,
          coding_generation: 1,
          original_size_bytes: plain.byteLength,
          stored_size_bytes: compressed.bytes.byteLength,
          cipher_size_bytes: cipher.byteLength,
          compression_method: compressed.method,
          cipher_hash: cipherHash,
          encrypted_private_metadata: privateMetadataEnvelope,
          data_shards: profile.dataShards,
          parity_shards: profile.parityShards,
          required_shards: profile.requiredShards,
          repair_threshold: profile.repairThreshold,
          total_shards: profile.totalShards,
        }); created = true; buildingSegmentId = segment.id;
        task.phase("sharding", `Creating ${profile.dataShards} data and ${profile.parityShards} recovery shards`, { segmentIndex: segmentNumber, progress: stageProgress(.48) });
        const layout = await encodeShards(cipher, profile.dataShards, profile.parityShards, task.signal);
        const shardPayloads = await Promise.all(layout.shards.map(async (bytes) => ({ bytes: new Uint8Array(bytes), hash: await hashBytes(bytes) })));
        const shardRows = await registerSegmentShards(vaultId, segment.id, shardPayloads, 1); const placementContext = createPlacementContext(); let physical = 0; const placementRows = [];
        const transferConfig = window.__DATA__?.transport || {};
        const uploadConcurrency = Math.max(1, Math.min(3, Number(transferConfig.uploadShardConcurrency) || 3));
        const placementProgress = new Map(shardRows.map((_shard, index) => [index, 0]));
        const reportPlacementProgress = (index, fraction, message) => {
          placementProgress.set(index, Math.max(placementProgress.get(index) || 0, Math.min(1, Number(fraction) || 0)));
          const aggregate = [...placementProgress.values()].reduce((sum, value) => sum + value, 0) / Math.max(1, shardRows.length);
          task.phase("sending", message, { segmentIndex: segmentNumber, progress: stageProgress(.55 + aggregate * .38) });
        };
        await runConcurrent(shardRows, uploadConcurrency, async (shard, index, runSignal) => {
          const payload = shardPayloads[index]; let target = null; let stored = false; let role = "cache"; let verifiedPlacement = null;
          const placementKey = `${version.id}:${input.index}:${shard.shard_index}:1`;
          const attemptedCandidateIds = new Set();
          while (!stored) {
            if (runSignal.aborted) throw runSignal.reason || new DOMException("Operation cancelled", "AbortError");
            const candidate = rankPlacementCandidates(candidates, { context: placementContext, fileContext: filePlacementContext, placementKey, shardBytes: payload.bytes.byteLength })
              .find((entry) => !attemptedCandidateIds.has(entry.id));
            if (!candidate) break;
            attemptedCandidateIds.add(candidate.id);
            // Reserve synchronously so concurrent workers cannot select the same
            // browser-profile failure domain for this coding group.
            recordPlacementChoice(placementContext, candidate);
            let reservation = null;
            try {
              // Persist the intended owner before any bytes leave this browser.
              // A timeout after sendShard is therefore an ambiguous, but still
              // fully traceable, placement rather than an orphaned remote copy.
              reservation = await recordShardPlacement({ vaultId, shardId: shard.id, node: candidate, role: "durable", status: "pending" });
              await withRetry(async (_attempt, attemptSignal) => {
                if (candidate.isLocal) await storeLocalVerified(shard.shard_hash, payload.bytes, payload.hash);
                else await candidate.peer.protocol.sendShard(
                  shard.shard_hash,
                  payload.bytes,
                  payload.hash,
                  (fraction) => reportPlacementProgress(index, Math.min(.9, fraction * .9), `Sending ${shardRows.length} protected pieces`),
                  { signal: attemptSignal },
                );
              }, {
                retries: Number(transferConfig.retryAttempts) || 2,
                baseDelayMs: Number(transferConfig.retryBaseDelayMs) || 500,
                timeoutMs: Number(transferConfig.uploadAttemptTimeoutMs) || 50000,
                signal: runSignal,
              });
              verifiedPlacement = await transitionShardPlacement(vaultId, reservation.id, "verified");
              target = candidate; stored = true; role = "durable";
              recordFilePlacementChoice(filePlacementContext, candidate, payload.bytes.byteLength, `${segment.id}:${shard.id}:${candidate.id}`);
            } catch (error) {
              if (reservation) await retireUploadPlacement(vaultId, reservation, shard.shard_hash, node, cleanupPeers);
              releasePlacementChoice(placementContext, candidate);
              if (runSignal.aborted || error?.name === "AbortError") throw error;
            }
          }
          if (!stored) {
            role = placementContext.domains.has(node.failure_domain_id || node.id) ? "cache" : "durable";
            let reservation = null;
            try {
              reservation = await recordShardPlacement({ vaultId, shardId: shard.id, node, role, status: "pending" });
              await storeLocalVerified(shard.shard_hash, payload.bytes, payload.hash);
              verifiedPlacement = await transitionShardPlacement(vaultId, reservation.id, "verified");
              target = node;
              if (role === "durable") {
                recordPlacementChoice(placementContext, node);
                recordFilePlacementChoice(filePlacementContext, node, payload.bytes.byteLength, `${segment.id}:${shard.id}:${node.id}`);
              }
            } catch (error) {
              if (reservation) await retireUploadPlacement(vaultId, reservation, shard.shard_hash, node, cleanupPeers);
              throw error;
            }
            await queueShardRepair(vaultId, shard.id).catch(() => {});
          }
          if (target && verifiedPlacement) placementRows.push(verifiedPlacement);
          physical += payload.bytes.byteLength;
          reportPlacementProgress(index, 1, `${[...placementProgress.values()].filter((value) => value >= 1).length} of ${shardRows.length} protected pieces verified`);
        }, { signal: task.signal });
        await updateSegmentPhysicalBytes(vaultId, segment.id, physical); segment = { ...segment, physical_storage_bytes: physical, segment_shards: shardRows.map((shard) => ({ ...shard, shard_placements: placementRows.filter((placement) => placement.shard_id === shard.id) })) };
      }
      if (created) {
        const descriptor = await signSegmentDescriptor(segment, signer);
        await markSegmentReady(vaultId, segment.id, descriptor);
        segment.status = "ready";
        segment.owner_descriptor_hash = descriptor.descriptorHash;
        segment.owner_descriptor_signature = descriptor.signature;
        // Once the signed segment is ready it is a valid deduplication target
        // for another concurrent upload. Never treat it as private build debris
        // after this point: an error while linking this version must not erase
        // bytes or rows that a different version may already reference.
        buildingSegmentId = null;
      }
      segment = await linkStableSegment({ vaultId, versionId: version.id, segmentIndex: input.index, originalOffset: input.offset, fingerprint, initialSegment: segment, vaultIdentity, signal: task.signal });
      privateMetadataEnvelope = segment.encrypted_private_metadata;
      if (!created) {
        for (const shard of segment.segment_shards || []) for (const placement of shard.shard_placements || []) {
          if (placement.role !== "durable" || !["stored", "verified", "surplus"].includes(placement.status)) continue;
          recordFilePlacementChoice(filePlacementContext, placement, Number(shard.size_bytes || 0), placement.id);
        }
      }
      representationSize += Number(segment.stored_size_bytes); compressionSaved += Math.max(0, Number(segment.original_size_bytes) - Number(segment.stored_size_bytes));
      if (!physicalSeen.has(segment.id)) { physicalSeen.add(segment.id); physicalStorage += Number(segment.physical_storage_bytes || 0); physicalShardCopies += Number(segment.total_shards || 0); }
      minimumRequired = Math.max(minimumRequired, Number(segment.required_shards)); repairThreshold = Math.max(repairThreshold, Number(segment.repair_threshold || segment.required_shards)); totalShards = Math.max(totalShards, Number(segment.total_shards)); summaryLinks.push({ content_segments: segment }); manifestSegments.push(segmentManifestEntry(segment, privateMetadataEnvelope));
      processed += plain.byteLength; task.progress(Math.min(.94, processed / Math.max(1, file.size) * .94), `Segment ${segmentNumber} verified`); await appTable("transfers").update({ bytes_complete: processed }).eq("vault_id", vaultId).eq("id", transferId);
    }
    if (task.signal.aborted) throw task.signal.reason || new DOMException("Operation cancelled", "AbortError");
    const resilience = summarizeVersionSegments(summaryLinks);
    task.phase("publishing", "Signing and publishing the recovery manifest", { segmentIndex: totalSegments, progress: .96 });
    const manifestEnvelope = await buildManifestV3({ storageProtocolVersion: 3, vaultId, fileVersionId: version.id, originalHash: wholeHash.hex(), originalSize: file.size, segmentCount: manifestSegments.length, boundaryMethod: "fixed-8MiB", segments: manifestSegments }, signer);
    await saveManifestLocally(manifestEnvelope);
    await appendOperation(signer, vaultId, OP_TYPES.PUBLISH_MANIFEST, { fileId: record.id, fileVersionId: version.id, manifestId: manifestEnvelope.manifestId, manifestHash: manifestEnvelope.manifestHash });
    await replicateManifestToPeers(manifestEnvelope.manifestId, manifestEnvelope, peers);
    await announceManifest(manifestEnvelope).catch(() => {});
    task.phase("publishing", "Saving final storage and resilience totals", { segmentIndex: totalSegments, progress: .98 });
    await finalizeFileVersion(vaultId, version.id, record.id, { format_version: 3, segment_count: manifestSegments.length, representation_size_bytes: representationSize, physical_storage_bytes: physicalStorage, physical_shard_copies: physicalShardCopies, surplus_placements: 0, compression_saved_bytes: compressionSaved, active_shards: resilience.activeShards, independent_devices: resilience.independentDevices, country_count: resilience.countryCount, region_count: resilience.regionCount, network_domain_count: resilience.networkDomainCount, minimum_required_shards: minimumRequired, repair_threshold_shards: repairThreshold, total_shards: totalShards, recovery_status: resilience.recoveryStatus, manifest_id: manifestEnvelope.manifestId });
    await appTable("transfers").update({ status: "complete", bytes_complete: file.size }).eq("vault_id", vaultId).eq("id", transferId); task.done(resilience.recoveryStatus === "resilient" ? "File resilient" : "File stored; waiting for independent devices");
    await recordAudit(vaultId, "file.upload", "success", { fileId: record.id, size: file.size, segments: manifestSegments.length, status: resilience.recoveryStatus }); return record;
  } catch (error) {
    let cleanupError = null;
    if (buildingSegmentId) {
      try { await retainFailedSegmentCleanup(vaultId, buildingSegmentId, currentNode(), cleanupPeers); }
      catch (failure) { cleanupError = failure; }
    }
    if (record) await setFileStatus(vaultId, record.id, "failed").catch(() => {});
    if (transferId) { try { await appTable("transfers").update({ status: "failed" }).eq("vault_id", vaultId).eq("id", transferId); } catch {} }
    task.fail(error);
    await recordAudit(vaultId, "file.upload", "failure", { fileId: record?.id || null, cleanupRetained: !cleanupError }).catch(() => {});
    if (cleanupError) throw new AggregateError([error, cleanupError], "Upload failed and its cleanup intent could not be fully recorded.");
    throw error;
  }
}
