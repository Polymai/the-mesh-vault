import { createTask } from "../ui/task-state.js";
import { reconstructShards } from "../security/erasure.js";
import { decryptBytes, hashBytes, segmentEncryptionAad } from "../security/keyring.js";
import { decompressSegment } from "../security/compression.js";
import { Sha256Stream } from "../vendor/sha256-stream.js";
import { base64UrlToBytes } from "../security/signing.js";
import { findManifest } from "../network/manifest-discovery.js";
import { acquireRequiredShards, releaseAcquiredShards } from "../network/shard-retrieval.js";
import { redeemCapability } from "../services/capability-service.js";
import { verifyCapabilityCore, openCapabilityKeys } from "../security/capability.js";
import { loadOrCreateDeviceIdentity } from "../identity/device-identity.js";
import { activateNode, pauseNode } from "../network/node-service.js";
import { propagateManifestRequest } from "../network/node-service.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { getPeerIceConfig } from "../services/network-service.js";

async function createStreamingSink(name) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable(); return { write: (bytes) => writable.write(bytes), close: () => writable.close(), abort: () => writable.abort() };
    } catch (error) { if (error.name === "AbortError") throw error; }
  }
  if (!navigator.storage?.getDirectory) throw new Error("This browser cannot stream a large download to disk. Use a browser with File System Access or OPFS support.");
  const root = await navigator.storage.getDirectory(); const tempName = `meshvault-share-${crypto.randomUUID()}.tmp`; const handle = await root.getFileHandle(tempName, { create: true }); const writable = await handle.createWritable();
  return {
    write: (bytes) => writable.write(bytes), abort: async () => { await writable.abort().catch(() => {}); await root.removeEntry(tempName).catch(() => {}); },
    close: async () => { await writable.close(); const stored = await handle.getFile(); const url = URL.createObjectURL(stored); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); window.setTimeout(() => { URL.revokeObjectURL(url); root.removeEntry(tempName).catch(() => {}); }, 60000); },
  };
}

