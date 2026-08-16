import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const safe = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 128);
const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value));
const GROUP_LIMITS = Object.freeze({
  peer: 512, "fragment-location": 24, manifest: 3, "vault-index": 5,
  oplog: 2048, "deletion-order": 512, "deletion-ack": 512,
  "anchor-handoff": 1, "repair-request": 512, "repair-lease": 32,
  "repair-complete": 512,
});

function payloadId(payload, names) {
  for (const name of names) if (payload?.[name] != null && String(payload[name])) return String(payload[name]);
  return null;
}

function semanticKey(object) {
  const payload = object.payload || {}; const lookup = String(object.lookupKey || ""); let identity;
  if (object.kind === "peer") identity = payloadId(payload, ["nodeId"]) || object.senderPublicKey;
  else if (object.kind === "fragment-location") identity = `${lookup}:${payloadId(payload, ["nodeId"]) || object.senderPublicKey}`;
  else if (object.kind === "manifest") identity = `${lookup}:${payloadId(payload, ["manifestHash", "indexHash"]) || object.payloadHash}`;
  else if (object.kind === "vault-index") identity = `${lookup}:${payloadId(payload, ["revision"]) || "unknown"}:${payloadId(payload, ["indexHash"]) || object.payloadHash}`;
  else if (object.kind === "oplog") identity = `${lookup}:${payloadId(payload, ["opId"]) || "unknown"}:${object.payloadHash}`;
  else if (["deletion-order", "deletion-ack"].includes(object.kind)) identity = `${payloadId(payload, ["orderId", "placementId"]) || object.payloadHash}:${payloadId(payload, ["nodeId"]) || object.senderPublicKey}`;
  else if (["repair-request", "repair-complete"].includes(object.kind)) identity = payloadId(payload, ["requestId"]) || object.payloadHash;
  else if (object.kind === "repair-lease") identity = payloadId(payload, ["leaseId"]) || `${payloadId(payload, ["requestId"]) || lookup}:${payloadId(payload, ["workerNodeId"]) || object.senderPublicKey}`;
  else identity = payloadId(payload, ["nodeId"]) || object.payloadHash;
  return JSON.stringify([object.kind, identity]);
}

