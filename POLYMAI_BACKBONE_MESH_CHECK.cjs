const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

global.fetch = async () => { throw new Error("Backbone checks must never contact Supabase or another network service."); };
global.WebSocket = class BlockedWebSocket { constructor() { throw new Error("Backbone checks must never open a network socket."); } };

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

(async () => {
  const policy = await import(pathToFileURL(path.join(root, "js/network/coordination-policy.js")).href);
  const service = read("js/network/anchor-service.js");
  const node = read("js/network/node-service.js");
  const registry = read("js/network/providers/provider-registry.js");
  const backboneProvider = read("js/network/providers/backbone-seed-provider.js");
  const server = read("native/backbone-host/backbone-server.mjs");
  const store = read("native/backbone-host/backbone-store.mjs");
  const layoutSource = read("native/backbone-host/storage-layout.mjs");
  const android = read("native/android/PolymaiAppMeshClient.java");
  const schema = read("supabase/schema.sql");

  assert.match(service, /CONTROL_PARTICIPANT_CAPABILITY/);
  assert.match(service, /return \[\s*CONTROL_PARTICIPANT_CAPABILITY,/);
  assert.match(service, /BACKBONE_CAPABILITY/);
  assert.match(node, /connectFallbackAfterMeshAttempt/);
  assert.match(node, /supabaseColdStartDelayMs/);
  assert.match(node, /excludeProviders:\s*supabaseFallbackOpened/);
  assert.match(registry, /excludeProviders/);
  assert.match(backboneProvider, /^\s*if \(!seed\.publicKey/m);
  assert.match(backboneProvider, /verifyServerMessage/);
  assert.match(server, /verifyClientObject/);
  assert.match(server, /nodeId:\s*client\.nodeId/);
  assert.match(server, /putFragmentLocation\(payload\?\.shardHash, client\.nodeId\)/);
  assert.match(store, /devicePublicKey:\s*this\.layout\.backbonePublicKey/);
  assert.match(store, /Shard verification failed/);
  assert.match(layoutSource, /windowsPhysicalDevice/);
  assert.match(layoutSource, /failureDomainId:\s*`physical-host:/);
  assert.match(layoutSource, /Configured quotas overcommit physical device/);
  assert.match(android, /boolean isControlParticipant\(\) \{ return true; \}/);
  assert.match(android, /configuration\.anchorEnabled \? "Backbone" : "Mesh node"/);
  assert.match(schema, /backbone_url text/);
  assert.match(schema, /backbone_public_key text/);

  const now = Date.now();
  const participant = { nodeId: "ordinary", capabilities: ["mesh-control-lite-v3"], protocolVersion: 3, leaseExpiresAt: new Date(now + 60000).toISOString() };
  const backbone = { nodeId: "stable", capabilities: ["mesh-control-lite-v3", "mesh-backbone-v3"], protocolVersion: 3, leaseExpiresAt: new Date(now + 60000).toISOString() };
  assert.equal(policy.isHealthyControlParticipant(participant, now), true);
  assert.equal(policy.isHealthyBackbone(participant, now), false);
  assert.equal(policy.isHealthyBackbone(backbone, now), true);
  const warm = policy.evaluateCoordination({}, { participantCount: 2, backboneCount: 0, supabaseUp: true, now });
  assert.equal(warm.mode, policy.COORDINATION_MODES.HYBRID);
  const stable = policy.evaluateCoordination(warm, { participantCount: 2, backboneCount: 0, supabaseUp: true, now: now + 121000 });
  assert.equal(stable.mode, policy.COORDINATION_MODES.ANCHOR_PRIMARY);
  assert.equal(policy.providerOrder(stable.mode).includes("supabase"), false);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "themeshvault-backbone-check-"));
  try {
    const { validateStorageLayout } = await import(pathToFileURL(path.join(root, "native/backbone-host/storage-layout.mjs")).href);
    const hostId = "12345678-1234-4123-8123-123456789abc";
    const layout = validateStorageLayout({
      physicalHostId: hostId,
      reserveBytesPerPool: 268435456,
      storagePools: [{ id: "one", path: temporaryRoot, physicalDeviceId: "test-disk" }],
      instances: [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", poolId: "one", quotaBytes: 1048576 },
        { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", poolId: "one", quotaBytes: 1048576 },
      ],
    });
    assert.equal(new Set(layout.instances.map((entry) => entry.failureDomainId)).size, 1, "logical instances on one host must remain one failure domain");
    assert.equal(new Set(layout.instances.map((entry) => entry.storageDeviceId)).size, 1, "logical instances on one disk must remain one storage device");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  console.log("PASS Backbone mesh: automatic control participation, pinned WSS identity, delayed Supabase fallback, honest host/disk domains and keyless Android participation. No network requests executed.");
})().catch((error) => {
  console.error(`FAIL Backbone mesh: ${error.stack || error.message}`);
  process.exitCode = 1;
});
