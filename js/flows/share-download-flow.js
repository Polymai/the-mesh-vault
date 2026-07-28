import { createTask } from "../ui/task-state.js";
import { reconstructShards } from "../security/erasure.js";
import { decryptBytes, hashBytes } from "../security/keyring.js";
import { decompressSegment } from "../security/compression.js";
import { Sha256Stream } from "../vendor/sha256-stream.js";
import { base64UrlToBytes } from "../security/signing.js";
import { findManifest } from "../network/manifest-discovery.js";
import { findFragment } from "../network/fragment-discovery.js";
import { fetchCapability, redeemCapability } from "../services/capability-service.js";
import { verifyCapabilityCore, checkCapabilityPassword, openCapabilityKeys } from "../security/capability.js";
import { loadOrCreateDeviceIdentity } from "../identity/device-identity.js";
import { activateNode, pauseNode, propagateFragmentRequest, connectToNode } from "../network/node-service.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { getPeerIceConfig } from "../services/network-service.js";
import { deleteShard } from "../storage/fragment-store.js";
import { ensureAnonymousSession } from "../services/supabase.js";

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
  // Share links are public entry points, but the coordination schema is
  // intentionally gated to pseudonymous Supabase sessions. Establish that
  // session only when the recipient chooses to recover the file.
  await ensureAnonymousSession();
  const row = await fetchCapability(capabilityId);
  if (!row) throw new Error("This link does not exist or has expired.");
  const metadata = row.encrypted_capability_metadata;
  if (!(await verifyCapabilityCore(metadata.core, metadata.signature))) throw new Error("This link's signature could not be verified, or it has expired.");
  if (row.revoked) throw new Error("This link has been revoked.");
  if (!(await checkCapabilityPassword(metadata.core, password))) throw new Error("Incorrect password.");
  const segmentBundles = await openCapabilityKeys(metadata.keysBlob, fragmentPayload.capabilityKey);
  await redeemCapability(capabilityId);

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

  const task = createTask("Recovering shared file", 6 * 60 * 60 * 1000); let sink = null;
  try {
    const { envelope: manifest } = await findManifest(fragmentPayload.manifestId, { verifyOpts: { supportedManifestVersions: [2], supportedStorageVersions: [1, 2] } });
    if (!manifest) throw new Error("This file's manifest could not be found.");
    sink = await createStreamingSink(`meshvault-shared-${capabilityId.slice(0, 8)}.bin`);
    const wholeHash = new Sha256Stream(); let recovered = 0;
    for (let index = 0; index < manifest.segments.length; index++) {
      const segment = manifest.segments[index]; const bundle = segmentBundles[index];
      const available = [];
      for (let shardIdx = 0; shardIdx < segment.shardHashes.length && available.length < segment.requiredShards; shardIdx++) {
        const preferredNodeId = (segment.placements || []).find((placement) => Number(placement.shardIndex) === shardIdx)?.nodeId;
        const connected = connectedProtocols();
        if (preferredNodeId && !connected.some((peer) => peer.nodeId === preferredNodeId)) {
          const preferred = await connectToNode(preferredNodeId).catch(() => null);
          if (preferred) connected.unshift(preferred);
        }
        const orderedPeers = preferredNodeId
          ? connected.sort((left, right) => Number(right.nodeId === preferredNodeId) - Number(left.nodeId === preferredNodeId))
          : connected;
        const { bytes } = await findFragment(segment.shardHashes[shardIdx], { connectedPeers: orderedPeers, propagate: propagateFragmentRequest, connectToNode });
        if (bytes) available.push({ index: shardIdx, bytes });
      }
      if (available.length < segment.requiredShards) throw new Error(`Only ${available.length} of ${segment.requiredShards} required shards are currently reachable.`);
      const cipher = await reconstructShards(available, Number(segment.cipherSize), Number(segment.dataShards), task.signal);
      await Promise.all(available.map((item) => deleteShard(segment.shardHashes[item.index]).catch(() => {})));
      if ((await hashBytes(cipher)) !== segment.cipherHash) throw new Error(`Segment ${index + 1} failed ciphertext verification.`);
      const rawKey = base64UrlToBytes(bundle.rawKey);
      const representation = await decryptBytes(cipher, rawKey, bundle.aad);
      const plain = await decompressSegment(representation, segment.compression);
      if (plain.byteLength !== Number(segment.originalSize) || (await hashBytes(plain)) !== bundle.plainHash) throw new Error(`Segment ${index + 1} did not reproduce its original bytes.`);
      wholeHash.update(plain); await sink.write(plain); recovered += plain.byteLength;
      task.progress(recovered / Math.max(1, Number(manifest.originalSize)), `Verified segment ${index + 1} of ${manifest.segments.length}`);
    }
    if (recovered !== manifest.originalSize || wholeHash.hex() !== manifest.originalHash) throw new Error("The restored file did not match the original byte for byte.");
    await sink.close(); sink = null; task.done("File ready"); return true;
  } catch (error) { await sink?.abort?.().catch(() => {}); task.fail(error); throw error; }
  finally { if (joinedMesh) await pauseNode().catch(() => {}); }
}
