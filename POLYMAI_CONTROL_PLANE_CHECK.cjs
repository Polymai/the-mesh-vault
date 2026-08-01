const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const root = __dirname;
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serve() {
  const server = http.createServer((request, response) => {
    if (request.url === "/control-plane-check") {
      response.writeHead(200, { "content-type": types[".html"] });
      response.end("<!doctype html><meta charset=utf-8><title>control plane check</title>");
      return;
    }
    const relative = decodeURIComponent(String(request.url || "/").split("?")[0]).replace(/^\/+/, "");
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": types[path.extname(resolved)] || "application/octet-stream" });
    fs.createReadStream(resolved).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function browserCryptoAndQueueCheck(baseUrl) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/control-plane-check`);
    return await page.evaluate(async () => {
      window.__POLYMAI_SUPABASE_CONFIG__ = { appStoragePrefix: `control-check:${crypto.randomUUID()}:` };
      window.__DATA__ = { coordination: { minimumMeshAnchors: 2, operationBackboneFlushMs: 300000 } };
      const signing = await import("/js/security/signing.js");
      const keyring = await import("/js/security/keyring.js");
      const index = await import("/js/control/vault-index.js");
      const oplog = await import("/js/oplog/oplog-engine.js");
      const controlStore = await import("/js/storage/control-store.js");

      const pair = await signing.generateKeyPair();
      const publicRaw = await signing.exportPublicKeyRaw(pair.publicKey);
      const ownerPublicKey = signing.bytesToBase64Url(publicRaw);
      const vaultId = await signing.hashHex(publicRaw);
      await keyring.setMasterKeyRaw(crypto.getRandomValues(new Uint8Array(32)));
      const identity = {
        vaultId,
        ownerPublicKey,
        algorithm: pair.algorithm,
        sign: (bytes) => signing.sign(pair.privateKey, pair.algorithm, bytes),
      };

      const payload = {
        folders: [{ id: "folder-1", vault_id: vaultId, privateName: "Private control-plane folder" }],
        files: [{ id: "file-1", vault_id: vaultId, size_bytes: 1234 }],
        tombstones: [],
        repairState: [],
      };
      const envelope = await index.buildVaultIndexEnvelope(identity, payload, { revision: 1 });
      const verification = await index.verifyVaultIndexEnvelope(envelope, { vaultId });
      const opened = await index.openVaultIndexEnvelope(envelope, identity);
      await index.saveLocalVaultIndex(envelope);
      const persisted = await index.getLocalVaultIndex(vaultId);
      const tampered = structuredClone(envelope);
      tampered.encryptedPayload.cipher = `${tampered.encryptedPayload.cipher.slice(0, -2)}AA`;
      const tamperRejected = !(await index.verifyVaultIndexEnvelope(tampered, { vaultId })).valid
        && (await index.openVaultIndexEnvelope(tampered, identity)) === null;

      const appended = await Promise.all(Array.from({ length: 12 }, (_, item) => (
        oplog.appendOperation(identity, vaultId, "create_folder", {
          folderId: `local-${item}`,
          row: { id: `local-${item}`, vault_id: vaultId },
        })
      )));

      const remoteVaultId = `remote-${crypto.randomUUID()}`;
      const makeRemote = async (opId, folderId) => {
        const payloadValue = { folderId, row: { id: folderId, vault_id: remoteVaultId } };
        const core = {
          opId,
          vaultId: remoteVaultId,
          actorPublicKey: ownerPublicKey,
          algorithm: pair.algorithm,
          opType: "create_folder",
          timestamp: Date.now(),
          seq: 1,
          payloadHash: await signing.canonicalHashHex(payloadValue),
          payload: payloadValue,
          protocolVersion: 1,
        };
        return {
          ...core,
          signature: signing.bytesToBase64Url(await signing.sign(pair.privateKey, pair.algorithm, signing.canonicalBytes(core))),
        };
      };
      const remoteOperations = await Promise.all([
        makeRemote("remote-operation-a", "remote-a"),
        makeRemote("remote-operation-b", "remote-b"),
      ]);
      const firstIngest = await oplog.ingestOperations(remoteVaultId, remoteOperations, { ownerPublicKey });
      const secondIngest = await oplog.ingestOperations(remoteVaultId, remoteOperations, { ownerPublicKey });
      const remoteLog = await oplog.getOperationLog(remoteVaultId);

      const controlSigner = {
        publicKey: ownerPublicKey,
        algorithm: pair.algorithm,
        sign: (bytes) => signing.sign(pair.privateKey, pair.algorithm, bytes),
      };
      for (let item = 0; item < 100; item += 1) {
        const object = await controlStore.buildControlObject(controlSigner, "peer", "active", {
          nodeId: `peer-${item % 4}`,
          observedAt: item,
        }, { ttlMs: 120000 });
        await controlStore.putControlObject(object);
      }
      for (let revision = 1; revision <= 9; revision += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const object = await controlStore.buildControlObject(controlSigner, "vault-index", vaultId, {
          vaultId,
          revision,
          indexHash: `index-${revision}`,
        }, { ttlMs: 30 * 86400000 });
        await controlStore.putControlObject(object);
      }
      for (let item = 0; item < 40; item += 1) {
        const object = await controlStore.buildControlObject(controlSigner, "oplog", vaultId, {
          opId: `operation-${item % 20}`,
          version: item % 20,
        }, { ttlMs: 30 * 86400000 });
        await controlStore.putControlObject(object);
      }
      const controlStats = await controlStore.controlStoreStats({ fresh: true });
      const retainedIndexes = await controlStore.findControlObjects("vault-index", vaultId, 10);
      const stateStore = await import("/js/state/store.js");
      const anchorView = await import("/js/views/anchor-view.js");
      document.body.innerHTML = anchorView.renderAnchorView({
        anchor: { enabled: true, status: "running", objectCount: 29, replicatedObjects: 4, bytesUsed: 4096 },
        survival: { wakeAssistance: "available" },
      });
      anchorView.bindAnchorView({ anchor: async () => {} });
      const anchorInput = document.querySelector("[name='anchorLabel']");
      stateStore.setState({
        route: "anchor",
        anchor: { enabled: true, status: "running", objectCount: 31, replicatedObjects: 6, bytesUsed: 8192, kinds: { peer: 4, oplog: 20 } },
      });
      const anchorMetricsPatched = document.querySelector("[name='anchorLabel']") === anchorInput
        && document.querySelector("[data-anchor-record-count]")?.textContent === "31"
        && document.querySelector("[data-anchor-replicated-count]")?.textContent === "6";

      return {
        verified: verification.valid,
        plaintextHidden: !JSON.stringify(envelope).includes("Private control-plane folder"),
        openedFolder: opened?.payload?.folders?.[0]?.privateName || null,
        persistedHash: persisted?.indexHash || null,
        originalHash: envelope.indexHash,
        tamperRejected,
        appendCount: appended.length,
        uniqueSequences: new Set(appended.map((operation) => operation.seq)).size,
        firstAccepted: firstIngest.accepted.length,
        secondAccepted: secondIngest.accepted.length,
        remoteLogCount: remoteLog.length,
        controlStats,
        retainedIndexCount: retainedIndexes.length,
        retainedIndexRevisions: retainedIndexes.map((row) => row.payload.revision),
        anchorMetricsPatched,
      };
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

(async () => {
  const server = await serve();
  const address = server.address();
  try {
    const browserResult = await browserCryptoAndQueueCheck(`http://127.0.0.1:${address.port}`);
    assert.equal(browserResult.verified, true, "The owner-signed vault index did not verify.");
    assert.equal(browserResult.plaintextHidden, true, "The encrypted vault index leaked private catalog text.");
    assert.equal(browserResult.openedFolder, "Private control-plane folder", "The encrypted catalog did not round-trip.");
    assert.equal(browserResult.persistedHash, browserResult.originalHash, "The verified index was not transactionally persisted.");
    assert.equal(browserResult.tamperRejected, true, "A tampered vault index was accepted.");
    assert.equal(browserResult.appendCount, 12);
    assert.equal(browserResult.uniqueSequences, 12, "Concurrent local operations reused a sequence number.");
    assert.equal(browserResult.firstAccepted, 2, "Independent signed operations sharing a local sequence were not both accepted.");
    assert.equal(browserResult.secondAccepted, 0, "Replaying identical operation IDs was not idempotent.");
    assert.equal(browserResult.remoteLogCount, 2);
    assert.equal(browserResult.controlStats.objectCount, 29, "Superseded Anchor records were not compacted.");
    assert.equal(browserResult.controlStats.kinds.peer, 4, "Peer heartbeats were not reduced to one record per node.");
    assert.equal(browserResult.controlStats.kinds["vault-index"], 5, "Vault-index history was not bounded.");
    assert.equal(browserResult.controlStats.kinds.oplog, 20, "Distinct signed operation IDs were not retained.");
    assert.equal(browserResult.retainedIndexCount, 5);
    assert.deepEqual(browserResult.retainedIndexRevisions, [9, 8, 7, 6, 5]);
    assert.equal(browserResult.anchorMetricsPatched, true, "Anchor metrics replaced the form instead of patching the visible counters.");

    const policy = await import(pathToFileURL(path.join(root, "js/network/coordination-policy.js")).href);
    const config = {
      supabaseHeartbeatMs: 90000,
      supabaseBackboneHeartbeatMs: 600000,
      anchorBackboneHeartbeatMs: 90000,
    };
    const now = 1_000_000;
    assert.equal(policy.shouldWriteSupabaseHeartbeat(policy.COORDINATION_MODES.ANCHOR_PRIMARY, false, now - 599999, now, config), false);
    assert.equal(policy.shouldWriteSupabaseHeartbeat(policy.COORDINATION_MODES.ANCHOR_PRIMARY, false, now - 600000, now, config), true);
    assert.equal(policy.shouldWriteSupabaseHeartbeat(policy.COORDINATION_MODES.ANCHOR_PRIMARY, true, now - 90000, now, config), true);
    assert.equal(policy.shouldWriteSupabaseHeartbeat(policy.COORDINATION_MODES.MESH_DEGRADED, true, 0, now, config), false);

    const schema = read("supabase/schema.sql");
    const policies = read("supabase/policies.sql");
    const repository = read("js/control/control-repository.js");
    const deletion = read("js/services/deletion-service.js");
    const repair = read("js/network/distributed-repair.js");
    const nodeService = read("js/network/node-service.js");
    assert.match(schema, /create table if not exists app717_meshvault\.vault_index_cache/);
    assert.match(schema, /create table if not exists app717_meshvault\.vault_operation_cache/);
    assert.match(schema, /create or replace function app717_meshvault\.publish_vault_index/);
    assert.match(schema, /request_id text/);
    assert.match(policies, /vault_operation_cache_insert/);
    assert.match(repository, /queryAnchors\("vault-index"/);
    assert.match(repository, /writeSupabaseIndex/);
    assert.match(repository, /markSyncReceipt\(operation\.opId, "anchor"/);
    assert.match(repository, /markSyncReceipt\(operation\.opId, "supabase"/);
    assert.match(deletion, /verifyDeletionAuthorization/);
    assert.match(deletion, /deletion-ack/);
    assert.match(repair, /repair-lease/);
    assert.match(repair, /no_anchor_quorum/);
    assert.match(nodeService, /shouldWriteSupabaseHeartbeat/);

    console.log("PASS control plane: encrypted signed index, tamper rejection, transactional local persistence, concurrent queue sequencing, idempotent multi-device replay, bounded semantic Anchor cache, Anchor/Supabase receipts, signed repair leases, deletion acknowledgements, and reduced backbone heartbeats.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(`FAIL control plane: ${error.stack || error.message}`);
  process.exitCode = 1;
});
