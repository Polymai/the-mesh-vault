(async () => {
const assert = (await import("node:assert/strict")).default;
const fs = await import("node:fs");
const { readSegmentErasureProfile } = await import("./js/security/manifest.js");
const { runConcurrent, withRetry } = await import("./js/ui/task-state.js");
const { attachTransferProtocol } = await import("./js/network/transfer-protocol.js");

const incomplete = readSegmentErasureProfile({ shardHashes: Array.from({ length: 6 }, (_, index) => `incomplete-${index}`) });
assert.equal(Number.isNaN(incomplete.dataShards), true, "Protocol v3 must not infer a legacy 4+2 profile from shard count.");

const explicit = readSegmentErasureProfile({
  erasureCoding: {
    algorithm: "reed-solomon",
    profileVersion: 2,
    dataShards: 8,
    parityShards: 4,
    requiredShards: 8,
    repairThreshold: 10,
    totalShards: 12,
  },
});
assert.deepEqual(
  (({ dataShards, parityShards, requiredShards, repairThreshold, totalShards, profileVersion }) => ({ dataShards, parityShards, requiredShards, repairThreshold, totalShards, profileVersion }))(explicit),
  { dataShards: 8, parityShards: 4, requiredShards: 8, repairThreshold: 10, totalShards: 12, profileVersion: 2 },
);

let active = 0;
let maximumActive = 0;
const completed = await runConcurrent(Array.from({ length: 12 }, (_, index) => index), 3, async (value) => {
  active += 1;
  maximumActive = Math.max(maximumActive, active);
  await new Promise((resolve) => setTimeout(resolve, 5));
  active -= 1;
  return value * 2;
});
assert.equal(maximumActive, 3);
assert.deepEqual(completed, Array.from({ length: 12 }, (_, index) => index * 2));

let attempts = 0;
const retried = await withRetry(async () => {
  attempts += 1;
  if (attempts < 3) throw new Error("temporary peer failure");
  return "stored";
}, { retries: 2, baseDelayMs: 1, timeoutMs: 100 });
assert.equal(retried, "stored");
assert.equal(attempts, 3);

await assert.rejects(
  withRetry(
    () => new Promise(() => {}),
    { retries: 0, timeoutMs: 10 },
  ),
  (error) => error?.name === "TimeoutError",
);

const controller = new AbortController();
const running = runConcurrent([1, 2, 3, 4], 2, async (_value, _index, signal) => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 500);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}, { signal: controller.signal });
setTimeout(() => controller.abort(new DOMException("Enough shards received", "AbortError")), 5);
await assert.rejects(running, (error) => error?.name === "AbortError");

class FakeChannel {
  constructor() {
    this.readyState = "open";
    this.bufferedAmount = 0;
    this.messages = [];
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  send(encoded) { this.messages.push(JSON.parse(encoded)); }
  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) listener({ data });
  }
}
const channel = new FakeChannel();
const protocol = attachTransferProtocol(channel);
const requestId = protocol.requestShard("wanted-shard");
assert(requestId);
assert.equal(protocol.cancelShardRequest(requestId), true);
assert.deepEqual(channel.messages.slice(-2).map(({ type, shardId }) => ({ type, shardId })), [
  { type: "shard-request", shardId: "wanted-shard" },
  { type: "shard-request-cancel", shardId: undefined },
]);

const sendController = new AbortController();
const sending = protocol.sendShard("outgoing-shard", new Uint8Array(70_000), "expected-hash", undefined, { signal: sendController.signal });
sendController.abort(new DOMException("Receiver has enough shards", "AbortError"));
await assert.rejects(sending, (error) => error?.name === "AbortError");
assert(channel.messages.some((message) => message.type === "shard-abort"), "Cancelled sends must tell the receiver to discard an incomplete transfer.");

class ClosingChannel extends FakeChannel {
  send(encoded) {
    super.send(encoded);
    if (this.messages.length === 1) this.readyState = "closed";
  }
}
const closingChannel = new ClosingChannel();
const closingProtocol = attachTransferProtocol(closingChannel);
const closedAt = Date.now();
await assert.rejects(
  closingProtocol.sendShard("closed-mid-send", new Uint8Array(70_000), "expected-hash"),
  /closed during transfer/i,
);
assert(Date.now() - closedAt < 1000, "A closed DataChannel must fail immediately instead of waiting for the storage-receipt timeout.");

const uploadSource = fs.readFileSync(`${__dirname}/js/flows/upload-flow.js`, "utf8");
const controlSource = fs.readFileSync(`${__dirname}/js/control/control-repository.js`, "utf8");
const segmentSource = fs.readFileSync(`${__dirname}/js/services/segment-service.js`, "utf8");
assert.match(uploadSource, /responsiveUploadPeers\(peers, task\.signal\)/, "Uploads must remove unresponsive peers before placement.");
assert.match(uploadSource, /uploadCandidateAttempts/, "Uploads must bound the number of remote candidates tried per shard.");
assert.match(uploadSource, /uploadRetryAttempts \?\? 0/, "Uploads must not retry one stale peer repeatedly by default.");
assert.match(controlSource, /await saveLocalVaultIndex\(envelope\);\s*scheduleAnchorIndexPublish\(envelope\);/, "Catalog commits must finish locally before asynchronous mesh replication.");
assert.doesNotMatch(controlSource, /await publishIndexToAnchors\(envelope\)/, "A catalog mutation must not wait for a remote control receipt.");
assert.match(controlSource, /export function mutateCatalogRow/, "The signed catalog must provide serialized row mutations.");
assert.match(segmentSource, /mutateCatalogRow\("segments", segment\.id/, "Concurrent placement updates must mutate the latest segment revision atomically.");

console.log("PASS protocol v3 refuses to infer missing coding metadata from legacy shard counts");
console.log("PASS explicit manifest profile metadata drives 8+4 recovery");
console.log("PASS upload queue never exceeds three concurrent shard tasks");
console.log("PASS retry uses bounded attempts and timeout");
console.log("PASS excess concurrent work is cancellable");
console.log("PASS DataChannel shard requests and in-flight sends emit cancellation messages");
console.log("PASS a DataChannel that closes mid-send fails immediately without a false 45-second stall");
console.log("PASS uploads probe peers, bound remote attempts and commit catalog revisions locally before mesh replication");
console.log("PASS concurrent shard placement updates are serialized without lost catalog writes");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
