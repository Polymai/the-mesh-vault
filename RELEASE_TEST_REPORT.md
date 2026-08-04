# TheMeshVault protocol-v3 release test report

Date: 2026-08-05  
Candidate: local-root-key protocol v3, manifest/storage format v3  
Decision: **NO-GO until provisioning and the v3 live recovery gates pass**

## Candidate summary

This candidate is a deliberate pre-release reset, not an in-place compatibility release. There are no production users to migrate. On first provisioning, `supabase/schema.sql` removes the app-owned v1/v2 data tables once under the `local-root-key-v3` migration marker and recreates the app contract at protocol v3. Supabase Auth and schemas outside `app717_meshvault` are not reset.

The current source implements:

- a 256-bit browser-generated root encoded as a checksum-validated 24-word Mesh Key;
- deterministic Ed25519 ownership and a self-certifying Vault ID;
- domain-separated local derivation of metadata, deduplication and segment-key roots;
- no hosted recovery envelope or storage descriptor/manifest with wrapped per-segment decryption keys; an explicit share may publish a recipient-encrypted, file-version-limited key grant whose opening secret remains in the URL fragment;
- signed v3 segment descriptors and signed v3 manifests;
- fixed 8 MiB segments, adaptive compression, AES-256-GCM and per-segment Reed-Solomon coding;
- direct WebRTC shard transfer with Supabase bootstrap/signaling/cache fallback and bounded Anchor control caching;
- explicit capability links that export limited segment grants without exporting the Mesh Key root.
- lease-bound profile upgrades that stage a complete generation, atomically switch every referencing manifest pointer, and retain retryable lifecycle-deletion records for interrupted or ambiguous shard writes;
- locked file deletion that atomically detaches deduplicated references, revokes capabilities and tombstones the file while preserving shared segments; and
- pending-before-transfer placement records plus serialized, fail-closed hash cleanup for initial upload, repair, download and lifecycle deletion paths.

These are implementation/source findings. They are not evidence that the revised backend has been deployed or that the end-to-end v3 journey has passed in production.

## Protocol-v3 local verification completed

The following checks passed on 2026-08-05 against the local source candidate. They verify source contracts, browser-local cryptography/storage behavior and deterministic simulations; they do not certify a provisioned Supabase project or a live multi-browser WebRTC mesh.

| Evidence | Local result |
|---|---:|
| ES-module import/export graph | PASS, 96 modules |
| JavaScript syntax | PASS, 105 modules plus `sw.js` |
| Mesh Key portability | PASS, deterministic phrase/file restore and Vault ID |
| Browser-unit cryptography/storage suite | PASS |
| Documentation truth | PASS |
| Supabase source/schema/RLS contract | PASS; protocol-v3 schema plan 11 |
| Local/Anchor/Supabase control-plane contract | PASS; source enforces tokenized leases, exact reference sets, complete staged generations, atomic deduplicated deletion and serialized fail-closed lifecycle cleanup through C32 |
| Coordination scale simulation | PASS, 10,000 nodes and 200 Anchors; maximum Anchor load 181; approximately 18.6 modeled Supabase writes/second |
| Shard lifecycle profiles, thresholds, repair and rejoin | PASS |
| Adaptive upload/download transfer contracts | PASS |
| 1,000-node chaos simulation | PASS; original SHA-256 retained; 12+4 recovered after four losses and rejected after five; 33 repairs and 33 retirements |
| Anchor survival and optional reminder contracts | PASS |
| Browser-private hosted-shard storage UX | PASS |
| Download progress, cancellation and exact-verification UI | PASS |
| Polymai app contract | PASS |
| Night Node lifecycle/UI contract | PASS |
| Public pages and legal/security disclosure contract | PASS |
| PWA installability | PASS in local Chromium, Google Chrome and Microsoft Edge checks |

The 10,000-node coordination run and 1,000-node shard-chaos run are deterministic simulations. They do not send their simulated nodes to Supabase, open thousands of browser processes, exercise live signaling/TURN, or prove real multi-browser WebRTC transfer.

Two backend-dependent integration checks were also attempted against the currently deployed, pre-v3 backend. The PWA share-target check timed out while waiting for the imported file to complete its production upload, and the Live Mesh renderer check could not establish a real connected peer pair. Both are recorded as expected release failures until the protocol-v3 schema and Edge artifacts are provisioned; neither result was weakened or relabelled as a pass.

## Historical evidence boundary

The July v0.1 browser, recovery, repair, sharing, deletion, scale and mobile-layout runs remain useful engineering history. They tested the former protocol and included recovery-envelope/wrapped-key paths that protocol v3 has removed. They must not be quoted as a PASS for this candidate.

That superseded report's decision was **CONDITIONAL GO for a small, invite-only pilot** and **NO-GO for an unrestricted public launch**. Protocol v3 resets the evidence boundary, so even that conditional pilot decision is paused until the v3 gates below pass.

In particular, the former 24 MiB uploader-offline result, five-browser 3+2 threshold result and live Supabase outage result need fresh v3 execution. Their historical byte/hash observations are retained in earlier test artifacts, but the current release decision does not rely on them.

The former outage result proved an already-established mesh only. **This is warm-mesh survival, not cold-start independence.** It also does not certify the new v3 control path.

## Current release gates

| Gate | Current status |
|---|---:|
| V3 schema/RLS/Realtime/Edge artifacts aligned in source | PASS in local contract checks |
| V3 app-schema reset provisioned successfully | Pending; current backend-dependent checks fail against the pre-v3 deployment |
| V3 PostgreSQL concurrency/rollback cases C23-C32 | Source/static contract passed; database-backed execution pending provisioning |
| Anonymous v3 vault creation and reload on deployed backend | Pending |
| Phrase/file-only restore derives the same Vault ID | PASS locally; deployed clean-profile run pending |
| New v3 upload produces only signed descriptors/manifests and no hosted recovery/key envelope; explicit share capabilities remain a separate user-authorized path | Pending live inspection |
| Uploader-offline exact recovery from other peers | Not run for v3 |
| K-shard success and below-K clean rejection | Not run for v3 |
| Share-link exact recovery and revocation | Not run for v3 |
| Repair, reconnect and verified deletion lifecycle | Not run for v3 |
| Warm Anchor path plus Supabase fallback | Not run for v3 |
| TURN-only transfer across restrictive networks | Not run |
| Physical Android Chrome and iPhone Safari | Not run |
| Production anonymous-auth/rate/abuse capacity | Not verified |

## Required release sequence

1. Run all repository contract, module, browser-unit, identity-portability and documentation-truth checks on the integrated source.
2. Provision the exact v3 Supabase artifacts and confirm the obsolete tables/columns are absent.
3. Execute C23-C32 against the provisioned database, including concurrent link-versus-upgrade and link-versus-delete, rollback, lease takeover, incomplete-generation rejection, atomic shared-segment deletion, pending-before-transfer placement and shared-hash cleanup.
4. Run a clean multi-browser smoke test on the deployed HTTPS origin.
5. Execute and record the protocol-v3 golden recovery described in `GOLDEN_RECOVERY_TEST_REPORT.md`.
6. Execute real-phone WebRTC/TURN, screen-lock, storage-retention and reconnect tests.
7. Review operational rate limits, abuse controls, monitoring and legal/controller details before widening access.

## Release language

Until the gates above are measured, TheMeshVault may be described as an alpha protocol-v3 source candidate. It must not be described as production-proven, guaranteed durable, independent of all bootstrap infrastructure, continuously online on sleeping phones, or a substitute for the user's only copy of important data.
