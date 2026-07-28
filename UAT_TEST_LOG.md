# TheMeshVault v0.1 — UAT and Production-Readiness Test Log

Log created: 2026-07-24T06:04:22+02:00  
Application: TheMeshVault / app717  
Release candidate: local workspace source as of 2026-07-24  
Decision: **Conditional GO for an invite-only pilot after the physical-phone production gate passes**

## 2026-07-28 Anchor coordination implementation addendum

This addendum covers the source candidate that introduces the distributed Anchor control path. Its SQL/RLS/Realtime artifacts have **not** been applied to the live project during this run; Polymai provisioning is therefore still required before the new path can be called production-deployed.

| Test | Result | Observation |
|---|---:|---|
| 10,000-node coordination simulation | PASS | 10,000 logical clients selected three primary and two reserve Anchors from 200 independent candidates. Average primary load was 150 clients per Anchor and the maximum was 181. |
| Deterministic churn replacement | PASS | Two failed primary Anchors were replaced without selecting a failed node; all five assignments remained device-distinct. |
| Mode and hysteresis contract | PASS | Three Anchors enter hybrid first and become Anchor-primary only after 120 seconds; a drop below two restores Supabase-primary, while a hosted outage yields mesh-degraded or isolated truthfully. A recovered Anchor set starts a fresh stability window. |
| Estimated hosted heartbeat load | PASS | The configured 60-second Anchor and 120-second Anchor-primary client intervals estimate about 85 writes per second at 10,000 clients and 200 Anchors, before database/provider overhead. This is a model, not a production load test. |
| Bounded discovery and signaling contract | PASS | Static/schema checks confirm bounded candidate RPCs, random app-owned recipient topics, protocol-v1 row fallback, no global `nodes` subscription and no policy or ownership change on `realtime.messages`. |
| Anchor repair advisory contract | PASS | Missing-shard events create signed, expiring mesh advisories; the existing Supabase repair queue remains the atomic job authority when reachable. |
| 1,000-node shard chaos | PASS | 1,000 initial and 1,270 final logical nodes completed exact hash recovery, 33 repairs, 33 deterministic surplus retirements and restoration of three Anchor replicas. |
| Storage/identity transaction durability | PASS | Focused browser checks verified committed public node-name persistence and a real encrypted local shard after IndexedDB writes were changed to resolve only after transaction commit. |
| Startup-race identity durability | PASS | Three consecutive mobile browser runs retained a public node name while node activation was still completing. Device/vault identity creation is serialized and late network activation can no longer overwrite the saved label. |
| Complete Mesh Key local-first restore | PASS | A fresh browser opened the same self-certifying Vault ID from a version-2 Mesh Key file without waiting for hosted recovery-envelope lookup. |
| Phrase-only fresh-browser restore | BLOCKED | This path correctly requires an Anchor or Supabase recovery-envelope lookup. No Anchor was already connected and the live project rejected creation of the new anonymous coordination session after repeated UAT exhausted its signup rate window. |
| App, schema, docs and visual contracts | PASS | Registry, JavaScript/JSON syntax, Supabase contract, documentation truth, public pages, PWA file intake, download progress, shard lifecycle, visual and app contracts passed. |
| Fresh live multi-browser run against the newly provisioned schema | BLOCKED | Repeated UAT exhausted the live project's anonymous-signup rate during this run. The mesh test now shares one pseudonymous coordination session across device-isolated profiles to avoid future test-only signup bursts, but a new session could not be created before the rate window reset. |

The retained July 24 real-WebRTC and exact-recovery evidence remains valid for the previous provisioned backend. It does not by itself prove the newly added Anchor routing RPCs in production. The release decision therefore remains conditional, and the physical-phone gate below is unchanged.

## Test environment

