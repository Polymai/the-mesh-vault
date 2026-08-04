const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");

const read = (path) => fs.readFileSync(path, "utf8");
const has = (source, text, label) => assert(source.includes(text), label);
const lacks = (source, text, label) => assert(!source.includes(text), label);
const matches = (source, pattern, label) => assert(pattern.test(source), label);
const lacksMatch = (source, pattern, label) => assert(!pattern.test(source), label);

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
const mnemonic = read("js/identity/mnemonic.js");
const signing = read("js/security/signing.js");
const capability = read("js/security/capability.js");
const segmentDescriptor = read("js/security/segment-descriptor.js");
const nodeService = read("js/network/node-service.js");
const peerRegistry = read("js/network/peer-registry.js");
const dataSchema = JSON.parse(read("data/schema.json"));
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
has(runtime, "protocolVersion: 3", "Runtime no longer requires client protocol v3.");
has(runtime, "minimumProtocolVersion: 3", "Runtime no longer rejects pre-v3 clients.");
has(runtime, "storageFormatVersion: 3", "Runtime no longer requires storage format v3.");
has(mnemonic, "const ENTROPY_BYTES = 32", "The Mesh Key no longer represents a 256-bit root seed.");
has(mnemonic, "const WORD_COUNT = 24", "The Mesh Key no longer uses 24 words.");
has(mnemonic, "const CHECKSUM_BITS = 8", "The 24-word Mesh Key checksum contract is missing.");
has(mnemonic, "crypto.getRandomValues(new Uint8Array(ENTROPY_BYTES))", "Mesh Key generation no longer uses the browser CSPRNG for all 256 bits.");
lacks(mnemonic, "Math.random", "Mesh Key generation fell back to a non-cryptographic PRNG.");
has(mnemonic, "The Mesh Key checksum is not valid", "Mesh Key restore no longer rejects an invalid checksum.");
has(signing, 'deriveRootBytes(rootSeed, domain', "The v3 domain-separated root hierarchy is missing.");
has(signing, 'export const ALG_ED25519 = "Ed25519"', "Protocol v3 no longer pins Ed25519.");
has(identity, 'deriveRootBytes(rootSeed, "owner-ed25519-seed")', "Vault signing identity is no longer deterministic from the root seed.");
has(identity, 'const MESH_KEY_VERSION = 3', "Mesh Key export no longer pins version 3.");
has(identity, 'format: MESH_KEY_FORMAT', "The v3 portable Mesh Key file is missing.");
lacks(identity, "recoveryEnvelope", "Vault identity reintroduced a recovery-envelope dependency.");
lacks(identity, "recoveryLookupId", "Vault identity reintroduced a hosted recovery lookup.");
lacks(identity, "ALG_ECDSA", "Vault identity reintroduced an ECDSA compatibility branch.");
has(keyring, "themeshvault/v3/dedup-token", "Vault-scoped keyed v3 deduplication is missing.");
has(keyring, "deriveSegmentKey", "Deterministic v3 segment-key derivation is missing.");
has(keyring, "themeshvault/v3/segment-aes-256-gcm", "Segment keys no longer use their v3 domain separator.");
lacks(keyring, "wrappedSegmentKey", "The keyring reintroduced wrapped segment keys.");
lacks(keyring, "unwrapSegmentKey", "The keyring reintroduced wrapped segment-key recovery.");
has(keyring, "crypto.getRandomValues(new Uint8Array(12))", "AES-GCM envelopes no longer use fresh 96-bit browser-generated nonces.");
has(upload, "for await (const input of streamFileSegments", "Upload no longer processes the file by segment.");
has(upload, "role = \"cache\"", "Local fallback/cache accounting changed without a documentation review.");
has(download, "Sha256Stream", "Download no longer performs incremental whole-file hashing.");
has(shardRetrieval, "results.size >= required", "Recovery no longer stops after the manifest-declared K shards.");
has(shardRetrieval, "hedgedRequestDelayMs", "Documented delayed recovery hedge is missing.");
has(manifest, "verifyManifestV3", "Signed protocol-v3 manifest verification is missing.");
has(manifest, "SUPPORTED_STORAGE_PROTOCOL_VERSIONS = Object.freeze([3])", "Manifest verification no longer rejects pre-v3 storage protocols.");
has(segmentDescriptor, "core.storageFormatVersion === 3", "Signed segment descriptors no longer enforce storage format v3.");
has(capability, "CAPABILITY_PROTOCOL_VERSION = 3", "Share capabilities no longer enforce protocol v3.");
has(peerRegistry, "protocolVersion !== PEER_PROTOCOL_VERSION", "Peer admission no longer rejects non-v3 clients.");
has(nodeService, "Number(entry.protocolVersion || 0) < 3", "Node discovery no longer filters pre-v3 peers.");
has(edge, 'Number(body.clientProtocolVersion) !== 3', "The Edge API no longer returns an upgrade gate to pre-v3 clients.");
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
has(docs, "crypto.getRandomValues()", "Security page does not identify the browser CSPRNG used for random key material.");
has(docs, "does not use <code>Math.random()</code>", "Security page does not distinguish the CSPRNG from Math.random().");
has(docs, "depends on the browser and operating system implementing their CSPRNG correctly", "Security page overstates randomness without its browser/OS trust boundary.");
lacksMatch(docs, /(?:unhackable|guaranteed random|impossible to predict)/i, "Security page makes an absolute randomness claim.");
matches(docs, /(?:24[- ]word[\s\S]{0,160}256[- ]bit|256[- ]bit[\s\S]{0,160}24[- ]word)/i, "Security page does not state the checksum-backed 24-word/256-bit Mesh Key contract.");
has(docs, "Ed25519", "Security page does not state the protocol-v3 signing algorithm.");
matches(docs, /(?:deterministic(?:ally)?[\s\S]{0,180}(?:root|Mesh Key)|(?:root|Mesh Key)[\s\S]{0,180}deterministic(?:ally)?)/i, "Security page does not explain deterministic identity/key derivation from the Mesh Key root.");
matches(docs, /(?:segment key[\s\S]{0,160}deriv|deriv[\s\S]{0,160}segment key)/i, "Security page still presents segment keys as independently generated or wrapped instead of derived.");
matches(docs, /fresh (?:random )?96-bit (?:nonce|IV)/i, "Security page no longer states the implemented per-segment AES-GCM nonce construction.");
matches(docs, /(?:Mesh Key(?: phrase)?[\s\S]{0,180}(?:not|never) (?:sent|uploaded)|(?:not|never) (?:sent|uploaded)[\s\S]{0,180}Mesh Key)/i, "Security page does not plainly state that the Mesh Key is never uploaded.");
matches(docs, /(?:Mesh Key root|root seed|256-bit root)[\s\S]{0,260}IndexedDB|IndexedDB[\s\S]{0,260}(?:Mesh Key root|root seed|256-bit root)/i, "Security page hides the local browser-profile root-seed storage boundary.");
has(capability, "keysBlob", "Share capabilities no longer wrap their one-file key grant for the recipient.");
has(capability, "fragmentSecret", "Share capabilities no longer keep the opening secret in the URL fragment path.");
has(docs, "An explicit share is the exception described below", "Security documentation makes an absolute local-key claim without disclosing the explicit share exception.");
matches(docs, /encrypted (?:one-file|file-version-limited) key grant[\s\S]{0,180}(?:URL )?fragment/i, "Security/Privacy no longer explain that the hosted share grant is unusable without its URL-fragment secret.");
matches(docs, /Storage protocol v3/i, "Security page does not identify the breaking storage protocol version.");
lacksMatch(docs, /recovery envelope/i, "Public documentation still describes the removed hosted recovery-envelope design.");
lacksMatch(docs, /ECDSA P-256/i, "Public documentation still promises a removed ECDSA compatibility branch.");
lacksMatch(docs, /(?:192-bit Mesh Key|192 bits of generated entropy|six Mesh Key groups)/i, "Public documentation still describes the removed 192-bit Mesh Key.");
lacksMatch(docs, /(?:fresh random 256-bit segment key|segment key is wrapped|wrapped segment key|key wrapper)/i, "Public documentation still describes removed random/wrapped segment keys.");
lacksMatch(docs, /legacy version-1/i, "Public documentation still promises a removed legacy Mesh Key restore path.");
lacksMatch(docs, /(?:Storage protocol v[12]|protocol-version-[12] compatibility)/i, "Public documentation still promises pre-v3 protocol compatibility.");
matches(docs, /vault-(?:scoped|keyed)[\s\S]{0,80}deduplication (?:fingerprints|tokens)/i, "Privacy page omits a coordination field stored by the current schema.");
has(docs, "Restoring the identity does not by itself guarantee file recovery", "Identity restore is conflated with file recovery.");
has(docs, "not legal or network anonymity", "Privacy page overstates anonymous access.");
has(docs, "IP address, user-agent and request timing may also occur", "Supabase infrastructure-log disclosure is missing.");
has(docs, "current Row Level Security policies", "Supabase row visibility is not disclosed.");
has(docs, "Random IDs and public keys do not contain a civil identity", "Stable identifiers are not distinguished from direct identity.");
has(docs, "an IP log, personal node label, optional account or information held elsewhere may create the missing link", "Documentation overstates unlinkability.");
matches(docs, /the current app does not use Supabase Storage for file or shard content\./i, "Supabase file and shard content boundary is missing.");
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
has(schema, "key_derivation_version int not null default 3", "The database no longer records v3 segment-key derivation.");
has(schema, "encryption_generation int not null default 1", "The database no longer records segment encryption generations.");
lacks(schema, "wrapped_segment_key", "The database still accepts wrapped segment keys.");
lacks(schema, "create table if not exists app717_meshvault.recovery_envelope_cache", "The removed recovery-envelope table is still deployable.");
lacks(policies, "recovery_envelope_cache", "RLS policies still expose the removed recovery-envelope table.");
has(policies, "enable row level security", "Documented RLS boundary is missing.");
lacks(schema, "storage.objects", "The app schema unexpectedly references Supabase Storage.");
assert.equal(dataSchema.storageFormatVersion, 3, "data/schema.json no longer pins storage format v3.");
assert.equal(dataSchema.manifestFormatVersion, 3, "data/schema.json no longer pins manifest format v3.");
const contentSegments = dataSchema.tables.find((table) => table.name === "app717_meshvault.content_segments");
assert(contentSegments, "data/schema.json is missing content_segments.");
const segmentColumns = new Map(contentSegments.columns.map((column) => [column.name, column]));
assert.equal(segmentColumns.get("format_version")?.default, "3", "data/schema.json no longer pins segment format v3.");
assert.equal(segmentColumns.get("key_derivation_version")?.default, "3", "data/schema.json no longer pins key derivation v3.");
assert.equal(segmentColumns.get("encryption_generation")?.default, "1", "data/schema.json is missing the encryption generation.");
assert.equal(segmentColumns.has("wrapped_segment_key"), false, "data/schema.json still contains wrapped segment keys.");
assert.equal(dataSchema.tables.some((table) => table.name.endsWith(".recovery_envelope_cache")), false, "data/schema.json still contains the recovery-envelope cache.");

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

console.log("PASS: public, legal, defensive-publication and release claims remain aligned with the breaking v3 identity, key-derivation, storage, schema and client-gate contracts.");
