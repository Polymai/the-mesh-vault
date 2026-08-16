# TheMeshVault documentation index

Date: 2026-08-13  
Current product contract: **protocol v3 only**

This index separates current product behavior from engineering history. Protocol-v3 source and the current documents below supersede older descriptions of recovery envelopes, wrapped segment keys, ECDSA/P-256 ownership, six-group recovery phrases and storage formats v1/v2.

## Public product documents

The app renders its current Security & Architecture, Privacy Notice and Terms of Service from `js/content/public-documents.js`. Its detailed, reusable key-custody, upload and recovery visuals live in `js/content/security-process-diagrams.js`. Those pages are the plain-language source for users and cover:

- the 256-bit root encoded as a checksum-valid 24-word Mesh Key;
- deterministic Ed25519 ownership and local, domain-separated key derivation;
- browser- or app-WebView-local root and owner-private key custody;
- the explicit one-file share-link exception;
- encrypted shards on storage peers;
- automatic bounded control participation by every online node, encrypted Patient Zero cold start, stable opt-in Backbones and pseudonymous Supabase fallback data; and
- the difference between restoring vault authority and recovering file bytes from enough reachable shards.

The process diagrams explicitly show the current v3 primitives and boundaries: browser-profile IndexedDB versus temporary browser memory, HKDF-SHA-256 derivation, AES-256-GCM segment protection, Ed25519 manifest signing, SHA-256/HMAC integrity roles, Reed-Solomon redundancy, peer shard storage, encrypted multi-relay Patient Zero rendezvous and the narrower mesh/Backbone/Supabase control plane.

The optional Android wrapper adds a keyless native storage/control service with a foreground-service notification, private app shard storage, a Keystore-protected native device identity, screen-off WebRTC participation and boot restart after explicit opt-in. Its native first-contact path still uses Supabase. `ANDROID_BACKGROUND_NODE.md` is the source of truth for that plane.

`native/backbone-host/README.md` documents the dedicated Node.js Backbone host. It can expose one verified WSS identity, store real opaque shards and run several quota-isolated logical instances across manually selected paths. Instances on one physical machine remain one failure domain, even across several disks. The host never formats or repartitions a disk and rejects aggregate quotas that overcommit a detected physical device.

## Technical architecture

- `ANDROID_BACKGROUND_NODE.md` — native Android bridge, lifecycle, key boundary, storage, migration, update and real-device acceptance contract.

- `DEFENSIVE_PUBLICATION.md` — detailed protocol-v3 architecture and defensive-publication candidate, version 1.5.
- `DEFENSIVE_PUBLICATION.sha256` — exact digest of that publication candidate.
- `ai-manifest.json` — concise machine-readable v3 architecture, data boundaries and release state.
- `data/app.json`, `data/runtime-config.js`, `data/schema.json`, `supabase/schema.sql` and `supabase/policies.sql` — executable product and backend contracts; when prose conflicts with code, these current artifacts and their verification checks control.

## Verification and release evidence

- `RELEASE_TEST_PLAN.md` — required protocol-v3 release gates.
- `RELEASE_TEST_REPORT.md` — current pass/fail boundary after successful v3 provisioning.
- `UAT_TEST_LOG.md` — executed checks and still-pending live journeys.
- `DOCUMENTATION_VERIFICATION_REPORT.md` — claim-by-claim documentation audit.
- `GOLDEN_RECOVERY_TEST_REPORT.md` — required uploader-offline golden proof; currently not yet passed for v3.
- `SCALE_CHAOS_TEST_REPORT.md` — deterministic 1,000-logical-node simulation, not a 1,000-device live test.

## Current release boundary

The Supabase protocol-v3 artifacts are provisioned, Mesh Key portability and selected browser/PWA/peer/Anchor checks pass, and the source contracts align. The candidate is still an alpha and must not be described as production-verified until the fresh v3 uploader-offline recovery, K/K-1 threshold, restrictive-network/TURN, database-concurrency and physical-phone gates are completed or explicitly constrained.

## Historical and operational records

`CHANGELOG.md` is chronological engineering memory. `POLYMAI_PROVISIONING_REPAIR.md` retains a resolved deployment incident for operational traceability. Entries describing earlier protocols remain useful history but are not current runtime claims.