| Item | Value |
|---|---|
| Application origin | `http://127.0.0.1:3007` |
| Coordination backend | Provisioned live Supabase project |
| Host | One Windows computer |
| Browser isolation | Separate Playwright browser contexts and persistent profiles |
| Engines | Chromium, Firefox and WebKit |
| Mesh sizes | Five independent browser profiles and a separate ten-profile run |
| Transport | Real WebRTC DataChannels between browser profiles |
| File content storage | Browser OPFS/IndexedDB; no Supabase Storage whole-file path |
| Integrity check | External and application SHA-256 comparison |
| Important limitation | Mobile engines were desktop-hosted. No physical Android or iPhone was represented. |

## Execution summary

### Fresh final-candidate rerun — 10:17–11:00 CEST

The release candidate was rerun after the latest UI, signaling and recovery corrections. The final full regression completed at 11:00 CEST with **26/26 PASS**, no P0/P1 failures, no page exceptions and no unexpected HTTP errors. Expected diagnostics were the deliberate unauthenticated Edge boundary, bounded stale-recipient signal rejections during profile teardown and network failures created by the simulated Supabase outage.

Fresh retained evidence:

| Run | Finished | Result | Key evidence |
|---|---:|---:|---|
| Final full regression | 11:00 CEST | **PASS 26/26** | Five real browser profiles, exact small/multi-segment recovery, sharing/revocation, deduplication, folders, Anchors and warm outage |
| Exact 100 MB boundary | 10:21 CEST | **PASS** | 100,000,000 bytes, 12 segments, 60 verified placements and exact cold-recipient SHA-256 |
| Uploader-offline golden recovery | 10:51 CEST | **PASS** | 24 MiB, uploader stale/offline, clean Mesh-Key-only browser, exact 4/5 and 3/5, correct 2/5 rejection |
| Ten-node profile | 10:52 CEST | **PASS** | K=7, repair threshold=9, N=10; 7+3 across ten node IDs/failure domains |
| Repair and rebalance | 10:53 CEST | **PASS** | Lost shard replaced and recovered SHA-256 unchanged |
| Offline delete/reconnect | 10:57 CEST | **PASS** | Signed pending order, same profile reconnect, local erasure and backend finalization |
| Chromium/Firefox/WebKit | 10:57 CEST | **PASS 3/3** | Zero page errors, backend errors or tested responsive-route overflow |

| Run | Finished | Result | Scope | Evidence |
|---|---:|---:|---|---|
| Full release regression | 05:58 CEST | **PASS 26/26** | Anonymous onboarding, Mesh Key, five-node mesh, Anchors, upload/download, compression, deduplication, sharing, revocation, cross-vault isolation, warm Supabase outage and responsive routes | `.polymai/release-results.json` |
| Golden uploader-offline recovery | 05:24 CEST | **PASS** | Real 24 MiB file, uploader closed, clean Mesh-Key-only restore, exact 4/5 and 3/5 recovery, correct 2/5 rejection | `.polymai/golden-recovery-results.json` |
| 100 MB boundary | 05:35 CEST | **PASS** | Exact 100,000,000-byte random payload, 12 segments, 60 placements across five profiles, cold-share exact recovery and revocation | `.polymai/release-boundary-results.json` |
| Ten-node profile | 06:02 CEST | **PASS** | K=7, repair threshold=9, N=10 (7+3); ten placements on ten node IDs and failure domains | `.polymai/release-ten-node-results.json` |
| Repair and rebalance | 05:59 CEST | **PASS** | Cleared holder, unavailable placement, queued repair, verified replacement and unchanged recovered hash | `.polymai/release-repair-results.json` |
| Offline deletion/reconnect | 05:06 CEST | **PASS** | Offline shard copy remained pending; the same browser profile returned, erased the shard and finalized the signed order | `.polymai/offline-delete-reconnect-results.json` |
| Recursive folder deletion | 06:00 CEST | **PASS** | Folder/file impact confirmation, contained file deletion lifecycle and folder removal | Console result from `.polymai/folder-delete-e2e.cjs` |
| App-native deletion UI | 06:00 CEST | **PASS** | Branded confirmation/result dialogs and deletion-status handling | Console result from `.polymai/deletion-ui-check.cjs` |
| Cross-engine mobile-host UAT | 05:29 CEST | **PASS 3/3** | Chromium, Firefox and WebKit public/legal/onboarding/vault/recovery/mesh routes; no overflow, page exception or backend error | `.polymai/cross-browser-mobile-results.json` |
| Isolated warm-outage repetitions | 05:48 CEST | **PASS** | Established peers retained access while Supabase traffic was blocked | `.polymai/release-outage-results.json` |
| Static and runtime contracts | 06:03 CEST | **PASS** | App contract, Supabase contract, Anchor survival, public pages, shard lifecycle, Night Node browser check, visual check, JavaScript syntax and evidence JSON | `POLYMAI_CHECKS.cjs` and focused `POLYMAI_*_CHECK.cjs` output |

