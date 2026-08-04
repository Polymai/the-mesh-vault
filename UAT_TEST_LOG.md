# TheMeshVault protocol-v3 UAT log

Candidate date: 2026-08-05  
Environment: local source workspace; protocol-v3 backend provisioning pending.

## Test-log status

Protocol-v3 local verification is complete for the source, browser-local cryptography/storage contracts and deterministic scale models listed below. No production-like UAT has yet been executed against a provisioned v3 backend, and this log does not carry forward PASS labels from the former recovery-envelope format.

The July browser-profile UAT remains historical evidence that direct WebRTC transfer, threshold reconstruction, repair, sharing and deletion worked in that older candidate. Because v3 changes identity derivation, manifests, segment descriptors, schema and recovery, the affected live journeys require a new run.

No physical Android or iPhone was represented. A Production anonymous-auth burst test is also still required; desktop engines and simulated nodes do not establish those production boundaries.

## Executed local verification — 2026-08-05

| Check | Evidence observed | Result |
|---|---|---:|
| Module graph | 96 ES modules resolved with matching imports/exports | PASS |
| JavaScript syntax | 105 JavaScript modules plus `sw.js` parsed | PASS |
| Mesh Key portability | Phrase and complete-file paths derived the same v3 Vault ID; invalid input and atomic rollback cases passed | PASS |
| Browser-unit crypto/storage | Ed25519 vectors, v3 key derivation, manifest/descriptor verification and local storage/reset cases passed | PASS |
| Documentation truth | Public, legal, defensive-publication and release boundaries matched the v3 source | PASS |
| Supabase contract | Protocol-v3 schema plan 11, SQL, RLS, RPC, recipient-scoped signaling and Edge contracts aligned locally | PASS |
| Control plane | Signed/encrypted index, operation sequencing, cache bounds, tokenized leases, exact generation commits, atomic deduplicated deletion, pending-before-transfer placement and fail-closed shared-hash cleanup contracts through C32 passed locally | PASS |
| Coordination scale model | 10,000 logical nodes and 200 logical Anchors; maximum Anchor load 181; about 18.6 modeled Supabase writes/second | PASS |
| Shard lifecycle | Automatic/manual profiles, threshold recovery, repair, rejoin and retirement contracts passed | PASS |
| Adaptive transfer | Bounded upload/download concurrency, retry, timeout and excess-work cancellation contracts passed | PASS |
| 1,000-node chaos model | Exact source SHA-256 retained; 12+4 recovered after four shard losses and rejected after five; 33 repairs and 33 retirements completed | PASS |
| Anchor survival | Lease, buddy, Wake Lock and optional reminder behavior passed | PASS |
| Device-storage UX | Browser-private encrypted shard inventory and storage-backend disclosure passed | PASS |
| Download progress | Real phases, cancel behavior, shortage error and exact-verification completion passed | PASS |
| App contract | Polymai app/bootstrap/runtime contract passed | PASS |
| Night Node | Lifecycle, contribution limit, reminder independence and mobile-safe actions passed | PASS |
| Public pages | Concise home, Terms gate, Security/Privacy data map and responsive document routes passed | PASS |
| PWA installability | Local installability checks passed in Chromium, Google Chrome and Microsoft Edge | PASS |

The scale and chaos checks use logical in-process simulations. They do not write their simulated nodes to Supabase, create thousands of browser profiles, traverse real networks, or prove live multi-browser WebRTC behavior. Browser-unit and PWA checks likewise do not prove Android/iOS background survival.

The backend-dependent PWA share-target and real-peer Live Mesh checks were attempted against the existing pre-v3 deployment. The share-target flow timed out before its imported file could complete the production upload, and the mesh-view check could not resolve a connected peer pair. These remain explicit failed release gates pending v3 provisioning; the app correctly retains unfinished local work rather than claiming successful distribution.

## Deployed/live v3 UAT matrix

| ID | Journey | Expected v3 result | Status |
|---|---|---|---:|
| V3-01 | Create a no-account vault on the deployed origin | Browser generates a checksum-valid 24-word Mesh Key, derives Ed25519 identity and registers the self-certifying Vault ID | Pending provisioning |
| V3-02 | Reload the deployed vault | Local identity and keyring reopen without hosted recovery lookup | Pending |
| V3-03 | Restore from phrase in a clean browser profile | Same owner public key and Vault ID are derived locally, then live catalog discovery succeeds | Local derivation passed; live run pending |
| V3-04 | Restore from complete v3 Mesh Key file | Same owner public key and Vault ID are derived without a second secret | Local derivation passed; live run pending |
| V3-05 | Reject malformed or altered Mesh Key | Validation fails without changing the current vault | Passed locally; live UI smoke pending |
| V3-06 | Upload compressible and incompressible fixtures | Real phase progress; 8 MiB segmentation; gzip only at 5% or better; signed descriptors/manifests | Pending live mesh |
| V3-07 | Inspect hosted data | No root/private key, recovery envelope, storage-manifest wrapped segment key, segment ciphertext or shard bytes in Supabase; an explicit share may contain a recipient-encrypted one-file key grant without its URL-fragment secret | Source contract passed; deployed inspection pending |
| V3-08 | Recover after uploader shutdown | A clean restored browser obtains K shards from other peers and matches original SHA-256 | Not run for v3 |
| V3-09 | Recover at and below the stored threshold | K succeeds exactly; K-1 returns a bounded error and no file | Simulation passed; live run pending |
| V3-10 | Create, redeem and revoke a share link | Recipient receives only limited capability grants; exact recovery and revocation succeed | Pending live mesh |
| V3-11 | Node loss and repair | Correct signed coding generation/shard is repaired on a new node | Simulation/source checks passed; live run pending |
| V3-12 | Delete file/folder | Online copies erase; offline orders remain pending until the addressed profile returns | Pending live mesh |
| V3-13 | Supabase interruption with a warm mesh | Established peers/Anchors continue only held functions and fallback resumes safely | Pending v3 live run |
| V3-14 | Cold start with insufficient Anchors | Supabase bootstrap/fallback is used and the limitation remains visible | Pending v3 live run |
| V3-15 | TURN-required cross-network transfer | Exact transfer/recovery through the configured relay path | Not run |
| V3-16 | Physical Android/iPhone suspension | UI remains honest about offline state; no promise of permanent browser execution | Not run |
| V3-17 | Production anonymous-auth and abuse capacity | Intended invitation burst and bounded quotas operate without unacceptable failure | Not verified |
| V3-18 | Database segment lifecycle races | Concurrent link-versus-upgrade and link-versus-delete, incomplete generations, expired claims, ambiguous transfers, atomic shared-segment deletion, ready-segment cleanup, pending-before-transfer placement, shared-hash cleanup and transaction rollback satisfy C23-C32 on provisioned PostgreSQL | Source contract passed; database run pending |

## Evidence to capture per deployed run

- deployed revision, origin, browser/OS versions and isolated profile IDs;
- protocol/storage/manifest version reported by each peer;
- original and recovered byte counts and SHA-256;
- signed manifest and descriptor verification outcomes;
- per-segment K/N profile and independent verified placements;
- WebRTC/TURN path and measured transfer bytes;
- Supabase table/request inspection proving the v3 privacy boundary;
- page, network and backend errors without excluding unexpected failures.

## Acceptance rule

The candidate remains **NO-GO** until the v3 artifacts are provisioned, the real uploader-offline golden recovery and threshold boundary pass, and TURN plus physical-phone risks are either passed or explicitly constrained for a small pilot.
