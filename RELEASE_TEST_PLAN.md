# TheMeshVault protocol-v3 Release Test Plan

> Current architecture note (2026-08-16): Supabase is permitted only during one bounded first-contact phase for an ordinary local node profile. Patient Zero is the sole persistent hosted listener. Older gates that refer to durable Supabase metadata, automatic fallback, public rendezvous relays or recurring ordinary-node Supabase traffic are superseded. Acceptance now requires zero ordinary steady-state Supabase calls after first-peer verification and reload.

## Objective

Establish whether the provisioned TheMeshVault application is safe and functional enough for a first public release. Tests must use real app code and real Supabase first-contact coordination where that gate is under test. Stubs are allowed only for deterministic unit checks and must never be reported as end-to-end proof.

## Result states

- `PASS`: observed behavior meets the stated acceptance criteria.
- `FAIL`: observed behavior contradicts the acceptance criteria.
- `BLOCKED`: an external prerequisite is unavailable, such as a confirmed email account, TURN-only network, or physical mobile device.
- `NOT PROVEN`: the scenario cannot be honestly established in the available environment.

Any P0 failure blocks release. P1 failures block release unless the feature is removed from the release surface or clearly disabled. P2 findings may ship only when they do not create false security, durability, or recovery claims.

## Test environment

- Local app origin served from `http://127.0.0.1:3007`.
- Provisioned protocol-v3 Supabase project configured by `data/supabaseConfig.js`.
- Fresh isolated Chromium contexts for independent browser profiles.
- Five simultaneous browser profiles for the minimum 3+2 WebRTC test, plus ten-browser and sixteen-profile deterministic lifecycle coverage for the larger release profiles.
- Desktop viewport: 1440 × 1000.
- Mobile viewport: 390 × 844.
- Test payloads:
  - small compressible text file;
  - small already-compressed PNG;
  - deterministic multi-segment binary file larger than 8 MiB;
  - file name and optional vault name containing HTML-sensitive characters.
- Downloaded bytes are compared with the original SHA-256 hash.

## Gate A — Static contracts, configuration, and security

| ID | Priority | Test | Acceptance criteria |
|---|---|---|---|
| A01 | P0 | Registry inventory | Every `registry.json` load-order path exists and responsibilities match runtime reality. |
| A02 | P0 | JS and JSON parsing | All app JavaScript parses and JSON contracts load. |
| A03 | P0 | Module graph | Every relative import resolves and every named import exists as an export. |
| A04 | P0 | Supabase contract | Runtime tables/RPCs, SQL schema, RLS, Realtime, Edge route, and `data/schema.json` agree. |
| A05 | P0 | Secret scan | No service-role key, provider secret, TURN secret, private key, recovery phrase, or database password is shipped in frontend/data/SQL/registry files. |
| A06 | P0 | Anonymous API boundary | Anonymous Supabase session can call the app Edge function; unauthenticated requests are rejected. |
| A07 | P1 | Storage isolation | App-owned browser storage keys use the configured app prefix. |
| A08 | P1 | Honest runtime claims | No simulated capacity, placement, resilience, connection, transfer, or recovery values appear in product UI. |

## Gate B — Anonymous identity, recovery, and persistence

| ID | Priority | Test | Acceptance criteria |
|---|---|---|---|
| B01 | P0 | Cold anonymous onboarding | A fresh profile reaches onboarding and can create a vault without email/password. |
| B02 | P0 | Self-certifying identity | `vault_id` equals the SHA-256 hash of the stored owner public key. |
| B03 | P0 | Warm reload | Reload preserves Vault ID, device identity, files, settings, and locally available keys. |
| B04 | P0 | Mesh Key export | Recovery phrase and downloaded Mesh Key file are available and contain no unrelated secrets. |
| B05 | P0 | Mesh Key verification | Correct phrase verifies; altered phrase is rejected. |
| B06 | P0 | Clean-profile restore | Mesh Key file or phrase restores the same Vault ID in a fresh browser context. |
| B07 | P1 | Vault name | Optional name is escaped in UI and encrypted at rest; legacy manual location metadata is ignored. |
| B08 | P1 | Device identity separation | Restoring the vault creates a distinct local device identity; no unfinished trusted-device registration UI implies that another browser has been approved through a flow the release does not provide. |

