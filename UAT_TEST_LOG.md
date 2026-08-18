# TheMeshVault protocol-v3 UAT log

> Superseded architecture evidence: entries below that describe durable Supabase coordination, public rendezvous relays, recurring fallback or modeled Supabase write rates predate the 2026-08-16 first-contact-only cutoff. They remain test history, not current runtime claims. The current release requires a fresh live first-contact trace and proof of zero ordinary Supabase calls afterward.

Candidate date: 2026-08-05  
Environment: local source workspace plus operator-confirmed protocol-v3 backend provisioning.

## Test-log status

Protocol-v3 local verification is complete for the source, browser-local cryptography/storage contracts and deterministic scale models listed below. Provisioning has completed, but no production-like v3 upload/recovery UAT has yet been executed against that backend. This log does not carry forward PASS labels from the former recovery-envelope format.

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
| Post-provision Live Mesh | Four isolated browser profiles resolved a real connected peer pair and rendered stable Radial, Routes, Clusters, 3D and globe views | PASS |
| Post-provision PWA file integration | Installed-PWA share-target import and camera fixture completed through the production upload path on the successful rerun; one earlier attempt failed transiently with `Failed to fetch` | PASS on rerun |
| Device-storage UX | Browser-private encrypted shard inventory and storage-backend disclosure passed | PASS |
| Download progress | Real phases, cancel behavior, shortage error and exact-verification completion passed | PASS |
| App contract | Polymai app/bootstrap/runtime contract passed | PASS |
| Night Node | Lifecycle, contribution limit, reminder independence and mobile-safe actions passed | PASS |
| Public pages | Concise home, Terms gate, Security/Privacy data map and responsive document routes passed | PASS |
| PWA installability | Local installability checks passed in Chromium, Google Chrome and Microsoft Edge | PASS |
| Installed-PWA Live Mesh refresh | Foreground return resumed heartbeat/discovery, same-profile windows converged on discovered peers, service-worker updates were checked and volatile heartbeats did not close stable mesh details; direct links remained specific to each window | PASS in local browser/PWA profiles; not a mobile-background survival proof |

The scale and chaos checks use logical in-process simulations. They do not write their simulated nodes to Supabase, create thousands of browser profiles, traverse real networks, or prove live multi-browser WebRTC behavior. Browser-unit and PWA checks likewise do not prove Android/iOS background survival.

The backend-dependent PWA share-target and real-peer Live Mesh checks failed against the old pre-v3 deployment. After provisioning, Live Mesh passed with four isolated real browser profiles, and PWA file integration passed on a second run after one transient `Failed to fetch`. Those results establish current browser integration and connectivity, not uploader-offline recovery or TURN behavior.

## Deployed/live v3 UAT matrix

| ID | Journey | Expected v3 result | Status |
|---|---|---|---:|
| V3-01 | Create a no-account vault on the configured backend | Browser generates a checksum-valid 24-word Mesh Key, derives Ed25519 identity and registers the self-certifying Vault ID | PASS in post-provision browser checks |
| V3-02 | Reload the deployed vault | Local identity and keyring reopen without hosted recovery lookup | Not run live |
| V3-03 | Restore from phrase in a clean browser profile | Same owner public key and Vault ID are derived locally, then the vault opens through configured coordination | PASS in full portability run |
| V3-04 | Restore from complete v3 Mesh Key file | Same owner public key and Vault ID are derived without a second secret | PASS in full portability run |
| V3-05 | Reject malformed or altered Mesh Key | Validation fails without changing the current vault | PASS in full portability run |
| V3-06 | Upload compressible and incompressible fixtures | Real phase progress; 8 MiB segmentation; gzip only at 5% or better; signed descriptors/manifests | Small PWA share/camera fixtures passed; multi-segment and remote-placement evidence pending |
| V3-07 | Inspect hosted data | No root/private key, removed legacy recovery/key-envelope records, segment ciphertext or shard bytes in Supabase; an explicit share may contain a recipient-encrypted one-file key grant without its URL-fragment secret | Schema provisioned; deployed row/request inspection pending |
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
| V3-18 | Database segment lifecycle races | Concurrent link-versus-upgrade and link-versus-delete, incomplete generations, expired claims, ambiguous transfers, atomic shared-segment deletion, ready-segment cleanup, pending-before-transfer placement, shared-hash cleanup and transaction rollback satisfy C23-C32 on provisioned PostgreSQL | SQL provisioned; dedicated concurrency run pending |
| V3-19 | Four-profile peer connectivity | Independent browser contexts discover peers, establish a real connected pair and render one stable observed topology | PASS; no shard-recovery claim |
| V3-20 | Android native source and bridge contract | Trusted-origin bridge passes public configuration only; native worker rejects vault keys, stores opaque shards privately and uses bounded transfer Wake Locks | PASS in static source/contract checks; APK build pending |
| V3-21 | Android locked-screen native node | A user-started foreground service retains a real peer, stores/serves a shard with screen off, restarts only when opted in and reports force-stop honestly | Not run on physical devices |

## Evidence to capture per deployed run

- deployed revision, origin, browser/OS versions and isolated profile IDs;
- protocol/storage/manifest version reported by each peer;
- original and recovered byte counts and SHA-256;
- signed manifest and descriptor verification outcomes;
- per-segment K/N profile and independent verified placements;
- WebRTC/TURN path and measured transfer bytes;
- Supabase table/request inspection proving the v3 privacy boundary;
- page, network and backend errors without excluding unexpected failures.
- Android build version, foreground-service notification, battery mode, screen-off duration, reboot/force-stop behavior and native node/shard counters where the wrapper is under test.

## Acceptance rule

The candidate remains **NO-GO** until the real uploader-offline golden recovery and threshold boundary pass, and TURN plus physical-phone risks are either passed or explicitly constrained for a small pilot.
