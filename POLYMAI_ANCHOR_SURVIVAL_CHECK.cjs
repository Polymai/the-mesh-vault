const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { pathToFileURL } = require("url");

async function main() {
  const root = __dirname;
  const availability = await import(pathToFileURL(path.join(root, "js/network/availability-score.js")).href);
  const cold = availability.computeAvailabilityScore({ leaseRemainingMs: 0, leaseDurationMs: 90000 });
  const steady = availability.computeAvailabilityScore({
    uptimeSeconds: 86400, leaseRemainingMs: 90000, leaseDurationMs: 90000,
    wakeLockActive: true, persistentStorage: true, visible: true,
    successfulTransfers: 20, failedTransfers: 0, successfulProofs: 20, failedProofs: 0,
  });
  assert(steady > cold, "A proven awake node must outrank an expired cold node.");
  assert.equal(availability.availabilityLabel(steady, true), "excellent");
  assert.equal(availability.availabilityLabel(steady, false), "lease expired");
  const reminded = availability.computeAvailabilityScore({
    uptimeSeconds: 3600, leaseRemainingMs: 45000, leaseDurationMs: 90000,
    wakeLockActive: false, persistentStorage: true, visible: true,
    wakeAssistanceReady: true,
  });
  const notReminded = availability.computeAvailabilityScore({
    uptimeSeconds: 3600, leaseRemainingMs: 45000, leaseDurationMs: 90000,
    wakeLockActive: false, persistentStorage: true, visible: true,
    wakeAssistanceReady: false,
  });
  assert(reminded > notReminded, "Optional wake assistance should improve measured availability without gating the lease.");

  const runtime = fs.readFileSync(path.join(root, "data/runtime-config.js"), "utf8");
  const schema = fs.readFileSync(path.join(root, "supabase/schema.sql"), "utf8");
  const policies = fs.readFileSync(path.join(root, "supabase/policies.sql"), "utf8");
  const worker = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  const survival = fs.readFileSync(path.join(root, "js/network/survival-service.js"), "utf8");
  assert(runtime.includes("leaseMs: 90000") && runtime.includes("buddyCount: 2"));
  for (const column of ["survival_mode", "lease_expires_at", "uptime_seconds", "buddy_node_ids"]) assert(schema.includes(column), `Missing ${column}`);
  assert(schema.includes("node_push_subscriptions"));
  assert(schema.includes("recipient.lease_expires_at>now()"), "Signaling must reject an expired Night Node lease.");
  assert(worker.includes('addEventListener("push"') && worker.includes('addEventListener("periodicsync"'));
  assert(survival.includes('publishControlObject("anchor-handoff"'));
  console.log("PASS: renewable leases, availability score, buddy handoff, push worker, and lease-aware signaling contracts.");
}
main().catch((error) => { console.error(error); process.exit(1); });