## Gate C — File pipeline and exact recovery

| ID | Priority | Test | Acceptance criteria |
|---|---|---|---|
| C01 | P0 | Upload progress | Upload shows ordered reading/compression/encryption/erasure/transfer/verification phases and prevents accidental interruption. |
| C02 | P0 | Compressible upload | Compression is used only when a segment saves at least 5%. |
| C03 | P0 | Pre-compressed upload | PNG or equivalent pre-compressed data skips ineffective compression. |
| C04 | P0 | Multi-segment upload | A file larger than 8 MiB produces multiple independently encrypted/coded segments without a whole-file buffer path. |
| C05 | P0 | Manifest integrity | The signed protocol-v3 manifest and every owner-signed segment descriptor bind the Vault ID, derivation inputs, ciphertext hash, coding generation, shard hashes and placement records; pre-v3 formats are rejected. |
| C06 | P0 | Distinct failure domains | One erasure group never claims independent-device protection when shards share the same browser profile. |
| C07 | P0 | Download recovery | Enough shards reconstruct, decrypt, decompress, and download the original bytes. |
| C08 | P0 | Exact hash | Downloaded SHA-256 equals original SHA-256 for small and multi-segment payloads. |
| C09 | P1 | Deduplication | Re-upload/version reuse is vault-scoped and does not expose cross-vault fingerprints. |
| C10 | P0 | Durable mesh delete | Delete revokes known capabilities, persists an owner-signed node-bound order before hiding the file, removes connected copies with acknowledgements, and retains pending orders for offline nodes. |
| C11 | P1 | Honest storage metrics | Original, compressed, physical, shard, segment, profile, device, diversity, and recovery figures come from persisted proof/placement data. |
| C12 | P1 | Failure UX | Quota, network, cancellation, timeout, and retry paths leave a recoverable UI state with an actionable message. |
| C13 | P0 | K/R/N separation | Recovery threshold K, proactive repair threshold R, and target shard count N are persisted and used as separate values. |
| C14 | P0 | Delete reconnect | An offline node deletes the authorized shard when its original browser profile reconnects, acknowledges the placement, and final metadata disappears only after all known placements acknowledge deletion. |
| C15 | P0 | Delete authorization | A missing, tampered, expired, wrong-node, wrong-shard, or non-owner-signed file deletion command cannot remove a physical shard. |
| C16 | P0 | Deduplicated delete | Deleting one file/version never removes a content segment or physical shard still referenced by another live file/version. |
| C17 | P1 | Delete communication | File and folder deletion use app-native confirmation and result dialogs that state immediate vault removal, capability revocation, acknowledged copies, and honest offline-copy limits without invoking the browser's native confirm UI. |
| C18 | P0 | Recursive folder delete | The preview counts descendant folders/files, every contained file enters the verified mesh-deletion lifecycle, and the folder tree is removed only after those deletion requests start successfully. |
| C19 | P1 | Long-lived deletion orders | Recent pending copies show active progress; orders older than seven days remain retained and discoverable in compact background cleanup without claiming that never-returning devices erased their local encrypted shard. |
| C20 | P1 | Hide deletion status | A user can hide a pending row from Drive immediately or from the result dialog; the preference persists per vault in that browser while the signed backend deletion order and cleanup accounting remain active. |
| C21 | P0 | Atomic profile upgrade | Signed manifests are staged first; the segment generation and every referencing file-version pointer commit in one transaction; old shards retire only afterwards; a failed commit leaves the prior generation readable. |
| C22 | P0 | Canonical identifiers | Uppercase or otherwise non-canonical protocol hashes/UUIDs are rejected before signature acceptance or segment-key derivation, and SQL accepts only lowercase canonical shard/segment hashes. |
| C23 | P0 | Concurrent dedup link | A reusable-segment link and a profile upgrade serialize on the same segment lock; a changed generation is retried, and commit rejects any omitted or duplicate file-version reference. |
| C24 | P0 | Complete staged generation | Commit rejects a missing/duplicate shard index, unverified shard, byte-total mismatch, or shard without a verified durable placement; the previous generation remains current after rollback. |
| C25 | P0 | Upgrade claim lease | Only the current UUID claim holder can renew, commit, or release a profile upgrade; active work renews the lease and only an actually expired lease may be reclaimed. |
| C26 | P0 | Failed-generation cleanup | Failed staged placements enter the acknowledged lifecycle-deletion queue; hash-addressed bytes shared with an active generation are retained and offline remote cleanup records are not discarded. |
| C27 | P0 | Abandoned-generation takeover | A genuinely expired claim marks every higher, uncommitted generation for lifecycle deletion; the replacement claim selects a generation above all retained rows and cannot touch the committed generation. |
| C28 | P0 | Ambiguous transfer cleanup | A placement is durably reserved before local or remote bytes are written; failed or unacknowledged writes remain retryable deletion records instead of becoming untracked storage. |
| C29 | P0 | Ready dedup cleanup boundary | Once a new segment is signed and marked ready, failure to link the creating version cannot delete it because another concurrent version may already have reused it. |
| C30 | P0 | Atomic deduplicated delete | File deletion locks every touched content segment, counts actual links belonging to other files, removes only this file's links from shared segments, and moves a segment to deleting only at zero remaining references. A concurrent link committed first keeps the segment ready; a link arriving after the zero-reference transition is rejected. Capability revocation, file tombstone and placement deletion intent commit in the same transaction. |
| C31 | P0 | Content-addressed cleanup guard | Download, recovery, cache and Anchor-delivered deletion paths remove a local shard hash only after one shared fail-closed lookup proves that no other physical placement on this node still references those bytes. |
| C32 | P0 | Initial-upload placement lifecycle | Every initial local or remote shard destination is persisted as pending before bytes are written, becomes verified only after hash/transfer acknowledgement, and enters retryable lifecycle deletion on failure. A failed building segment retains its shard and placement cleanup intent until every ambiguous copy is acknowledged; it is never cascade-deleted first. |

