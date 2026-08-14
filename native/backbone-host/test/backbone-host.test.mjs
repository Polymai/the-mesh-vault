import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { validateStorageLayout } from "../storage-layout.mjs";
import { BackboneStore } from "../backbone-store.mjs";
import { createBackboneServer } from "../backbone-server.mjs";

function utf8Buffer(value) {
  return Buffer.from(new TextEncoder().encode(value));
}

function fixture(count = 2) {
  const root = mkdtempSync(join(tmpdir(), "meshvault-backbone-"));
  const config = {
    protocolVersion: 3,
    launcherHostId: `launcher-${randomUUID()}`,
    physicalHostId: `test-${randomUUID()}`,
    reserveBytesPerPool: 268435456,
    storagePools: [{ id: "one", path: root, physicalDeviceId: "test-disk" }],
    instances: Array.from({ length: count }, (_, index) => ({ id: randomUUID(), label: `Node ${index + 1}`, poolId: "one", quotaBytes: 16 * 1024 * 1024 })),
  };
  return { root, config };
}

test("logical instances share one honest physical failure domain", () => {
  const { root, config } = fixture(3);
  try {
    const layout = validateStorageLayout(config);
    assert.equal(layout.instances.length, 3);
    assert.equal(new Set(layout.instances.map((entry) => entry.failureDomainId)).size, 1);
    assert.equal(new Set(layout.instances.map((entry) => entry.storageDeviceId)).size, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("logical instances can stop and restart without becoming extra physical devices", () => {
  const { root, config } = fixture(3);
  try {
    const layout = validateStorageLayout(config); const store = new BackboneStore(layout);
    assert.equal(store.advertisedInstances().length, 3);
    assert.equal(store.setInstanceEnabled(layout.instances[1].id, false).state, "stopped");
    assert.equal(store.advertisedInstances().length, 2);
    assert.throws(() => store.startShard(layout.instances[1].id, randomUUID(), "a".repeat(64), 1, "a".repeat(64)), /stopped/i);
    const restarted = store.setInstanceEnabled(layout.instances[1].id, true, { restart: true });
    assert.equal(restarted.state, "online");
    assert.equal(restarted.restartCount, 1);
    assert.equal(store.advertisedInstances().length, 3);
    assert.equal(new Set(store.instanceStatuses().map((entry) => entry.failureDomainId)).size, 1);
    store.flush();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("encrypted shard packets commit only after exact hash verification", () => {
  const { root, config } = fixture(1);
  try {
    const layout = validateStorageLayout(config); const store = new BackboneStore(layout); const bytes = utf8Buffer("opaque encrypted test shard"); const hash = createHash("sha256").update(bytes).digest("hex"); const transferId = randomUUID();
    store.startShard(layout.instances[0].id, transferId, hash, bytes.length, hash);
    store.appendShard(transferId, bytes.subarray(0, 8).toString("base64"));
    store.appendShard(transferId, bytes.subarray(8).toString("base64"));
    assert.equal(store.finishShard(transferId), true);
    assert.deepEqual(store.getShard(layout.instances[0].id, hash), bytes);
    assert.equal(store.advertisedInstances()[0].usedBytes, bytes.length);
    store.flush();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bad hash never becomes a stored shard", () => {
  const { root, config } = fixture(1);
  try {
    const layout = validateStorageLayout(config); const store = new BackboneStore(layout); const bytes = utf8Buffer("wrong bytes"); const expected = createHash("sha256").update(utf8Buffer("right bytes")).digest("hex"); const transferId = randomUUID();
    store.startShard(layout.instances[0].id, transferId, expected, bytes.length, expected);
    store.appendShard(transferId, bytes.toString("base64"));
    assert.throws(() => store.finishShard(transferId), /verification failed/i);
    assert.equal(store.getShard(layout.instances[0].id, expected), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loopback manager reports and controls real instance state", async () => {
  const { root, config } = fixture(2);
  const identityPath = join(root, "manager-test-identity.jwk");
  try {
    config.listen = { host: "127.0.0.1", port: 0 };
    config.tls = { certificatePath: "", privateKeyPath: "" };
    const layout = validateStorageLayout(config);
    const service = createBackboneServer(config, { ...layout, publicUrl: "" }, identityPath);
    const address = await service.start();
    const endpoint = `http://127.0.0.1:${address.port}/_themeshvault/backbone`;
    const headers = { Origin: "https://themeshvault.com" };
    const initial = await fetch(`${endpoint}/status`, { headers }).then((response) => response.json());
    assert.equal(initial.ok, true); assert.equal(initial.instances.length, 2); assert.equal(initial.instances[0].state, "online");
    assert.equal(initial.launcherHostId, config.launcherHostId);
    const id = initial.instances[0].id;
    const stopped = await fetch(`${endpoint}/instances/${id}/stop`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" }).then((response) => response.json());
    assert.equal(stopped.instance.state, "stopped");
    const restarted = await fetch(`${endpoint}/instances/${id}/restart`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" }).then((response) => response.json());
    assert.equal(restarted.instance.state, "online"); assert.equal(restarted.instance.restartCount, 1);
    const denied = await fetch(`${endpoint}/status`, { headers: { Origin: "https://example.com" } });
    assert.equal(denied.status, 403);
    await service.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
