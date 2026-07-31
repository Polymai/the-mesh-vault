# TheMeshVault Documentation Verification

Date: 26 July 2026  
Scope: public Security & Architecture, Terms, Privacy, metadata, defensive publication, release/UAT reports and their retained evidence.

## 31 July 2026 control-plane verification addendum

The public Security and Privacy documents now match the implemented five-phase control plane. They disclose the encrypted signed vault index, signed operation envelopes, Anchor-held repair/deletion records, the reduced hosted heartbeat cadence, and the exact functions that still depend on Supabase. They do not describe the Anchor path as a complete cold-start or storage-plane replacement.

Verified source boundaries:

- Local browsers retain plaintext names only after decrypting with the Mesh Key; Supabase and unrelated Anchors receive encrypted catalog envelopes and signed technical operations.
- Anchors may cache encrypted indexes, signed operations, recovery envelopes, repair requests/leases/completions, deletion orders/acknowledgements and bounded peer records.
- Supabase still supplies anonymous session bootstrap, first-contact discovery/signaling fallback, initial file/segment/placement persistence and the atomic repair job queue.
- Stable Anchor-primary clients reduce ordinary hosted node heartbeats to ten minutes; Anchors and fallback modes report more frequently.
- No actual readable file, plaintext filename, Mesh Key or complete encrypted file is introduced into Supabase by these phases.

## Result

**PASS for documentation consistency after the corrections listed below.**

The current documentation now distinguishes implemented behavior, conditional recovery, tested behavior and unverified production behavior. It does not claim that TheMeshVault is fully anonymous, fully independent of Supabase, a guaranteed backup service, continuously available in a sleeping mobile browser, or ready for an unrestricted public launch.

## Claims verified against the implementation

| Claim | Implementation evidence | Result |
|---|---|---|
| Files are read as bounded 8 MiB segments | `js/security/segmenter.js`, `data/runtime-config.js` | Verified |
| gzip is kept only at 5% or greater saving and compressed formats are skipped | `js/security/compression.js` | Verified |
| Reuse uses a keyed HMAC fingerprint scoped to one vault, not cross-vault deduplication | `js/security/keyring.js`, segment service and schema | Verified |
| Each segment is encrypted with authenticated encryption and independently erasure-coded | `js/security/keyring.js`, `js/security/erasure.js`, `js/flows/upload-flow.js` | Verified |
| Automatic protection selects 3+2, 4+2, 6+2, 7+3, 8+4 and 10+6 as independent nodes become available; Balanced can use 12+4 at sixteen nodes | `data/runtime-config.js`, `js/network/shard-lifecycle.js`, `js/services/segment-service.js` | Verified |
| Only verified durable placements on independent failure domains count toward resilience | `js/network/placement-engine.js`, `js/services/segment-service.js`, `js/flows/upload-flow.js` | Verified |
| Recovery reads each segment's stored profile, verifies shard, cipher, segment and whole-file integrity, limits concurrent retrieval, and cancels excess requests after K valid shards | `js/network/shard-retrieval.js`, `js/flows/download-flow.js`, `js/flows/share-download-flow.js`, `js/security/manifest.js` | Verified |
| Current file limit is exactly 100,000,000 bytes | `data/runtime-config.js`, `js/flows/upload-flow.js` | Verified |
| Current Drive share links last 24 hours | `js/flows/share-flow.js`, `js/bootstrap.js` | Verified |
| Supabase provides anonymous Auth, RLS, metadata, discovery, signaling and coordination, not a readable whole-file bucket | `js/services/supabase.js`, schema, policies, Realtime and Edge Function | Verified |
| Phrase-only cold recovery normally looks up an encrypted envelope through Supabase; complete v2 Mesh Key files carry the phrase and envelope | `js/identity/vault-identity.js`, `js/bootstrap.js` | Verified |
| A complete v2 Mesh Key file opens its self-verifying local identity before hosted coordination completes; phrase-only cold recovery still needs a reachable Anchor or Supabase envelope lookup | vault identity, local-first bootstrap and Mesh Key portability check | Verified locally; fresh hosted lookup rate-limited during this run |
| Clients deterministically select three primary and two reserve Anchors, prefer the Anchor path only after a stability window, and immediately restore Supabase fallback below the safe threshold | `js/network/coordination-policy.js`, `js/network/node-service.js`, provider registry and runtime config | Verified in source and scale simulation; provisioning pending |
| Anchors replicate bounded signed/encrypted catalog and operation data plus recovery, repair and deletion control records; Supabase still backs general cold start, initial file/segment/placement persistence and atomic repair mutation | control repository, Anchor provider, recovery coordinator and schema | Verified |
| Anchor eligibility follows its renewable lease; optional push reminders can help the user return but do not run background WebRTC | survival service, service worker and app API router | Verified |
| Deletion can remain pending on an unreachable node | deletion flow, signed authorizations and deletion service | Verified |
| A mobile browser may still be suspended despite PWA, Wake Lock, sync or push assistance | survival service and browser-platform limits | Correctly disclosed |

## Corrections made

- Replaced the unlimited-file wording with the enforced 100 MB release boundary.
- Replaced “the Mesh Key rebuilds the exact file” with the accurate condition: the key opens the vault and every segment still needs enough valid reachable shards.
- Applied the same Mesh Key/reachable-shard distinction to the public landing page.
- Clarified that a local fallback/cache copy is not a second independent device and does not increase claimed resilience.
- Added the implemented vault-scoped deduplication flow and disclosed its keyed fingerprint in the Supabase data inventory.
- Qualified uploader-offline recovery by the availability of enough other verified shards.
- Clarified that the sharing protocol supports password/download restrictions while the current Drive interface does not expose them.
- Tightened the social metadata so byte-exact verification is conditional on enough reachable shards.
- Updated the public document dates and draft versions.

## Test evidence reviewed

- 26/26 release regression
- Five isolated browser-profile WebRTC mesh
- Exact 100,000,000-byte recovery
- Uploader-offline 24 MiB recovery at 4/5 and 3/5, with correct rejection at 2/5
- Ten-node 7+3 placement
- Repair/rebalance and offline deletion/reconnect
- Warm-mesh recovery during a simulated Supabase outage
- Chromium, Firefox and WebKit mobile-host layouts
- 1,000-logical-node chaos model with real cryptography/coding and modeled transport

The evidence files referenced by the reports are present. The pinned SHA-256 for `DEFENSIVE_PUBLICATION.md` also matches.

## Still unverified or open

These are release gates, not hidden implementation claims:

- physical Android Chrome and iPhone Safari under memory pressure, screen lock and browser eviction;
- TURN-only transfer between restrictive NATs or separate mobile carriers;
- production anonymous-auth burst capacity and rate limits;
- unrestricted abuse resistance and bounded coordination quotas;
- long-duration churn across real devices, networks and regions.

The current release decision therefore remains: **conditional GO for a small invite-only pilot after the physical-phone gate passes; NO-GO for an unrestricted public launch.**

## Repeatable check

Run:

```bash
node POLYMAI_DOCUMENTATION_TRUTH_CHECK.cjs
node POLYMAI_PUBLIC_PAGES_CHECK.cjs
node POLYMAI_CHECKS.cjs
```

The first check ties key public claims to the current runtime constants, source files, Supabase artifacts, external dependencies, release limitations and retained test evidence.