## Gate D — Five-browser WebRTC mesh

| ID | Priority | Test | Acceptance criteria |
|---|---|---|---|
| D01 | P0 | Independent profiles | Five contexts create five distinct device keys and failure-domain IDs. |
| D02 | P0 | Discovery | Active nodes become visible through provisioned coordination without fabricated peers. |
| D03 | P0 | DataChannels | Direct WebRTC channels open between eligible contexts and expose measured, not simulated, state. |
| D04 | P0 | Shard transfer | Uploaded shards are acknowledged and hash-verified by remote browser profiles. |
| D05 | P0 | 3+2 placement | With five eligible independent nodes, each segment can reach five distinct placements and requires three shards. |
| D06 | P1 | Adaptive upgrade | Adding eligible nodes can create a stronger immutable coding generation without invalidating the old readable generation. |
| D07 | P1 | Capacity policy | Nodes without shard headroom are excluded; remaining targets are ranked by diversity, reliability, utilization, throughput, and RTT. |
| D08 | P1 | Mesh visualization | Node links, selected-node neighbors, transfers, locations, and storage holdings correspond to observed runtime data. |
| D09 | P0 | Current profiles | Automatic selects 3+2 at five nodes, 7+3 at ten, 8+4 at twelve and 10+6 at sixteen; Balanced selects 12+4 at sixteen. |

## Gate E — Sharing, resilience, repair, and outage behavior

