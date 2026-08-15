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
      response.end("<!doctype html><meta charset=utf-8><title>control plane check</title><script src='/js/vendor/nacl-fast.min.js'></script>");
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
      await keyring.initializeKeyring(crypto.getRandomValues(new Uint8Array(32)));
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
          protocolVersion: 3,
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
    const profileUpgrade = read("js/network/profile-upgrade-coordinator.js");
    const segmentService = read("js/services/segment-service.js");
    const uploadFlow = read("js/flows/upload-flow.js");
    const deleteFlow = read("js/flows/delete-flow.js");
    const recoveryCoordinator = read("js/network/recovery-coordinator.js");
    const shardRetrieval = read("js/network/shard-retrieval.js");
    const fragmentStore = read("js/storage/fragment-store.js");
    assert.match(schema, /create table if not exists app717_meshvault\.vault_index_cache/);
    assert.match(schema, /create table if not exists app717_meshvault\.vault_operation_cache/);
    assert.match(schema, /create or replace function app717_meshvault\.publish_vault_index/);
    assert.match(schema, /create or replace function app717_meshvault\.commit_segment_profile_upgrade/);
    assert.match(schema, /create or replace function app717_meshvault\.claim_segment_profile_upgrade/);
    assert.match(schema, /create or replace function app717_meshvault\.renew_segment_profile_upgrade_claim/);
    assert.match(schema, /create or replace function app717_meshvault\.release_segment_profile_upgrade_claim/);
    assert.match(schema, /create or replace function app717_meshvault\.link_version_segment/);
    assert.match(schema, /create or replace function app717_meshvault\.begin_file_deletion/);
    assert.match(schema, /profile-upgrade version set is incomplete/);
    assert.match(schema, /profile-upgrade shard generation is incomplete/);
    assert.match(schema, /profile-upgrade shard lacks a verified durable placement/);
    assert.match(schema, /profile_claim_token=p_claim_token and profile_claim_expires_at>now\(\)/);
    assert.match(schema, /content_segments_canonical_identifiers_check/);
    assert.match(schema, /segment_shards_canonical_hash_check/);
    assert.match(schema, /request_id text/);
    assert.match(policies, /vault_operation_cache_insert/);
    assert.match(policies, /revoke insert on app717_meshvault\.version_segments from authenticated/);
    assert.match(policies, /revoke update on app717_meshvault\.version_segments from authenticated/);
    assert.match(policies, /revoke delete on app717_meshvault\.shard_placements from authenticated/);
    assert.match(policies, /grant execute on function app717_meshvault\.begin_file_deletion\(text,uuid\) to authenticated/);
    assert.match(repository, /queryAnchors\("vault-index"/);
    assert.match(repository, /writeSupabaseIndex/);
    assert.match(repository, /markSyncReceipt\(operation\.opId, "anchor"/);
    assert.match(repository, /markSyncReceipt\(operation\.opId, "supabase"/);
    assert.match(deletion, /verifyDeletionAuthorization/);
    assert.match(deletion, /deletion-ack/);
    assert.match(repair, /repair-lease/);
    assert.match(repair, /no_anchor_quorum/);
    assert.match(nodeService, /shouldWriteSupabaseHeartbeat/);
    assert.match(segmentService, /rpc\("link_version_segment"/);
    assert.match(segmentService, /rpc\("begin_file_deletion"/);
    assert.match(segmentService, /rpc\("renew_segment_profile_upgrade_claim"/);
    assert.match(uploadFlow, /linkStableSegment/);
    assert.doesNotMatch(uploadFlow, /incrementSegmentReference/);
    // C32: initial uploads reserve every physical destination before writing,
    // verify it only after acknowledged transfer, and retain lifecycle cleanup
    // metadata for ambiguous or failed writes.
    const firstUploadReservation = uploadFlow.indexOf('reservation = await recordShardPlacement({ vaultId, shardId: shard.id, node: candidate, role: "durable", status: "pending" })');
    const firstUploadTransfer = uploadFlow.indexOf("await withRetry", firstUploadReservation);
    const firstUploadVerification = uploadFlow.indexOf('transitionShardPlacement(vaultId, reservation.id, "verified")', firstUploadTransfer);
    assert.ok(firstUploadReservation >= 0 && firstUploadTransfer > firstUploadReservation && firstUploadVerification > firstUploadTransfer,
      "Initial upload must reserve its destination before transfer and verify it only after acknowledgement.");
    assert.ok((uploadFlow.match(/status: "pending"/g) || []).length >= 2, "Remote and local upload destinations must both be reserved as pending.");
    const failedUploadCleanupStart = uploadFlow.indexOf("async function retainFailedSegmentCleanup");
    const failedUploadCleanupEnd = uploadFlow.indexOf("function segmentManifestEntry", failedUploadCleanupStart);
    const failedUploadCleanup = uploadFlow.slice(failedUploadCleanupStart, failedUploadCleanupEnd);
    assert.ok(failedUploadCleanupStart >= 0 && failedUploadCleanupEnd > failedUploadCleanupStart, "Failed initial-upload cleanup must remain an explicit lifecycle phase.");
    assert.match(failedUploadCleanup, /status: "deleting"/);
    assert.match(failedUploadCleanup, /retireUploadPlacement/);
    assert.doesNotMatch(failedUploadCleanup, /deleteShard\(/);
    assert.doesNotMatch(failedUploadCleanup, /content_segments"\)\.delete/);
    const uploadFailureCatch = uploadFlow.slice(uploadFlow.lastIndexOf("  } catch (error) {"));
    assert.match(uploadFailureCatch, /retainFailedSegmentCleanup/);
    assert.doesNotMatch(uploadFailureCatch, /deleteShard\(/);
    assert.doesNotMatch(uploadFailureCatch, /content_segments"\)\.delete/);
    const uploadReadyAt = uploadFlow.indexOf("await markSegmentReady");
    const uploadOwnershipClearAt = uploadFlow.indexOf("buildingSegmentId = null", uploadReadyAt);
    const uploadLinkAt = uploadFlow.indexOf("segment = await linkStableSegment", uploadOwnershipClearAt);
    assert.ok(uploadReadyAt >= 0 && uploadOwnershipClearAt > uploadReadyAt && uploadLinkAt > uploadOwnershipClearAt,
      "A ready segment must leave private build-cleanup ownership before version linking.");
    // C30: deleting one deduplicated file must serialize with concurrent links,
    // derive the count from actual remaining links and preserve cleanup links
    // only for segments that atomically reached zero references.
    assert.match(deleteFlow, /beginAtomicFileDeletion/);
    assert.doesNotMatch(deleteFlow, /reference_count/);
    assert.doesNotMatch(deleteFlow, /tombstoneFile/);
    assert.match(schema, /not \(vs\.file_version_id=any\(v_version_ids\)\)/);
    assert.match(schema, /set status='deleting', reference_count=0/);
    assert.match(schema, /set deletion_authorization=null/);
    assert.match(schema, /set revoked=true/);
    assert.match(schema, /for update of f/);
    assert.match(schema, /deletion_authorization->>'protocolVersion' is distinct from '3'/);
    assert.match(schema, /jsonb_typeof\(sp\.deletion_authorization->'issuedAt'\) is distinct from 'number'/);
    // The link and deletion paths must share one global file->segment lock
    // order. These ordering checks prevent a future refactor from reopening
    // the missed-link race while retaining all expected SQL tokens.
    const linkFunctionStart = schema.indexOf("create or replace function app717_meshvault.link_version_segment");
    const linkFunctionEnd = schema.indexOf("create or replace function app717_meshvault.begin_file_deletion", linkFunctionStart);
    const linkFunction = schema.slice(linkFunctionStart, linkFunctionEnd);
    const linkFileLock = linkFunction.indexOf("for key share of f,fv");
    const linkSegmentLock = linkFunction.indexOf("select * into v_segment from app717_meshvault.content_segments");
    assert.ok(linkFunctionStart >= 0 && linkFunctionEnd > linkFunctionStart, "version-link SQL function must be present");
    assert.ok(linkFileLock >= 0 && linkSegmentLock > linkFileLock, "version linking must lock the file before its segment");

    const deletionFunctionEnd = schema.indexOf("create or replace function app717_meshvault.commit_segment_profile_upgrade", linkFunctionEnd);
    const deletionFunction = schema.slice(linkFunctionEnd, deletionFunctionEnd);
    const deletionFileLock = deletionFunction.indexOf("for update of f");
    const deletionVersionCollection = deletionFunction.indexOf("select coalesce(array_agg(fv.id order by fv.id)");
    const deletionLinkCollection = deletionFunction.indexOf("from app717_meshvault.version_segments vs");
    const deletionSegmentLock = deletionFunction.indexOf("order by cs.id for update");
    assert.ok(deletionFunctionEnd > linkFunctionEnd, "file-deletion SQL function must be present");
    assert.doesNotMatch(deletionFunction, /%rowtype[\s\S]{0,1200}into\s+v_file\s*,/i,
      "a PL/pgSQL row variable cannot be one item in a multiple-target INTO list");
    assert.match(deletionFunction, /select v\.owner_public_key into v_owner_public_key[\s\S]{0,260}for update of f/,
      "file deletion must use a compile-safe scalar INTO while retaining the file-row lock");
    assert.ok(deletionFileLock >= 0 && deletionVersionCollection > deletionFileLock && deletionLinkCollection > deletionVersionCollection,
      "file deletion must lock the file before collecting all version links");
    assert.ok(deletionSegmentLock > deletionLinkCollection, "file deletion must collect links before locking segments");
    // C31: every physical content-addressed deletion is protected by the same
    // fail-closed, node-wide placement lookup, including Anchor-delivered orders.
    assert.match(deletion, /function hashHasPhysicalPlacementOnNode/);
    assert.match(deletion, /function deleteShardIfUnreferenced/);
    assert.match(deletion, /withShardMutationLock\(shardHash/);
    assert.match(fragmentStore, /function withShardMutationLock/);
    assert.match(fragmentStore, /putShardUnlocked/);
    assert.match(fragmentStore, /deleteShardUnlocked/);
    assert.match(deletion, /if \(!\(await hashHasPhysicalPlacementOnNode\(receipt\.nodeId, receipt\.shardHash\)\)\)/);
    assert.match(nodeService, /Start this node before clearing its shared storage/);
    assert.match(nodeService, /"pending", "stored", "verified"/);
    const distributedDeleteStart = deletion.indexOf("export async function processDistributedDeletionOrders");
    const distributedDeleteEnd = deletion.indexOf("export async function applyDistributedDeletionAcks", distributedDeleteStart);
    const distributedDelete = deletion.slice(distributedDeleteStart, distributedDeleteEnd);
    assert.match(distributedDelete, /acknowledgeShardDeletion/);
    assert.doesNotMatch(distributedDelete, /deleteShard\(/);
    assert.match(recoveryCoordinator, /deleteShardIfUnreferenced/);
    assert.match(recoveryCoordinator, /acknowledgeLifecycleShardDeletion/);
    assert.match(shardRetrieval, /deleteShardIfUnreferenced/);
    assert.doesNotMatch(shardRetrieval, /storage\/fragment-store\.js/);
    assert.match(profileUpgrade, /acknowledgeLifecycleShardDeletion/);
    assert.match(profileUpgrade, /profile_claim_expires_at/);
    const failedCleanupStart = profileUpgrade.indexOf("async function cleanupFailedGeneration");
    const failedCleanupEnd = profileUpgrade.indexOf("export async function upgradeOneCodingProfile", failedCleanupStart);
    const failedCleanup = profileUpgrade.slice(failedCleanupStart, failedCleanupEnd);
    assert.ok(failedCleanupStart >= 0 && failedCleanupEnd > failedCleanupStart, "Failed-generation cleanup must remain an explicit lifecycle phase.");
    assert.match(failedCleanup, /status: "deleting"/);
    assert.doesNotMatch(failedCleanup, /deleteShard\(/);
    assert.doesNotMatch(failedCleanup, /segment_shards"\)\.delete/);
    const stagedAt = profileUpgrade.indexOf("stageUpgradedManifests(identity");
    const committedAt = profileUpgrade.indexOf("commitSegmentProfileUpgrade(identity", stagedAt);
    const publishedAt = profileUpgrade.indexOf("publishCommittedManifests(identity", committedAt);
    const retiredAt = profileUpgrade.indexOf("retireOldGeneration(identity", publishedAt);
    assert.ok(stagedAt >= 0 && committedAt > stagedAt && publishedAt > committedAt && retiredAt > publishedAt, "Profile upgrades must stage manifests, atomically commit segment/version pointers, publish control state, and only then retire old shards.");
    assert.doesNotMatch(profileUpgrade, /finishSegmentProfileUpgrade/);

    console.log("PASS control plane: encrypted signed index, tamper rejection, transactional local persistence, concurrent queue sequencing, idempotent multi-device replay, bounded semantic Anchor cache, Anchor/Supabase receipts, leased reference-complete profile commits, atomic deduplicated deletion, pending-before-transfer placement, serialized shared-hash cleanup, signed repair leases, deletion acknowledgements, and reduced backbone heartbeats.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(`FAIL control plane: ${error.stack || error.message}`);
  process.exitCode = 1;
});
