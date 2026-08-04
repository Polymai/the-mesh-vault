# TheMeshVault protocol-v3 golden recovery report

Date: 2026-08-05  
Current result: **NOT YET RUN AGAINST THE PROVISIONED V3 BACKEND**

## Why the previous result is not carried forward

The July 2026 golden run proved exact recovery for the former format on isolated browser profiles: a 25,165,878-byte file with SHA-256 `773b3a29c913164b7f2ec2d7307f691a72513669336a236bb0e324a79e524916` was recovered at 4-of-5 and 3-of-5 availability and correctly rejected at 2-of-5. That historical run used hosted recovery-envelope lookup and therefore does not certify the breaking protocol-v3 design.

Protocol v3 intentionally removes recovery envelopes and wrapped segment keys. A 24-word Mesh Key now derives the owner identity and all vault key roots locally. Existing app data is deliberately removed by the one-time pre-release `local-root-key-v3` schema reset, so the new proof must start with a new v3 vault and new v3 file.

## V3 claim to prove

A clean browser profile with only the valid v3 Mesh Key can derive the original Vault ID, discover a signed v3 manifest, obtain enough encrypted shards from other browser nodes, reconstruct and decrypt every segment, and reproduce the original file byte for byte after the uploader is fully offline.

The proof must also show that:

- no Mesh Key root, owner private key, recovery envelope, wrapped segment key, segment ciphertext or shard bytes are stored in Supabase;
- every accepted segment descriptor and manifest has a valid Ed25519 owner signature and self-certifying Vault ID;
- the recovering browser derives segment keys locally from the Mesh Key and signed segment context;
- the uploader is not a shard source during recovery;
- recovery succeeds at the stored K threshold and fails cleanly below K;
- no partial or unverified download is presented as recovered.

## Required execution sequence

1. Provision the protocol-v3 schema, RLS, Realtime and Edge Function.
2. Create a fresh vault and save its 24-word Mesh Key and complete v3 key file.
3. Connect at least five isolated storage profiles and upload a new 20–100 MB fixture.
4. Record original byte count and SHA-256, signed manifest/descriptor IDs, erasure profile and verified placement domains.
5. Confirm Supabase request/schema evidence contains no file or shard bytes and no recovery/wrapped-key records.
6. Close the uploader and wait until it is no longer active.
7. Restore the same Vault ID in a clean profile using only the Mesh Key.
8. Recover from the other profiles and compare final bytes and SHA-256.
9. Repeat at the minimum K shards and then below K.

## Evidence status

| Evidence | V3 status |
|---|---:|
| Protocol-v3 local Mesh Key portability | Must be rerun in the final integrated build |
| Live v3 Supabase deployment/reset | Pending provisioning |
| Uploader-offline v3 WebRTC recovery | Not run |
| Exact v3 SHA-256 match | Not run |
| V3 threshold success/failure boundary | Not run |
| Physical-phone and carrier/TURN recovery | Not run |

No protocol-v3 golden PASS claim should be published until this report is replaced with measured evidence from the deployed candidate.