| ID | Priority | Test | Acceptance criteria |
|---|---|---|---|
| E01 | P0 | Anonymous share | A capability link opens in a cold identity-less context and recovers exact bytes without leaking the capability key to Supabase. |
| E02 | P0 | Tamper rejection | Modified capability, manifest, shard, ciphertext, or signature is rejected. |
| E03 | P1 | Revocation/expiry limits | Expired or revoked capabilities fail when the coordination check is reachable; offline caveat is stated honestly. |
| E04 | P0 | Node loss | Recovery remains possible only when every segment retains its required verified shard count. |
| E05 | P1 | Repair/rebalance | A replacement node receives verified shards when resilience drops below target; stale placements are not counted. |
| E06 | P0 | Warm Supabase outage | Existing local vault and established peer channels remain usable; status reports bootstrap loss without falsely claiming total mesh loss. |
| E07 | P1 | Reconnect | Coordination reconnects and queued signed control operations synchronize without changing vault ownership. |
| E08 | P1 | Cross-vault isolation | An unrelated anonymous vault cannot decrypt another vault's manifest, file, or local encrypted profile. |
| E09 | P0 | Repair grace | A silent node becomes suspect first; replacement is not created until the configured grace expires and active shards fall below R. |
| E10 | P0 | Rejoin reconciliation | If repaired shards raise ten logical placements to thirteen physical copies, verified returning copies are marked surplus and deleted only after the cleanup grace, returning to ten. |

## Gate F — Settings, location, anchor, and storage controls

| ID | Priority | Test | Acceptance criteria |
|---|---|---|---|
| F01 | P1 | Capacity setting | Contribution limit persists, clamps to configured bounds, and affects eligibility. |
| F02 | P1 | Pause/resume | Paused node stops new placement/transfer claims and reports honest state. |
| F03 | P1 | Persistent storage | Permission result is reflected accurately; denial is nonfatal. |
| F04 | P0 | Clear local shards | Explicit confirmation is required; only this browser's encrypted shards are removed and resilience drops honestly. |
| F05 | P1 | Automatic location | Browser permission yields only a coarse country; exact coordinates are not retained. Edge fallback and `Unknown` behavior are honest. |
| F06 | P1 | Placement diversity | New known country/region/network domains outrank duplicates when higher-priority safety constraints are equal. |
| F07 | P1 | Anchor lifecycle | Anchor opt-in, name, cache quota, persistence/Wake Lock status, signed control replication, and warm-readiness labels are accurate. |
| F08 | P2 | Capacity history | A timeline is shown only if a real snapshot producer creates measured samples; otherwise it must not imply monitoring exists. |

## Gate G — Navigation, responsive UI, accessibility, and release polish

| ID | Priority | Test | Acceptance criteria |
|---|---|---|---|
| G01 | P1 | Public navigation | “How it works,” home/back, open-vault, and route links work with browser history. |
| G02 | P1 | Vault navigation | Overview, Drive, Live Mesh, Anchor, Mesh Key, Settings, hosted-shard inventory, optional account and Share routes render without console/page errors where exposed. |
| G03 | P1 | Mobile layout | Public and vault surfaces have no horizontal overflow, clipping, hidden primary actions, or undersized touch targets. |
| G04 | P1 | Desktop layout | Public and vault surfaces retain hierarchy without overlap or excessive empty placeholders. |
| G05 | P1 | Keyboard operation | Menus, dialogs, forms, file actions, mesh node targets, and recovery controls are keyboard reachable. |
| G06 | P1 | Accessible status | Long operations use status/progress semantics; dialogs have labels; charts have titles/descriptions; focus is visible. |
| G07 | P1 | Reduced motion | Reduced-motion preference suppresses nonessential animation without hiding state. |
| G08 | P1 | Error/offline views | Boot, empty, error, retry, and local-only states are readable and actionable. |
| G09 | P1 | Browser console | No uncaught exceptions, unhandled rejections, CSP/mixed-content failures, or repeated failing request loops during tested flows. |
| G10 | P2 | Brand metadata | TheMeshVault naming, favicon, title, description, and wordmark remain consistent while compatibility identifiers stay unchanged. |
| G11 | P1 | Honest overview | Overview separately reports logical user bytes, vault physical shard bytes, global live-node used/offered capacity, direct peers, compression, profiles, and pending surplus cleanup. |

