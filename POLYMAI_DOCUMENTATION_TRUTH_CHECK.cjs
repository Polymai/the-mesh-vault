const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");

const read = (path) => fs.readFileSync(path, "utf8");
const has = (source, text, label) => assert(source.includes(text), label);
const lacks = (source, text, label) => assert(!source.includes(text), label);

const docs = read("js/content/public-documents.js");
const landing = read("js/views/auth-view.js");
const runtime = read("data/runtime-config.js");
const index = read("index.html");
const edge = read("supabase/functions/app717-meshvault-api/index.ts");
const schema = read("supabase/schema.sql");
const policies = read("supabase/policies.sql");
const segmenter = read("js/security/segmenter.js");
const compression = read("js/security/compression.js");
const keyring = read("js/security/keyring.js");
const upload = read("js/flows/upload-flow.js");
const download = read("js/flows/download-flow.js");
const shardRetrieval = read("js/network/shard-retrieval.js");
const manifest = read("js/security/manifest.js");
const identity = read("js/identity/vault-identity.js");
const share = read("js/flows/share-flow.js");
const anchor = read("js/network/anchor-service.js");
const vaultIndex = read("js/control/vault-index.js");
const controlRepository = read("js/control/control-repository.js");
const distributedRepair = read("js/network/distributed-repair.js");
const deletionService = read("js/services/deletion-service.js");
const settings = read("js/views/settings-view.js");
const release = read("RELEASE_TEST_REPORT.md");
const uat = read("UAT_TEST_LOG.md");
const publication = read("DEFENSIVE_PUBLICATION.md");

// Enforced storage and transport limits must match the public reference.
has(runtime, "targetBytes: 8388608", "Runtime no longer enforces the documented 8 MiB segment target.");
has(runtime, "minimumSavings: 0.05", "Runtime no longer enforces the documented 5% compression threshold.");
has(runtime, "packetBytes: 32768", "Runtime no longer uses the documented 32 KiB packet size.");
has(runtime, "maxUploadBytes: 100000000", "Runtime no longer enforces the documented 100 MB file limit.");
has(runtime, "defaultContributionBytes: 1073741824", "Runtime default contribution no longer matches 1 GiB.");
has(runtime, "maxContributionBytes: 268435456000", "Runtime maximum contribution no longer matches 250 GiB.");
has(settings, "maxContributionBytes || 268435456000", "Settings no longer exposes the runtime-backed 250 GiB contribution ceiling.");
has(runtime, "uploadShardConcurrency: 3", "Runtime no longer enforces the documented upload concurrency.");
has(runtime, "downloadShardConcurrency: 4", "Runtime no longer enforces the documented download concurrency.");
for (const profile of [
  'minimumIndependentNodes: 5, dataShards: 3, parityShards: 2, repairThreshold: 4',
  'minimumIndependentNodes: 6, dataShards: 4, parityShards: 2, repairThreshold: 5',
  'minimumIndependentNodes: 8, dataShards: 6, parityShards: 2, repairThreshold: 7',
  'minimumIndependentNodes: 10, dataShards: 7, parityShards: 3, repairThreshold: 9',
  'minimumIndependentNodes: 12, dataShards: 8, parityShards: 4, repairThreshold: 10',
  'minimumIndependentNodes: 16, dataShards: 12, parityShards: 4, repairThreshold: 14',
  'minimumIndependentNodes: 16, dataShards: 10, parityShards: 6, repairThreshold: 13',
]) has(runtime, profile, `Missing documented erasure profile: ${profile}`);

// The implementation evidence behind the Security & Architecture page.
has(segmenter, "file.stream()", "File input no longer uses a stream.");
has(compression, 'new CompressionStream("gzip")', "Adaptive gzip implementation is missing.");
has(keyring, "meshvault-vault-dedup-v1", "Vault-scoped keyed deduplication is missing.");
has(upload, "for await (const input of streamFileSegments", "Upload no longer processes the file by segment.");
has(upload, "role = \"cache\"", "Local fallback/cache accounting changed without a documentation review.");
has(download, "Sha256Stream", "Download no longer performs incremental whole-file hashing.");
has(shardRetrieval, "results.size >= required", "Recovery no longer stops after the manifest-declared K shards.");
has(shardRetrieval, "hedgedRequestDelayMs", "Documented delayed recovery hedge is missing.");
has(manifest, "verifyManifestV2", "Signed manifest verification is missing.");
has(manifest, "readSegmentErasureProfile", "Recovery profile compatibility is no longer centralized.");
has(identity, "restoreVaultFromPhrase", "Phrase-based recovery implementation is missing.");
has(share, "24 * 60 * 60 * 1000", "Current Drive share-link lifetime is no longer 24 hours.");
has(anchor, 'manifest: 30 * 86400000', "Anchor manifest retention no longer matches the publication.");
has(anchor, '"vault-index": 30 * 86400000', "Anchor vault-index retention no longer matches the publication.");
has(vaultIndex, "buildVaultIndexEnvelope", "The documented signed encrypted vault index is missing.");
has(vaultIndex, "not_self_certifying", "The documented self-certifying index check is missing.");
has(controlRepository, 'queryAnchors("vault-index"', "The documented local/Anchor/Supabase index path is missing.");
has(controlRepository, 'markSyncReceipt(operation.opId, "anchor"', "The documented Anchor operation receipt is missing.");
has(controlRepository, 'markSyncReceipt(operation.opId, "supabase"', "The documented Supabase operation receipt is missing.");
has(distributedRepair, '"repair-lease"', "The documented distributed repair lease is missing.");
has(deletionService, '"deletion-ack"', "The documented distributed deletion acknowledgement is missing.");