## Detailed acceptance record

### Identity and recovery

| Test | Result | Observation |
|---|---:|---|
| Anonymous vault creation | PASS | Vault created without name, email or password. A pseudonymous Supabase Auth session was still created for RLS and coordination. |
| Self-certifying Vault ID | PASS | Vault ID matched the owner public-key hash. |
| Mesh Key export and verification | PASS | Correct key verified; altered input was rejected. |
| Fresh-browser restoration | PASS | Restored the same Vault ID with an independent device identity. |
| Uploader-offline restoration | PASS | A clean browser recovered from storage peers after the uploader was closed and stale. |
| Recovery threshold | PASS | 3 of 5 was recoverable; 2 of 5 produced no corrupt download. |

### Storage pipeline

| Test | Result | Observation |
|---|---:|---|
| Ordered upload phases | PASS | Preparing, reading, compressing, encrypting, sharding, sending, publishing and complete were observed. |
| Adaptive compression | PASS | Compressible input saved space; PNG input skipped ineffective compression. |
| Segment boundary | PASS | An 8.65 MiB payload produced two segments; a 100,000,000-byte payload produced 12 segments. |
| Independent placement | PASS | Five-profile runs produced five distinct browser-profile failure domains for each 3+2 group. |
| Exact small recovery | PASS | Downloaded SHA-256 matched the source. |
| Exact multi-segment recovery | PASS | Downloaded SHA-256 matched the source. |
| Exact 100 MB recovery | PASS | Cold recipient reproduced all 100,000,000 bytes and the original SHA-256. |
| Central whole-file check | PASS | Request and schema inspection found no complete readable file stored in Supabase. |

### Mesh, resilience and lifecycle

| Test | Result | Observation |
|---|---:|---|
| Five-profile discovery | PASS | Every profile reported four open direct peers. |
| Five-node profile | PASS | 3 required plus 2 recovery shards. |
| Ten-node profile | PASS | 7 required, repair below 9, target 10. |
| Warm Supabase outage | PASS | Exact recovery continued over four established peers; this does not prove cold-start independence. |
| Repair/rebalance | PASS | Lost placement was replaced and exact recovery remained valid. |
| Signed deletion | PASS | Offline deletion command persisted until the addressed browser returned and acknowledged erasure. |
| Deduplicated deletion | PASS | Deleting one reference did not remove content still referenced by another live file. |
| Anchor pair | PASS | Two enabled Anchors reported Running with one connected Anchor each. |

### Sharing, isolation and UI

| Test | Result | Observation |
|---|---:|---|
| Cold capability recipient | PASS | Identity-less recipient downloaded exact bytes after establishing a pseudonymous coordination session. |
| Capability secrecy | PASS | URL-fragment key was absent from outbound requests. |
| Revocation | PASS | New redemption was rejected after revocation while coordination was reachable. |
| Cross-vault isolation | PASS | Unrelated vault decrypted no foreign names or manifests. |
| Responsive release routes | PASS | No horizontal overflow in the automated mobile viewports. |
| Browser-engine coverage | PASS | Chromium, Firefox and WebKit completed the selected mobile-host UAT. |
| Runtime errors | PASS | Final full run had zero page errors and zero unexpected backend HTTP responses. Deliberately blocked outage requests were excluded. |

