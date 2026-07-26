# TheMeshVault v0.1 Release Test Report

Date: 2026-07-24  
Environment: provisioned Supabase project, local production-like origin at `http://127.0.0.1:3007`, isolated browser profiles on one Windows host.

## Decision

**CONDITIONAL GO for a small, invite-only pilot after the physical-phone gate below passes.**

**NO-GO for an unrestricted public launch.** The automated and desktop-host UAT release gates now pass, but this environment cannot prove mobile background survival, real carrier/NAT traversal, browser storage eviction behavior, or production anonymous-auth capacity. Those are core risks for a phone-first storage product and must not be inferred from desktop emulation.

The pilot should remain deliberately small, carry beta durability language, and avoid promising that a browser will stay online after its screen locks. A failed item in the physical-phone gate changes the decision back to NO-GO.

## Executed release evidence

| Area | Result | Evidence |
|---|---|---|
| Full release regression | PASS | 26/26 scenarios, zero P0/P1 failures, zero page exceptions and zero unexpected backend responses. |
| Static app/Supabase contracts | PASS | Registry, runtime paths, schema, RLS, RPCs, Realtime, Edge Function, public pages, Anchor survival, visual and shard-lifecycle checks. |
| Anonymous identity and Mesh Key | PASS | Account-free creation, self-certifying Vault ID, stable reload, encrypted recovery envelope, phrase verification and clean-profile restore. |
| Five-browser WebRTC mesh | PASS | Five distinct device keys and browser-profile failure domains; every profile reported four direct peers. |
| File pipeline | PASS | Reading, adaptive compression, authenticated encryption, erasure coding, transfer, verification and publication were observed in order. |
| Compression and segmentation | PASS | Beneficial compression was used; PNG compression was skipped; an 8.65 MiB payload produced two independently protected segments. |
| Exact recovery | PASS | Small, multi-segment and shared downloads reproduced the original SHA-256 byte for byte. |
| Uploader-offline recovery | PASS | A clean Mesh-Key-only browser recovered a real 24 MiB file after the uploader was fully offline; 4/5 and 3/5 succeeded and 2/5 was correctly rejected. |
| 100 MB release boundary | PASS | A random 100,000,000-byte file produced 12 segments and 60 verified placements across five profiles; a cold recipient recovered the exact SHA-256. |
| Ten-node profile | PASS | A real upload selected K=7, repair threshold=9 and N=10 (a 7+3 profile), then persisted ten placements on ten node IDs/failure domains. |
| Supabase outage | PASS | With Supabase requests blocked, four established peers remained connected and exact recovery completed; coordination then reconnected. This is warm-mesh survival, not cold-start independence. |
| Sharing and revocation | PASS | A cold recipient recovered exact bytes; the URL-fragment capability key was absent from network requests; revocation was enforced while coordination was reachable. |
| Cross-vault isolation | PASS | An unrelated anonymous vault could see only encrypted/locked coordination rows and decrypted zero file names. |
| Repair/rebalance | PASS | Clearing a holder queued repair, created a verified replacement placement and preserved the exact recovered hash. |
| Deletion lifecycle | PASS | Owner-signed deletion, app-native confirmation, recursive folder deletion, capability revocation and dedup-safe removal passed. |
| Offline delete/reconnect | PASS | One shard holder went offline, the signed erase order remained pending, the same browser profile returned, erased its shard and acknowledged finalization. |
| Anchor lifecycle | PASS | Two Anchors reported Running and one connected Anchor each with measured state. |
| Chromium/Firefox/WebKit mobile layouts | PASS | Public pages, legal routes, terms gate, local vault creation, recovery and mesh views passed without overflow or page/backend errors. These were desktop-host engines, not physical phones. |

Machine-readable evidence:

- `.polymai/release-results.json`
- `.polymai/release-boundary-results.json`
- `.polymai/golden-recovery-results.json`
- `.polymai/release-ten-node-results.json`
- `.polymai/release-repair-results.json`
- `.polymai/offline-delete-reconnect-results.json`
- `.polymai/cross-browser-mobile-results.json`

## Defects repaired during this UAT

- Cold share recipients now establish the required pseudonymous Supabase session before the RLS-protected capability lookup. No named account, email or password is created.
- Shard recovery no longer queries unavailable holders serially. It first retrieves the minimum K shards from connected manifest holders, probes remaining candidates concurrently only when degraded, hash-verifies every result and removes temporary fragments. This preserved fast healthy recovery and made the below-threshold error bounded instead of appearing to hang.
- The branded deletion-result dialog now survives application rerenders until the user closes it, and signaling checks an Anchor/Night Node lease before attempting an RLS-protected insert.
- The offline-deletion runner now explicitly pauses the test node before closing its page. Browsers do not await asynchronous `beforeunload` work, so the old runner could race a final WebRTC erase request and incorrectly report that the supposedly offline node had acknowledged.
- The release runners were aligned with the current Terms gate, Anchor route/status, app-native dialogs, 100 MB boundary and task-level failure reporting.

