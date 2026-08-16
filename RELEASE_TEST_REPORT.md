# TheMeshVault protocol-v3 release test report

> Superseded architecture evidence: this report predates the 2026-08-16 first-contact-only cutoff. Results describing durable Supabase metadata, recurring compatibility leases, automatic fallback or modeled Supabase write rates are historical and do not validate the current runtime. Fresh first-contact and zero-steady-state-egress UAT is required.

Date: 2026-08-05  
Candidate: local-root-key protocol v3, manifest/storage format v3  
Decision: **NO-GO until the v3 live recovery gates pass**

## Candidate summary

This candidate is a deliberate pre-release reset, not an in-place compatibility release. There are no production users to migrate. The completed provisioning applied the `local-root-key-v3` migration marker, removed the app-owned v1/v2 data contract and created the protocol-v3 app contract. Supabase Auth and schemas outside `app717_meshvault` are outside that reset.

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

These are implementation/source findings. The revised artifacts are now provisioned, but provisioning alone is not evidence that an end-to-end v3 upload, peer recovery or deletion journey has passed.

## Provisioning result

The operator confirmed successful protocol-v3 provisioning on 5 August 2026 after the PL/pgSQL repair. This establishes that the current schema plan 11, raw SQL/RLS/Realtime artifacts and app Edge deployment path passed the provisioning step. The provisioner compiling and applying those artifacts does not execute the C23-C32 concurrency scenarios or inspect live user rows for the key-custody boundary.

## Protocol-v3 local verification completed

The following checks passed on 2026-08-05 against the local source candidate. They verify source contracts, browser-local cryptography/storage behavior and deterministic simulations; they do not certify a live multi-browser WebRTC mesh.

| Evidence | Local result |
|---|---:|
| ES-module import/export graph | PASS, 96 modules |
| JavaScript syntax | PASS, 105 modules plus `sw.js` |
| Mesh Key portability | PASS in the full configured-backend browser run; deterministic phrase/file restore, same Vault ID, checksum rejection, pre-v3 rejection and no phrase request/log leakage |
| Browser-unit cryptography/storage suite | PASS |
| Documentation truth | PASS |
| Supabase source/schema/RLS contract | PASS; protocol-v3 schema plan 11 |
| Local/mesh/first-contact control-plane contract | PASS; ordinary profiles permit Supabase only during the bounded Patient Zero handoff, persist the completed handoff locally and reject later hosted calls before the network |
| Coordination scale simulation | PASS, 10,000 local simulated nodes; zero network or Supabase requests generated |
| Shard lifecycle profiles, thresholds, repair and rejoin | PASS |
| Adaptive upload/download transfer contracts | PASS |
| 1,000-node chaos simulation | PASS; original SHA-256 retained; 12+4 recovered after four losses and rejected after five; 33 repairs and 33 retirements |
| Anchor survival and optional reminder contracts | PASS |
| Post-provision four-profile Live Mesh | PASS; real connected peer pair and stable Radial, Routes, Clusters, 3D and globe renderers; this is not a file-shard transfer proof |
| Post-provision PWA file integration | PASS on the successful rerun; share-target import and camera fixture completed through the production upload path after one earlier transient `Failed to fetch` attempt |
| Browser-private hosted-shard storage UX | PASS |
| Download progress, cancellation and exact-verification UI | PASS |
| Polymai app contract | PASS |
| Night Node lifecycle/UI contract | PASS |
| Public pages and legal/security disclosure contract | PASS |
| PWA installability | PASS in local Chromium, Google Chrome and Microsoft Edge checks |
| Installed-PWA Live Mesh refresh | PASS for foreground heartbeat/discovery resume, same-profile discovered-peer synchronization, semantic topology events and service-worker update checks; direct links remain correctly window-local |

The 10,000-node coordination run and 1,000-node shard-chaos run are deterministic simulations. They do not send their simulated nodes to Supabase, open thousands of browser processes, exercise live signaling/TURN, or prove real multi-browser WebRTC transfer.