## Defects observed, repair and retest

| Defect | Initial observation | Repair | Retest |
|---|---|---|---:|
| Cold share redemption lacked coordination auth | A new recipient reported that the link did not exist or had expired because RLS rejected the capability lookup. | `share-download-flow.js` now creates the required pseudonymous anonymous session on demand before redemption. | PASS, including exact download and revocation |
| Shard recovery was timing-sensitive | One full outage run reached only 2 of 3 required shards even though four peers remained connected. | `fragment-discovery.js` now requests all reachable candidates in parallel, accepts only hash-verified data, records the observed responder and allows a bounded 45-second shard-transfer window. | PASS in the full 26/26 suite and isolated outage repetitions |
| Rapid fresh anonymous sessions hit HTTP 429 | Test automation creating many independent Supabase anonymous accounts exceeded the configured signup rate. | Test profiles shared one pseudonymous coordination session while retaining distinct device keys/failure domains. No production limit was changed. | Functional mesh tests PASS; production burst capacity remains OPEN |
| Branded deletion result could disappear during a rerender | The app-native completion dialog was detached while deletion state refreshed. | The Drive view now retains and repopulates the active result across rerenders until explicit dismissal. | Focused file/folder deletion plus final 26/26 regression PASS |
| Below-threshold recovery appeared to hang | With only 2/5 shards online, serial discovery of several unavailable holders exceeded the UI acceptance window. | Recovery now fetches K known connected holders first, probes remaining candidates concurrently when degraded, and cleans temporary fragments before returning a bounded error. | Golden test PASS: exact 4/5 and 3/5; 2/5 rejected without a download |
| Offline-delete runner was nondeterministic | `page.close()` raced its asynchronous unload cleanup, allowing the “offline” node to acknowledge once. | The runner explicitly awaits `pauseNode()` before closing while preserving the same browser profile for reconnect. | Two follow-up passes; final evidence confirms a pending copy and later erasure |

## Expected/non-product warnings

- The deliberate unauthenticated Edge Function boundary request returned HTTP 401 as expected.
- Network failures generated while Supabase traffic was deliberately blocked are expected outage evidence.
- `POLYMAI_CHECKS.cjs` reports a Stripe repair signal because the shared `polymai-stripe-webhook-router` is present. TheMeshVault has no Stripe configuration, checkout, billing tables or payment capability. No payment code was added and shared infrastructure was not removed.

## Open production acceptance tests

These items are **not executed** and remain required before real-user invitations:

| ID | Required test | Status |
|---|---|---:|
| I01 | Five physical phones including Android Chrome and iPhone Safari across at least two networks | NOT RUN |
| I02 | Sixth clean physical phone restores exact bytes after uploader power-off | NOT RUN |
| I03 | TURN-required recovery across carrier/restrictive NAT | NOT RUN |
| I04 | 90–100 MB transfer on constrained physical phones | NOT RUN |
| I05 | Physical offline holder processes a signed deletion after reconnect | NOT RUN |
| I06 | Screen-lock checks at 15, 30 and 60 minutes, including storage retention and battery impact | NOT RUN |
| I07 | Production anonymous-auth burst test at the intended invitation rate with no HTTP 429 | NOT RUN |
| I08 | Production monitoring for Auth, Realtime, Edge, TURN, repair, transfer and deletion backlog | NOT VERIFIED |
| I09 | Deploy the exact candidate to the intended HTTPS origin and repeat smoke/contracts there | NOT RUN |
| I10 | Final operator/controller details and legal review for Terms and Privacy | NOT COMPLETE |

## Sign-off rule