## Environment-limited evidence

The following cannot be honestly proven on one Windows machine alone and must be reported separately:

- TURN-only traversal across restrictive NAT/firewall combinations.
- Real geographic/ISP failure-domain diversity.
- Android background survival, battery behavior, and storage eviction.
- A complete real transfer at the current 100 MB per-file release boundary, including slow-network timeout and constrained-mobile memory behavior.
- Email confirmation, OAuth, or passkey flows without dedicated test accounts/provider setup.
- Long-duration uptime, churn, and repair behavior measured over days.

## Gate H — Cross-engine mobile-host UAT

| ID | Priority | Test | Acceptance criteria |
|---|---|---|---|
| H01 | P1 | Chromium mobile viewport | Public/legal/onboarding/vault/recovery/mesh routes render without overflow, page exceptions or backend errors. |
| H02 | P1 | Firefox mobile viewport | The same release surface works under Firefox's engine without assuming Chromium-only APIs. |
| H03 | P1 | WebKit mobile viewport | The same release surface works under WebKit without assuming a physical iPhone has been tested. |
| H04 | P0 | 100 MB boundary | An incompressible 100,000,000-byte payload uploads, distributes, shares and recovers with an exact external SHA-256. |
| H05 | P1 | Installed-PWA foreground refresh | Returning an installed PWA to the foreground resumes node presence, refreshes visible discovery, checks for a new service worker and updates discovered peers without rebuilding stable mesh/detail UI on every heartbeat. Same-profile windows may share discovered-peer metadata but must not claim that their direct WebRTC links are shared. |

## Gate I — Physical-phone production acceptance

These tests must run on the intended HTTPS production origin. Desktop emulation cannot satisfy them.

| ID | Priority | Test | Acceptance criteria |
|---|---|---|---|
| I01 | P0 | Five physical phones | Android Chrome and iPhone Safari participate across at least two networks, with distinct device identities and verified 3+2 placement. |
| I02 | P0 | Uploader-offline cold recovery | A sixth clean phone uses only the saved Mesh Key, retrieves shards after the uploader is powered off, and matches the external SHA-256. |
| I03 | P0 | Carrier/TURN path | Recovery succeeds when direct local-network connectivity is unavailable and the configured TURN path is required. |
| I04 | P0 | Mobile 100 MB | A 90–100 MB incompressible file completes on constrained phones without tab crash, whole-file memory failure or corrupt output. |
| I05 | P0 | Offline delete/reconnect | A physical holder that was offline during deletion later erases its encrypted shard and acknowledges the signed order. |
| I06 | P1 | Screen lock/background | At 15, 30 and 60 minutes, measured suspension, lease expiry, reconnection, storage retention and battery behavior are accurately reported. |
| I07 | P0 | Production auth capacity | The expected invitation burst creates anonymous sessions without HTTP 429, runaway retry or quota exhaustion. |
| I08 | P1 | Production monitoring | Auth, Realtime, Edge, TURN, failed transfer, repair and deletion-backlog alerts are active before invitations are sent. |

## Release decision

- `GO`: all P0 and P1 release-surface tests pass; no false durability/security claims remain.
- `CONDITIONAL GO`: all P0 tests pass and each P1 exception is disabled, removed, or explicitly documented.
- `NO-GO`: any P0 failure, unverified byte-exact recovery, false independent-device claim, missing shard distribution, capability leakage, ownership mismatch, or unrecoverable error path.

## Evidence to retain

- Machine-readable test-result JSON.
- Desktop/mobile screenshots for onboarding, dashboard, drive details, mesh, Anchor, settings, recovery, and share.
- Original/downloaded SHA-256 pairs.
- Observed device IDs, placement counts, coding profile, and connection states with secrets and recovery material redacted.
- Console/page errors and failed network requests, excluding intentionally blocked outage requests.
