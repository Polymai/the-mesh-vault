# TheMeshVault Golden Recovery Test

Date: 2026-07-23  
Result: **PASS**

## Claim tested

A completely new browser profile, holding only the original vault's Mesh Key phrase, can restore a real file byte for byte from other browser devices after the uploader has gone offline. Recovery must stop honestly when fewer than the required shards are reachable.

## Test setup

- Device 1 created a new anonymous cryptographic vault and retained its Mesh Key phrase.
- Devices 2-5 joined as four clean storage-only browser profiles.
- Every profile had an independent device key, browser-profile failure-domain ID, IndexedDB, OPFS, and memory context.
- A valid 24 MiB BMP with random pixel data was uploaded from device 1.
- The file produced four independently processed 8 MiB-class segments.
- The upload peer set was isolated to devices 1-5 so every segment deterministically used `3+2`.
- Supabase remained available only for anonymous coordination, signaling, encrypted recovery-envelope lookup, signed manifest cache, and fragment-location discovery.

The final run reused one anonymous Supabase auth session across isolated browser contexts after repeated development runs hit the project's anonymous-auth rate limit. This does not share vault keys, device keys, OPFS, IndexedDB, local identity, or failure domains, but it means the run does not test cross-account RLS isolation. That boundary was covered separately by the v0.1 release suite.

## Observed upload evidence

- Original bytes: `25,165,878`
- Original SHA-256: `773b3a29c913164b7f2ec2d7307f691a72513669336a236bb0e324a79e524916`
- Segments: `4`
- Coding profile: `3+2`
- Required shards per segment: `3`
- Total shards per segment: `5`
- Durable placements per segment: `5`
- Independent browser failure domains per segment: `5`
- Local shard inventory after upload: exactly four durable shards on each of devices 1-5
- Observed WebRTC shard pulses: `32`
- Every storage device 2-5 appeared as a real remote DataChannel destination.

## Central-storage check

- Supabase Storage API requests: `0`
- Largest Supabase request body during the measured run: `9,286` bytes
- Signed manifest cache payload: `8,834` bytes
- App schema binary/blob columns: none (`bytea` absent)
- Supabase retained hashes, placements, encrypted metadata/recovery material, and the signed manifest—not file, segment-ciphertext, or shard bytes.

## Uploader-offline recovery

Device 1's browser context was closed completely. The test waited until its last heartbeat was 127 seconds old, beyond the active-node window, before creating device 6.

Device 6:

- started with clean browser storage;
- received only the Mesh Key phrase;
- restored the same Vault ID;
- obtained recovery shards from devices 2-5;
- never received bytes from device 1;
- reconstructed all four segments;
- emitted `Exact recovery verified`;
- downloaded exactly `25,165,878` bytes;
- produced SHA-256 `773b3a29c913164b7f2ec2d7307f691a72513669336a236bb0e324a79e524916`;
- retained zero unplaced temporary shards after recovery.

## Recovery boundary

| Available original shards | Clean recovery profile | Result |
|---:|---|---|
| 4 of 5 | Device 6 | PASS, exact hash |
| 3 of 5 | Device 7 | PASS, exact hash |
| 2 of 5 | Device 8 | Correctly rejected |

At 2 of 5 the application emitted no download and reported:

`Only 2 of 3 required shards are currently reachable.`

No partial or corrupt file was produced.

## Product finding repaired during the test

Cold vault startup previously launched proof, repair, and profile-upgrade work immediately. In a busy mesh, a newly restored device could begin creating a stronger coding generation while the user was still performing the first recovery. This was correct self-healing behavior but caused startup contention and made the original recovery boundary difficult to observe.

The coordinator now waits 15 seconds before its first cycle and can be cancelled cleanly during startup. Normal 15-second recurring repair/profile-upgrade behavior continues after that initial delay.

A single-peer disconnect primitive was also added so stale or unwanted peer sessions can be removed without tearing down every healthy DataChannel.

## Performance observation

- 4-of-5 cold recovery completed in roughly 2.5 minutes after restore began.
- Exact 3-of-5 recovery completed in roughly 5 minutes.
- The minimum-margin path is correct but slow because sequential holder attempts wait through unavailable placement addresses.

Improving holder prioritization and parallel bounded probes is recommended before treating remote large-file recovery speed as production-ready.

## Limits

This proves browser-profile independence, real local WebRTC DataChannels, shard placement, uploader-offline recovery, byte-exact reconstruction, and the 3-of-5 threshold on one Windows computer.

It does not prove:

- TURN-only recovery across restrictive NATs;
- different physical devices, mobile operating systems, or ISPs;
- geographic failure-domain separation;
- Android background survival;
- long-duration churn;
- performance for multi-gigabyte files.

Machine-readable evidence is retained in `.polymai/golden-recovery-results.json`.
