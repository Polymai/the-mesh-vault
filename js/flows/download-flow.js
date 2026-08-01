import { createTask } from "../ui/task-state.js";
import { getFileBundle, markExactRecovery } from "../services/metadata-service.js";
import { reconstructShards } from "../security/erasure.js";
import { unwrapSegmentKey, decryptBytes, decryptJson, hashBytes } from "../security/keyring.js";
import { decompressSegment } from "../security/compression.js";
import { Sha256Stream } from "../vendor/sha256-stream.js";
import { recordAudit } from "../services/audit-service.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { propagateManifestRequest } from "../network/node-service.js";
import { findManifest } from "../network/manifest-discovery.js";
import { acquireRequiredShards, releaseAcquiredShards } from "../network/shard-retrieval.js";

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

export async function downloadFile(fileId, { vaultIdentity } = {}) {
  const task = createTask("Recovering file", 6 * 60 * 60 * 1000, {
    kind: "download",
    phase: "finding",
    preventUnload: true,
    autoDismissMs: 6000,
  });
  let sink = null; let vaultId = null;
  try {
    vaultId = vaultIdentity?.vaultId;
    if (!vaultId) throw new Error("Open this file from its owning vault.");
    const bundle = await getFileBundle(vaultId, fileId);
    task.phase("finding", "Locating the signed recovery manifest", {
      fileName: bundle.file.name,
      fileSize: Number(bundle.file.size_bytes || 0),
      progress: .02,
    });
    if (!bundle.version.manifest_id) throw new Error("This file has no published manifest yet.");
    const { envelope: manifest } = await findManifest(bundle.version.manifest_id, {
      connectedPeers: connectedProtocols(), propagate: propagateManifestRequest,
      verifyOpts: { supportedManifestVersions: [2], supportedStorageVersions: [1, 2] },
    });
    if (task.signal.aborted) throw task.signal.reason || new DOMException("Download cancelled", "AbortError");
    if (!manifest) throw new Error("This file's manifest could not be found locally, from peers, or from the bootstrap provider.");
    if (manifest.vaultId !== vaultId) throw new Error("The manifest does not belong to this vault.");
    const totalSegments = manifest.segments.length;
    task.phase("choosing", "Choose where to save the recovered file", {
      totalSegments,
      segmentIndex: 1,
      progress: .04,
    });
    sink = await createStreamingSink(bundle.file);
    if (task.signal.aborted) throw task.signal.reason || new DOMException("Download cancelled", "AbortError");
    const wholeHash = new Sha256Stream(); let recovered = 0;
    for (let index = 0; index < manifest.segments.length; index++) {
      const segment = manifest.segments[index];
      const segmentIndex = index + 1;
      const stageProgress = (fraction) => .05 + ((index + fraction) / Math.max(1, totalSegments)) * .9;
      task.phase("retrieving", `Finding ${segment.requiredShards} verified shards`, {
        segmentIndex,
        totalSegments,
        progress: stageProgress(0),
      });
      const acquired = await acquireRequiredShards(segment, {
        peers: connectedProtocols(),
        signal: task.signal,
        onProgress: ({ acquired, required }) => task.phase("retrieving", `Received ${acquired} of ${required} required shards`, {
          segmentIndex,
          totalSegments,
          progress: stageProgress(.55 * (acquired / Math.max(1, required))),
        }),
      });
      const available = acquired.shards;
      task.phase("reconstructing", "Rebuilding the encrypted segment", {
        segmentIndex,
        totalSegments,
        progress: stageProgress(.62),
      });
      let cipher;
      try {
        cipher = await reconstructShards(available, Number(segment.cipherSize), acquired.profile.dataShards, task.signal);
      } finally {
        await releaseAcquiredShards(segment, available);
      }
      if ((await hashBytes(cipher)) !== segment.cipherHash) throw new Error(`Segment ${index + 1} failed ciphertext verification.`);
      task.phase("decrypting", "Decrypting this segment on your device", {
        segmentIndex,
        totalSegments,
        progress: stageProgress(.76),
      });
      const privateMetadata = await decryptJson(segment.encryptedPrivateMetadata); const key = await unwrapSegmentKey(segment.wrappedSegmentKey); const representation = await decryptBytes(cipher, key, privateMetadata.aad); key.fill(0);
      const plain = await decompressSegment(representation, segment.compression); if (plain.byteLength !== Number(segment.originalSize) || (await hashBytes(plain)) !== privateMetadata.plainHash) throw new Error(`Segment ${index + 1} did not reproduce its original bytes.`);
      task.phase("verifying", "Checking this segment against its signed hash", {
        segmentIndex,
        totalSegments,
        progress: stageProgress(.88),
      });
      wholeHash.update(plain); await sink.write(plain); recovered += plain.byteLength;
      task.progress(stageProgress(1), `Verified segment ${segmentIndex} of ${totalSegments}`);
    }
    task.phase("verifying", "Checking the complete file byte for byte", {
      segmentIndex: totalSegments,
      totalSegments,
      progress: .97,
    });
    if (recovered !== manifest.originalSize || wholeHash.hex() !== manifest.originalHash) throw new Error("The restored file did not match the original byte for byte.");
    task.phase("saving", "Writing the verified file to your device", {
      segmentIndex: totalSegments,
      totalSegments,
      progress: .99,
    });
    await sink.close(); sink = null; await markExactRecovery(vaultId, bundle.version.id); task.done("Exact recovery verified"); await recordAudit(vaultId, "file.download", "success", { fileId, bytes: recovered, exactRecovery: true }).catch(() => {}); return true;
  } catch (error) {
    await sink?.abort?.().catch(() => {});
    if (error?.name === "AbortError") task.cancelled("Download cancelled");
    else task.fail(error);
    await recordAudit(vaultId, "file.download", "failure", { fileId, cancelled: error?.name === "AbortError" }).catch(() => {});
    throw error;
  }
}