Before v3 provisioning, the PWA share-target check timed out and the Live Mesh renderer check could not establish a connected peer pair against the old backend. After provisioning, the four-profile Live Mesh check passed and the PWA file-integration check passed on its second run after one transient `Failed to fetch`. These reruns establish browser integration and peer connectivity; they do not establish uploader-offline shard recovery, K/K-1 behavior or TURN traversal.

## Historical evidence boundary

The July v0.1 browser, recovery, repair, sharing, deletion, scale and mobile-layout runs remain useful engineering history. They tested the former protocol and included recovery-envelope/wrapped-key paths that protocol v3 has removed. They must not be quoted as a PASS for this candidate.

That superseded report's decision was **CONDITIONAL GO for a small, invite-only pilot** and **NO-GO for an unrestricted public launch**. Protocol v3 resets the evidence boundary, so even that conditional pilot decision is paused until the v3 gates below pass.

In particular, the former 24 MiB uploader-offline result, five-browser 3+2 threshold result and live Supabase outage result need fresh v3 execution. Their historical byte/hash observations are retained in earlier test artifacts, but the current release decision does not rely on them.

The former outage result proved an already-established mesh only. **This is warm-mesh survival, not cold-start independence.** It also does not certify the new v3 control path.

## Current release gates

| Gate | Current status |
|---|---:|
| V3 schema/RLS/Realtime/Edge artifacts aligned in source | PASS in local contract checks |
| V3 app-schema reset provisioned successfully | PASS; operator-confirmed provisioning on 2026-08-05 |
| V3 PostgreSQL concurrency/rollback cases C23-C32 | Source/static contract passed; dedicated database-backed execution pending |
| Anonymous v3 vault creation on the configured backend | PASS in post-provision portability, PWA and Live Mesh browser checks; ordinary warm reload remains a separate smoke step |
| Phrase/file-only restore derives the same Vault ID | PASS in clean browser profiles in the full portability run |
| New v3 upload produces only signed descriptors/manifests and no hosted recovery/key envelope; explicit share capabilities remain a separate user-authorized path | Small PWA share-target and camera uploads passed; multi-segment remote placement and hosted-data inspection pending |
| Four-profile peer discovery and DataChannel connectivity | PASS; no file-shard recovery claim |
| Uploader-offline exact recovery from other peers | Not run for v3 |
| K-shard success and below-K clean rejection | Not run for v3 |
| Share-link exact recovery and revocation | Not run for v3 |
| Repair, reconnect and verified deletion lifecycle | Not run for v3 |
| Patient Zero first-contact handoff followed by permanent local Supabase cutoff | Source/static contract passed; clean-profile deployed execution pending |
| TURN-only transfer across restrictive networks | Not run |
| Physical Android Chrome and iPhone Safari | Not run |
| Generated Android native worker/source contract | PASS in static source and Polymai generator checks; APK/AAB build pending |
| Android foreground service with locked screen, reboot and force-stop | Not run on a physical device |
| Production anonymous-auth/rate/abuse capacity | Not verified |

## Required release sequence

1. Run all repository contract, module, browser-unit, identity-portability and documentation-truth checks on the integrated source.
2. Inspect the provisioned schema once to confirm obsolete recovery/key-envelope tables and columns are absent.
3. Execute C23-C32 against the provisioned database, including concurrent link-versus-upgrade and link-versus-delete, rollback, lease takeover, incomplete-generation rejection, atomic shared-segment deletion, pending-before-transfer placement and shared-hash cleanup.
4. Run a clean multi-browser smoke test on the deployed HTTPS origin.
5. Execute and record the protocol-v3 golden recovery described in `GOLDEN_RECOVERY_TEST_REPORT.md`.
6. Generate and sign the Android wrapper, then execute real-phone native WebRTC/TURN, screen-lock, reboot, force-stop, storage-retention and reconnect tests from `ANDROID_BACKGROUND_NODE.md`.
7. Review operational rate limits, abuse controls, monitoring and legal/controller details before widening access.

## Release language

Until the gates above are measured, TheMeshVault may be described as an alpha protocol-v3 candidate with a provisioned coordination backend. It must not be described as production-proven, guaranteed durable, independent of all bootstrap infrastructure, continuously online on sleeping phones, or a substitute for the user's only copy of important data.