## What is and is not proven

Proven here:

- The whole readable file is not stored in Supabase Storage.
- Exact reconstruction works from independently stored encrypted shards.
- A warm, already-connected mesh can recover a file during a simulated Supabase outage.
- Phrase-only cold restore normally uses Supabase to locate the encrypted recovery envelope; a recovery JSON file carries that encrypted envelope itself.
- “No account required” means no named account is requested. Supabase still creates a pseudonymous anonymous-auth session and processes coordination metadata.

Not proven on this Windows host:

- Real Android Chrome and iPhone Safari storage persistence, screen-lock/background behavior, memory pressure and OS eviction.
- TURN-only connectivity across restrictive NAT/firewalls and separate mobile carriers.
- Real geographic, ISP and physical-device failure-domain diversity.
- Slow or interrupted 100 MB transfers on constrained phones.
- Optional email account confirmation/link/unlink with a dedicated production account.
- Days-long churn, lease renewal, repair and battery consumption.
- Production load, anonymous-signup rate limits and abuse resistance.

## Known launch risks

- Rapid fresh-session test creation reached Supabase anonymous-signup rate limiting. Production limits, monitoring and an expected-user ceiling must be configured before invitations are sent.
- Server-side anonymous abuse controls, proof-of-work and bounded coordination quotas are not yet implemented. This blocks unrestricted publication.
- No production hosting target or `.openai/hosting.json` is configured in this workspace, so the tests certify the source and provisioned backend but not a deployed production origin.
- Terms and Privacy are still marked as pre-release drafts and retain unresolved operator/controller, contact, retention and jurisdiction details. Legal/operator sign-off is required before public publication.
- Mobile browsers may suspend or evict a tab even with Wake Lock/persistent-storage requests. Night Node improves visibility and recovery but cannot override the OS.
- Capability revocation prevents future coordinated redemption; it cannot force a recipient to erase bytes already downloaded.
- Anchors help an already-connected mesh retain signed/encrypted control records, but do not yet replace Supabase for every cold start, metadata write or phrase-only recovery.
- The Polymai aggregate checker reports Stripe repair because it detects the platform-shared `polymai-stripe-webhook-router`. TheMeshVault has no payment capability, Stripe configuration, checkout flow or billing table; adding payment code or deleting shared infrastructure would be an incorrect repair.

## Physical-phone production gate

Complete this on the intended HTTPS production origin before inviting real users:

1. Use at least five physical phones: Android Chrome and iPhone Safari represented, with at least two networks (Wi-Fi plus a separate mobile carrier).
2. Create one anonymous vault, save the Mesh Key file and phrase offline, and confirm the Vault ID remains stable after browser restart.
3. Join four independent storage phones and verify five distinct nodes, direct connections and a 3+2 placement for every segment.
4. Upload one incompressible 90–100 MB file. Record its external SHA-256, confirm 12 segments for a 100,000,000-byte payload, and inspect real placement/device counts.
5. Turn the uploader fully off. Restore on a sixth clean phone using only the Mesh Key and verify the downloaded SHA-256 exactly matches.
6. Repeat recovery after one additional shard holder is offline; verify failure is clear when fewer than K holders remain.
7. Exercise a cross-network/TURN path by separating devices across carrier and Wi-Fi networks. A direct-LAN-only pass is insufficient.
8. Share a file to a clean phone, verify exact download, revoke the link, and confirm a new redemption is denied.
9. Delete a file while one holder is offline; reopen the same browser profile and verify its pending encrypted shard is erased and the order finalizes.
10. Lock Android and iPhone screens for 15, 30 and 60 minutes. Record actual node/lease state, reconnect behavior, storage retention, transfer recovery and battery impact without claiming continuous uptime.
11. Create fresh anonymous sessions at the expected launch burst rate and confirm no 429s, runaway retries or exhausted Supabase quotas.
12. Re-run `node POLYMAI_CHECKS.cjs` against the exact deployed source and confirm all app/Supabase checks still pass.

## Pilot operating rules

- Invite-only, small cohort, visible beta label and no irreplaceable-only-copy recommendation.
- Start with a documented user ceiling below verified Supabase auth/realtime limits.
- Monitor anonymous auth 429s, Edge errors, Realtime connections, TURN usage, repair backlog, failed transfers and deletion backlog.
- Stop new invitations if exact recovery, TURN traversal, signup capacity, or browser-storage retention fails.
- Keep the current 100 MB per-file limit until constrained-phone memory and slow-network testing passes.