// The public text must preserve the important qualifications.
has(docs, "Up to 100 MB now", "Security page does not state the current file-size boundary.");
has(docs, "0 to 250 GiB", "Security page no longer states the selectable 250 GiB browser contribution ceiling.");
lacks(docs, "Any total size", "Security page still claims an unenforced unlimited file size.");
has(docs, "Enough valid pieces rebuild the exact file.", "Simple explanation overstates what the Mesh Key alone can recover.");
has(docs, "it does not count as another independent device", "Local fallback copies are not distinguished from independent protection.");
has(docs, "there is no cross-vault deduplication", "Security page does not disclose the vault-scoped deduplication boundary.");
has(docs, "vault-scoped keyed deduplication fingerprints", "Privacy page omits a coordination field stored by the current schema.");
has(docs, "Restoring the identity does not by itself guarantee file recovery", "Identity restore is conflated with file recovery.");
has(docs, "not legal or network anonymity", "Privacy page overstates anonymous access.");
has(docs, "IP address, user-agent and request timing may also occur", "Supabase infrastructure-log disclosure is missing.");
has(docs, "current Row Level Security policies", "Supabase row visibility is not disclosed.");
has(docs, "Random IDs and public keys do not contain a civil identity", "Stable identifiers are not distinguished from direct identity.");
has(docs, "an IP log, personal node label, optional account or information held elsewhere may create the missing link", "Documentation overstates unlinkability.");
has(docs, "The current app does not use Supabase Storage for file or shard content.", "Supabase file and shard content boundary is missing.");
has(docs, "Not yet a complete cold-start replacement.", "Anchor documentation overstates Supabase independence.");
has(docs, "owner-signed encrypted vault-index snapshot", "Security and Privacy omit the current vault-index fallback data.");
has(docs, "File bytes, segment placement and initial upload records still require the current Supabase-backed storage workflow.", "Security overstates offline upload independence.");
has(docs, "ten-minute cadence", "Security does not disclose the reduced Anchor-primary Supabase heartbeat.");
has(docs, "current Drive interface does not expose those controls", "Sharing documentation exposes unsupported UI choices.");
has(docs, "Mobile browsers may suspend or terminate background tabs", "Mobile background limits are missing.");
has(docs, "Node reminders are optional", "Security still describes push reminders as an Anchor prerequisite.");
has(docs, "The current build does not send these reminders automatically", "Security overstates automatic reminder delivery.");
lacks(docs, "Node reminders must be enabled before this browser can advertise itself as an Anchor.", "Security still requires reminders for Anchor eligibility.");
has(landing, "Mesh Key controls access", "Landing page overstates what a Mesh Key alone can recover.");
has(landing, "Enough pieces put the file back together.", "Landing page omits the shard-availability recovery condition.");
lacks(landing, "Your Mesh Key puts the file back together.", "Landing page still claims the Mesh Key alone rebuilds a file.");

// Hosted infrastructure and external-network disclosures must match source.
has(index, "fonts.googleapis.com", "Google Fonts is no longer present; update the provider disclosure.");
has(index, "cdn.jsdelivr.net/npm/@supabase/supabase-js@2", "jsDelivr Supabase dependency is no longer present; update the provider disclosure.");
has(edge, "stun:stun.l.google.com:19302", "Google STUN disclosure no longer matches the Edge Function.");
has(edge, "stun:stun.cloudflare.com:3478", "Cloudflare STUN disclosure no longer matches the Edge Function.");
has(schema, "encrypted_manifest_cache", "Documented encrypted manifest cache is missing from the schema.");
has(schema, "recovery_envelope_cache", "Documented recovery envelope cache is missing from the schema.");
has(policies, "enable row level security", "Documented RLS boundary is missing.");
lacks(schema, "storage.objects", "The app schema unexpectedly references Supabase Storage.");

// Test reports are evidence, not a public-launch guarantee.
has(release, "CONDITIONAL GO for a small, invite-only pilot", "Release report no longer carries its conditional pilot decision.");
has(release, "NO-GO for an unrestricted public launch", "Release report no longer states the unrestricted-launch block.");
has(release, "This is warm-mesh survival, not cold-start independence.", "Outage evidence is overstated.");
has(uat, "No physical Android or iPhone was represented.", "UAT report hides the physical-phone coverage gap.");
has(uat, "Production anonymous-auth burst test", "Anonymous-auth capacity gate is missing.");

for (const path of [
  ".polymai/release-results.json",
  ".polymai/release-boundary-results.json",
  ".polymai/golden-recovery-results.json",
  ".polymai/release-ten-node-results.json",
  ".polymai/release-repair-results.json",
  ".polymai/offline-delete-reconnect-results.json",
  ".polymai/cross-browser-mobile-results.json",
  "test-artifacts/scale-chaos/results.json",
]) assert(fs.existsSync(path), `Referenced test evidence is missing: ${path}`);

const recordedDigest = read("DEFENSIVE_PUBLICATION.sha256").trim().split(/\s+/)[0].toLowerCase();
const actualDigest = crypto.createHash("sha256").update(Buffer.from(publication, "utf8")).digest("hex");
assert.equal(actualDigest, recordedDigest, "DEFENSIVE_PUBLICATION.md no longer matches its pinned SHA-256.");

console.log("PASS: public, legal, defensive-publication and release claims remain aligned with runtime, schema, dependencies and retained test evidence.");