- If I01–I05 and I07 pass, the release may proceed as a small invite-only beta.
- I06 must be documented honestly in the product because browsers cannot guarantee uninterrupted background execution.
- Any exact-recovery, TURN, storage-retention or signup-capacity failure returns the release to **NO-GO**.
- Unrestricted public launch remains blocked until anonymous abuse controls and bounded coordination quotas are deployed.

## 2026-07-27 — Closed-page browser wake feasibility

This test isolated the browser capability needed by a future automatic node reminder. It did not certify mobile operating-system background survival or add automatic shard transfer to the product.

| Browser | Stored payload | Storage | Result | Cold-start relay time |
|---|---:|---|---:|---:|
| Chrome 150 | 64 KiB | IndexedDB | PASS | 11 ms |
| Chrome 150 | 1 MiB | OPFS | PASS | 16 ms |
| Chrome 150 | 8 MiB | OPFS | PASS | 40 ms |
| Edge 150 | 64 KiB | IndexedDB | PASS | 15 ms |
| Edge 150 | 1 MiB | OPFS | PASS | 28 ms |
| Edge 150 | 8 MiB | OPFS | PASS | 59 ms |
| Brave/Chromium 150 | 64 KiB | IndexedDB | PASS | 15 ms |
| Brave/Chromium 150 | 1 MiB | OPFS | PASS | 37 ms |
| Brave/Chromium 150 | 8 MiB | OPFS | PASS | 98 ms |

For each case the origin page was closed, its worker was explicitly stopped, a synthetic Push API event was delivered through Chromium DevTools Protocol, and the cold-started worker read and relayed the stored payload. The receiving test server's SHA-256 matched the source exactly in all nine cases.

Live production configuration was also checked through an anonymous Supabase session. The deployed Edge Function answered, but reported `vapidPublicKeyConfigured: false` and `setupRequired: true`. Real Web Push is therefore blocked until the VAPID secrets are applied and the Edge Function is reprovisioned.

Remaining boundaries:

- No Android SDK, emulator or physical phone was available, so Android Doze, OEM battery restrictions, FCM delivery latency and iPhone installed-web-app delivery were not tested.
- Synthetic desktop push proves that a service worker can wake without an open tab; it does not prove that a phone will deliver every push promptly.
- The current production worker displays a notification. It does not yet initiate automatic shard replication or transfer in the background.

### Production VAPID provisioning

At 22:25 CEST, one newly generated VAPID key pair was applied directly to project `pfnlebwkbhblytpvaokd` as three protected Edge secrets. No key value was written to the workspace or test log. The app API router was then deployed from the current source.

| Check | Result |
|---|---:|
| All three VAPID secret names present | PASS |
| Authenticated `push-config` returns a valid public key | PASS |
| `setupRequired` cleared | PASS |
| Temporary anonymous node can register a push subscription through the Edge boundary | PASS |
| Protected `node_push_subscriptions` write succeeds through service-role Edge access | PASS |
| Temporary node and cascaded test subscription removed | PASS |

Chrome's automated incognito context correctly rejected Push API registration. That is an expected browser restriction, not a backend failure. A real non-incognito phone or installed-PWA delivery test remains required to prove provider delivery, lock-screen presentation and notification-click reopening.

## 2026-07-28 — Optional reminder and Anchor lifecycle regression

The browser lifecycle test was updated after Node reminders became optional rather than an Anchor prerequisite.

| Scenario | Result |
|---|---:|
| Start Night Node while notification permission is blocked | PASS |
| Renew the 90-second Anchor lease without a push subscription | PASS |
| Reload and retain the active Anchor without reminders | PASS |
| Disable reminders without stopping the Anchor | PASS |
| Remove an existing push subscription and retain the Anchor after reload | PASS |
| Enable, disable and retry a simulated Brave push-service failure independently | PASS |

Reminder readiness contributes a small availability-score bonus. Lease renewal, measured activity and replicated Anchor state remain the source of truth for whether the node is active. This does not change the physical-phone limitation: mobile operating systems can still suspend or terminate a browser.