export class BackboneStore {
  constructor(layout) {
    this.layout = layout;
    this.leases = new Map(); this.controls = new Map(); this.manifests = new Map(); this.fragments = new Map(); this.uploads = new Map();
    this.instanceStates = new Map(layout.instances.map((instance) => [instance.id, {
      enabled: true,
      lastStartedAt: Date.now(),
      lastStoppedAt: null,
      restartCount: 0,
    }]));
    for (const instance of layout.instances) mkdirSync(this.instanceRoot(instance), { recursive: true });
    this.metadataPath = join(layout.pools[0].path, "themeshvault", "backbone-index.json");
    this.persistTimer = null;
    this.loadMetadata();
  }
  loadMetadata() {
    try {
      const data = JSON.parse(readFileSync(this.metadataPath, "utf8"));
      this.controls = new Map((data.controls || []).map((row) => [row.objectId, row]));
      this.manifests = new Map((data.manifests || []).map((row) => [row.manifestId, row]));
      this.fragments = new Map((data.fragments || []).map(([hash, values]) => [hash, new Map(values)]));
      for (const [id, saved] of Object.entries(data.instanceStates || {})) {
        if (!this.instanceStates.has(id)) continue;
        this.instanceStates.set(id, {
          enabled: saved.enabled !== false,
          lastStartedAt: Number(saved.lastStartedAt || Date.now()),
          lastStoppedAt: saved.lastStoppedAt == null ? null : Number(saved.lastStoppedAt),
          restartCount: Math.max(0, Math.trunc(Number(saved.restartCount || 0))),
        });
      }
    } catch {}
  }
  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persistMetadata(); }, 250);
  }
  persistMetadata() {
    mkdirSync(dirname(this.metadataPath), { recursive: true });
    const now = Date.now();
    for (const [id, row] of this.controls) if (Number(row.expiresAt || 0) <= now) this.controls.delete(id);
    const value = {
      controls: [...this.controls.values()].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 10000),
      manifests: [...this.manifests.values()].slice(-2000),
      fragments: [...this.fragments.entries()].map(([hash, values]) => [hash, [...values.entries()].filter(([, expiresAt]) => expiresAt > now)]).filter(([, values]) => values.length),
      instanceStates: Object.fromEntries(this.instanceStates),
    };
    const next = `${this.metadataPath}.next`; writeFileSync(next, JSON.stringify(value)); renameSync(next, this.metadataPath);
  }
  flush() { if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; } this.persistMetadata(); }
  instanceRoot(instance) { return join(instance.pool.path, "themeshvault", instance.id); }
  shardPath(instance, hash) { return join(this.instanceRoot(instance), "shards", `${safe(hash)}.bin`); }
  usedBytes(instance) {
    const indexPath = join(this.instanceRoot(instance), "shards.json");
    try { return Object.values(JSON.parse(readFileSync(indexPath, "utf8"))).reduce((sum, size) => sum + Number(size || 0), 0); } catch { return 0; }
  }
  writeIndex(instance) {
    const dir = join(this.instanceRoot(instance), "shards"); mkdirSync(dir, { recursive: true });
    const index = {};
    try { for (const name of readdirSync(dir)) if (name.endsWith(".bin")) index[name.slice(0, -4)] = statSync(join(dir, name)).size; } catch {}
    writeFileSync(join(this.instanceRoot(instance), "shards.json"), JSON.stringify(index));
  }
  instance(id) { return this.layout.instances.find((entry) => entry.id === id) || null; }
  instanceState(id) { return this.instanceStates.get(id) || null; }
  setInstanceEnabled(id, enabled, { restart = false } = {}) {
    const instance = this.instance(id);
    if (!instance) throw new Error("Unknown Backbone instance.");
    const previous = this.instanceState(id) || {};
    const now = Date.now();
    const next = {
      enabled: !!enabled,
      lastStartedAt: enabled ? now : Number(previous.lastStartedAt || now),
      lastStoppedAt: enabled ? null : now,
      restartCount: Math.max(0, Number(previous.restartCount || 0)) + (restart ? 1 : 0),
    };
    this.instanceStates.set(id, next);
    this.schedulePersist();
    return this.instanceStatus(instance);
  }
  instanceStatus(instance) {
    const state = this.instanceState(instance.id) || { enabled: true };
    return {
      id: instance.id,
      label: instance.label || instance.id,
      state: state.enabled ? "online" : "stopped",
      enabled: state.enabled !== false,
      quotaBytes: instance.quotaBytes,
      usedBytes: this.usedBytes(instance),
      lastStartedAt: state.lastStartedAt || null,
      lastStoppedAt: state.lastStoppedAt || null,
      restartCount: Number(state.restartCount || 0),
      failureDomainId: instance.failureDomainId,
      storageDeviceId: instance.storageDeviceId,
    };
  }
  instanceStatuses() { return this.layout.instances.map((instance) => this.instanceStatus(instance)); }
  enabledInstances() { return this.layout.instances.filter((entry) => this.instanceState(entry.id)?.enabled !== false); }
  aggregateStatus() {
    const instances = this.enabledInstances();
    return {
      nodeId: this.layout.physicalHostId,
      nodeName: this.layout.label || "TheMeshVault Backbone",
      protocolVersion: 3,
      capabilities: ["mesh-control-lite-v3", "mesh-backbone-v3", "backbone-storage-v3"],
      devicePublicKey: this.layout.backbonePublicKey || null,
      failureDomainId: instances[0]?.failureDomainId || `physical-host:${this.layout.physicalHostId}`,
      storageDeviceId: `physical-host:${this.layout.physicalHostId}`,
      capacityBytes: instances.reduce((sum, entry) => sum + Number(entry.quotaBytes || 0), 0),
      usedBytes: instances.reduce((sum, entry) => sum + this.usedBytes(entry), 0),
      leaseExpiresAt: new Date(Date.now() + 120000).toISOString(),
    };
  }
  advertisedInstances() {
    return this.enabledInstances().length ? [this.aggregateStatus()] : [];
  }
  putLease(node) { if (node?.nodeId) this.leases.set(node.nodeId, { ...node, expiresAt: Date.now() + 120000 }); }
  peers() { const now = Date.now(); for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id); return [...this.advertisedInstances(), ...this.leases.values()].slice(0, 512); }
  storageInstance(instanceId, expectedSize = 0) {
    const direct = this.instance(instanceId);
    if (direct) return direct;
    if (instanceId !== this.layout.physicalHostId) return null;
    return this.enabledInstances()
      .map((instance) => ({ instance, free: Number(instance.quotaBytes || 0) - this.usedBytes(instance) }))
      .filter((entry) => entry.free >= expectedSize)
      .sort((left, right) => right.free - left.free)[0]?.instance || null;
  }
  startShard(instanceId, transferId, shardHash, expectedSize, expectedHash) {
    const instance = this.storageInstance(instanceId, expectedSize); if (!instance) throw new Error("No enabled Backbone instance has enough space.");
    if (this.instanceState(instance.id)?.enabled === false) throw new Error("Backbone instance is stopped.");
    if (!/^[a-f0-9]{64}$/i.test(shardHash) || shardHash !== expectedHash) throw new Error("Invalid shard hash.");
    if (expectedSize < 1 || expectedSize > 4 * 1024 * 1024) throw new Error("Shard exceeds the Backbone packet contract.");
    if (this.usedBytes(instance) + expectedSize > instance.quotaBytes) throw new Error("Backbone instance quota exceeded.");
    const finalPath = this.shardPath(instance, shardHash); mkdirSync(dirname(finalPath), { recursive: true });
    const tempPath = `${finalPath}.${safe(transferId)}.part`; writeFileSync(tempPath, Buffer.alloc(0));
    this.uploads.set(transferId, { instance, shardHash, expectedSize, expectedHash, tempPath, finalPath, chunks: [] });
  }
  appendShard(transferId, chunk) {
    const upload = this.uploads.get(transferId); if (!upload) throw new Error("Unknown shard transfer.");
    const bytes = Buffer.from(chunk, "base64");
    const total = upload.chunks.reduce((sum, item) => sum + item.length, 0) + bytes.length;
    if (bytes.length > 65536 || total > upload.expectedSize) throw new Error("Invalid shard chunk.");
    upload.chunks.push(bytes); return total;
  }
  finishShard(transferId) {
    const upload = this.uploads.get(transferId); if (!upload) throw new Error("Unknown shard transfer.");
    try {
      const bytes = Buffer.concat(upload.chunks);
      if (bytes.length !== upload.expectedSize || createHash("sha256").update(bytes).digest("hex") !== upload.expectedHash) throw new Error("Shard verification failed.");
      writeFileSync(upload.tempPath, bytes); renameSync(upload.tempPath, upload.finalPath); this.writeIndex(upload.instance); return true;
    } finally { this.uploads.delete(transferId); try { if (existsSync(upload.tempPath)) rmSync(upload.tempPath); } catch {} }
  }
  getShard(instanceId, hash) {
    const instances = instanceId === this.layout.physicalHostId ? this.layout.instances : [this.instance(instanceId)].filter(Boolean);
    for (const instance of instances) { try { return readFileSync(this.shardPath(instance, hash)); } catch {} }
    return null;
  }
  deleteShard(instanceId, hash) {
    const instances = instanceId === this.layout.physicalHostId ? this.layout.instances : [this.instance(instanceId)].filter(Boolean);
    if (!instances.length) return false;
    for (const instance of instances) { const path = this.shardPath(instance, hash); if (existsSync(path)) { rmSync(path); this.writeIndex(instance); } }
    return true;
  }
  putControl(object) {
    if (!object?.objectId || !GROUP_LIMITS[object.kind] || sizeOf(object) > 4 * 1024 * 1024) throw new Error("Invalid control object.");
    const key = semanticKey(object);
    let accepted = object;
    for (const row of this.controls.values()) {
      if (semanticKey(row) !== key) continue;
      if (Number(row.createdAt) > Number(accepted.createdAt)
        || (Number(row.createdAt) === Number(accepted.createdAt) && String(row.objectId) > String(accepted.objectId))) accepted = row;
    }
    for (const [id, row] of this.controls) if (semanticKey(row) === key && id !== accepted.objectId) this.controls.delete(id);
    this.controls.set(accepted.objectId, accepted);
    const group = [...this.controls.values()].filter((row) => row.kind === object.kind && String(row.lookupKey || "") === String(object.lookupKey || "")).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    for (const row of group.slice(GROUP_LIMITS[object.kind])) this.controls.delete(row.objectId);
    if (this.controls.size > 4096) {
      const excess = [...this.controls.values()].sort((a, b) => Number(a.createdAt) - Number(b.createdAt)).slice(0, this.controls.size - 4096);
      for (const row of excess) this.controls.delete(row.objectId);
    }
    this.schedulePersist(); return true;
  }
  queryControl(kind, lookupKey, limit = 20) { return [...this.controls.values()].filter((row) => row.kind === kind && row.lookupKey === lookupKey && row.expiresAt > Date.now()).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.min(100, limit)); }
  putManifest(envelope) { if (!envelope?.manifestId || sizeOf(envelope) > 4 * 1024 * 1024) throw new Error("Invalid manifest envelope."); this.manifests.set(envelope.manifestId, envelope); this.schedulePersist(); return true; }
  getManifest(manifestId) { return this.manifests.get(manifestId) || null; }
  putFragmentLocation(shardHash, nodeId) {
    if (!/^[a-f0-9]{64}$/i.test(String(shardHash || "")) || !nodeId) return false;
    const locations = this.fragments.get(shardHash) || new Map();
    locations.set(nodeId, Date.now() + 5 * 60 * 1000); this.fragments.set(shardHash, locations); this.schedulePersist(); return true;
  }
  fragmentLocations(shardHash) {
    const now = Date.now(); const locations = this.fragments.get(shardHash) || new Map();
    for (const [nodeId, expiresAt] of locations) if (expiresAt <= now) locations.delete(nodeId);
    return [...locations.keys()].map((nodeId) => ({ shardHash, nodeId }));
  }
}