export async function downloadSharedFile(capabilityId, fragmentPayload, { password = "" } = {}) {
  const metadata = fragmentPayload?.capability;
  if (!metadata) throw new Error("This share link is incomplete or uses an older hosted format.");
  const row = {
    manifest_id: metadata?.core?.manifestId,
    encrypted_capability_metadata: metadata,
    signature: metadata?.signature,
    expires_at: new Date(Number(metadata?.core?.expiresAt || 0)).toISOString(),
    single_use: !!metadata?.core?.singleUse,
    download_limit: metadata?.core?.downloadLimit ?? null,
    revoked: false,
  };
  if (
    fragmentPayload?.capabilityId !== capabilityId
    || metadata?.core?.capabilityId !== capabilityId
    || fragmentPayload?.manifestId !== metadata?.core?.manifestId
    || row.manifest_id !== metadata?.core?.manifestId
    || row.signature !== metadata?.signature
    || Date.parse(row.expires_at || 0) !== Number(metadata?.core?.expiresAt)
    || !!row.single_use !== !!metadata?.core?.singleUse
    || (row.download_limit == null ? null : Number(row.download_limit)) !== (metadata?.core?.downloadLimit == null ? null : Number(metadata.core.downloadLimit))
  ) throw new Error("This share URL contains mismatched capability data.");
  if (!(await verifyCapabilityCore(metadata.core, metadata.signature))) throw new Error("This link's signature could not be verified, or it has expired.");
  if (row.revoked) throw new Error("This link has been revoked.");
  const segmentBundles = await openCapabilityKeys(metadata.keysBlob, fragmentPayload.fragmentSecret, metadata.core, password);

  let joinedMesh = false;
  try {
    const deviceIdentity = await loadOrCreateDeviceIdentity(); let iceServers = [];
    try { iceServers = (await getPeerIceConfig()).iceServers || []; } catch {}
    await activateNode(deviceIdentity, null, 0, iceServers, null, {
      transient: true,
      transientCacheBytes: Math.max(32 * 1024 * 1024, Number(window.__DATA__?.segments?.targetBytes || 8 * 1024 * 1024) * 2),
    });
    joinedMesh = true;
  } catch {}

  const task = createTask("Recovering shared file", 6 * 60 * 60 * 1000, {
    kind: "download",
    phase: "finding",
    preventUnload: true,
    autoDismissMs: 6000,
  });
  let sink = null;
  try {
    const { envelope: manifest } = await findManifest(fragmentPayload.manifestId, {
      connectedPeers: connectedProtocols(),
      propagate: propagateManifestRequest,
      verifyOpts: {
        expectedManifestId: fragmentPayload.manifestId,
        expectedVaultId: metadata.core.vaultId,
        expectedOwnerPublicKey: metadata.core.ownerPublicKey,
        expectedFileVersionId: metadata.core.fileVersionId,
      },
    });
    if (!manifest) throw new Error("This file's manifest could not be found.");
    const requiredSegmentIds = new Set(manifest.segments.map((segment) => segment.segmentId));
    if (!Array.isArray(segmentBundles) || segmentBundles.length !== requiredSegmentIds.size) throw new Error("This share link does not contain the required segment grants.");
    const grants = new Map(segmentBundles.map((grant) => [grant.segmentId, grant]));
    if (grants.size !== requiredSegmentIds.size || [...grants.keys()].some((segmentId) => !requiredSegmentIds.has(segmentId))) throw new Error("This share link contains invalid segment grants.");
    sink = await createStreamingSink(`meshvault-shared-${capabilityId.slice(0, 8)}.bin`);
    const wholeHash = new Sha256Stream(); let recovered = 0;
    for (let index = 0; index < manifest.segments.length; index++) {
      const segment = manifest.segments[index]; const bundle = grants.get(segment.segmentId);
      if (
        !bundle
        || bundle.keyDerivationVersion !== segment.keyDerivationVersion
        || bundle.encryptionGeneration !== segment.encryptionGeneration
      ) throw new Error(`Segment ${index + 1} has no matching decryption grant.`);
      const acquired = await acquireRequiredShards(segment, {
        peers: connectedProtocols(),
        signal: task.signal,
        onProgress: ({ acquired: received, required }) => task.phase(
          "retrieving",
          `Received ${received} of ${required} required shards`,
          {
            segmentIndex: index + 1,
            totalSegments: manifest.segments.length,
            progress: (index + (received / Math.max(1, required)) * .55) / Math.max(1, manifest.segments.length),
          },
        ),
      });
      const available = acquired.shards;
      let cipher;
      try {
        cipher = await reconstructShards(available, Number(segment.cipherSize), acquired.profile.dataShards, task.signal);
      } finally {
        await releaseAcquiredShards(segment, available);
      }
      if ((await hashBytes(cipher)) !== segment.cipherHash) throw new Error(`Segment ${index + 1} failed ciphertext verification.`);
      const rawKey = base64UrlToBytes(bundle.rawKey);
      let representation;
      try { representation = await decryptBytes(cipher, rawKey, segmentEncryptionAad({ ...segment, vaultId: metadata.core.vaultId })); }
      finally { rawKey.fill(0); }
      const plain = await decompressSegment(representation, segment.compression);
      if (plain.byteLength !== Number(segment.originalSize) || (await hashBytes(plain)) !== bundle.plainHash) throw new Error(`Segment ${index + 1} did not reproduce its original bytes.`);
      wholeHash.update(plain); await sink.write(plain); recovered += plain.byteLength;
      task.progress(recovered / Math.max(1, Number(manifest.originalSize)), `Verified segment ${index + 1} of ${manifest.segments.length}`);
    }
    if (recovered !== manifest.originalSize || wholeHash.hex() !== manifest.originalHash) throw new Error("The restored file did not match the original byte for byte.");
    await redeemCapability(capabilityId);
    await sink.close(); sink = null; task.done("File ready"); return true;
  } catch (error) {
    await sink?.abort?.().catch(() => {});
    if (error?.name === "AbortError") task.cancelled("Download cancelled");
    else task.fail(error);
    throw error;
  }
  finally {
    segmentBundles?.forEach?.((grant) => { grant.rawKey = ""; grant.plainHash = ""; });
    if (joinedMesh) await pauseNode().catch(() => {});
  }
}
