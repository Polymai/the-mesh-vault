# TheMeshVault Android background node

Date: 2026-08-14  
Status: debug APK, lint and unit tests pass; signed AAB and physical-device acceptance still required

## Purpose

The Android build uses the live TheMeshVault website for its user interface and adds a native foreground service that can continue opaque-shard storage and mesh-control duties after the WebView is hidden or the screen turns off. Every native node is a bounded control participant. Opt-in Backbone mode increases its control cache and availability role; the native service is not a second cryptographic vault.

## Security boundary

The hosted WebView remains the only vault-authority component in the Android app. It creates or restores the 256-bit root, derives the Ed25519 owner and file keys, encrypts readable files, decrypts recovered files, and signs owner operations.

The bridge sends only:

- protocol version;
- Supabase URL and publishable key;
- app Edge Function URL;
- public Vault ID and node label;
- coarse country/region and optional network-domain hash;
- shard and control-cache limits;
- Backbone enabled state;
- boot-restart preference; and
- public ICE server configuration.

`PolymaiAppBackgroundWorker` rejects configuration whose key names indicate a Mesh Key, mnemonic, root seed, owner/private/file/segment/metadata/deduplication key, recovery phrase or secret. Its status always exposes `keysAccepted: false`. No root-derived secret is persisted in the native store.

The native worker creates a separate random Ed25519 device identity. Its identity seed and Supabase anonymous-session refresh token are encrypted with AES-GCM under an app-specific key held by Android Keystore. This protects those native operational credentials at rest; it does not turn the WebView's IndexedDB root into hardware-backed storage.

## Native storage and transport

- SQLite stores shard indexes, manifests and bounded control-record metadata.
- Private app files store opaque protocol-v3 shard bytes.
- A shard is SHA-256 verified before commit and moved from a pending file to its final content-addressed path.
- Quotas bound shard bytes and the control/manifest cache.
- Native WebRTC uses 32 KiB binary packets, backpressure and the browser protocol's shard, proof, manifest and control messages.
- The native service can store, prove, serve and erase owner-authorized opaque shards. It cannot decrypt them.
- Root-key-dependent segment reconstruction, erasure re-encoding and owner-signed repair publication remain in an authorised foreground vault client.

The current Android native service creates its own anonymous Supabase session and node row, performs bounded discovery, uses recipient Realtime signaling, and requests public TURN configuration from the app Edge Function. Direct WebRTC carries subsequent shard and peer-control traffic. It automatically caches a small set of verified signed/encrypted control objects; Backbone mode raises that responsibility. Unlike the browser client, this native worker does not yet implement the public-key-pinned WSS Backbone seed client, so its first contact still requires Supabase in this release.

The browser/WebView path is mesh-first: it tries known peers, connected control participants, configured public-key-pinned WSS Backbones and invites before opening the delayed Supabase fallback. A reachable WSS Backbone can therefore bootstrap browser control discovery without Supabase. Durable upload metadata, placements, atomic repair and native Android first contact remain Supabase-backed.

## Lifecycle

The user must explicitly press **Run with screen off** on the Backbone page. Android then starts a foreground service and shows a persistent notification. Pressing **Stop background node** records the opt-out and stops the service. If the user left it enabled, the boot receiver may request restart after the device reboots. Transient authentication, network, signaling or Realtime failures keep the service alive in a bounded reconnect loop instead of terminating the process.

A bounded partial Wake Lock is held only while a shard transfer is active and expires after two minutes. The WebView itself is not kept alive. Android Doze, force-stop, battery restrictions, network loss and manufacturer-specific process policies can still delay or terminate work. “Runs with the screen off” is therefore a best-effort foreground-service property, not an availability guarantee.

## Browser, PWA and Android stores

Chrome, Brave, Edge, Safari/PWA and the Android WebView use separate origin storage profiles. The native service uses a third, app-private store. Android cannot silently reuse a browser's IndexedDB or OPFS database.

To move the vault into the Android app:

1. Install the Android app.
2. Restore the same vault in its WebView with the 24-word Mesh Key or complete protocol-v3 key file.
3. Open Backbone and press **Run with screen off**.
4. Wait until the mesh shows verified placements on the new node.
5. Only then pause or clear the old browser node if desired.

The app does not copy local browser shards. Both nodes may coexist, and placement repair decides which encrypted pieces the new native node should receive.

## Release behavior

The production Android shell loads the trusted origin `https://themeshvault.com`. A normal hosted web release therefore updates both the browser and the Android WebView UI without a store release. Native Java, bridge API, Android permission, dependency or foreground-service changes require a new signed APK/AAB and Play release.

Only the exact trusted origin may invoke the native bridge. External pages and untrusted navigations must not receive native node access.

## Required physical-device acceptance

Source and static contract checks do not prove Android runtime behavior. Before public Android release, test at least one current Pixel-class Android device and one restrictive Samsung/Xiaomi-class device:

1. Install the generated signed build and restore a test vault.
2. Start the node and verify the persistent notification.
3. Lock the screen for 30 minutes on Wi-Fi, then on mobile data.
4. Transfer, prove and retrieve a real shard while the screen is off.
5. Verify node heartbeat, peer reconnect and quota after unlock.
6. Reboot and verify restart occurs only when previously enabled.
7. Press Stop and verify it remains stopped after app close and reboot.
8. Force-stop the app and verify the UI does not claim the node is running.
9. Clear Android pieces and verify only the native shard/control store is removed.
10. Inspect Supabase and confirm a separate anonymous native session/node row, with no root, Mesh Key or shard payload; confirm its traffic is sparse after direct peers connect.
11. Run Play policy review for foreground-service purpose, persistent disclosure and battery behavior.

Until these gates pass, the Android source is an implementation candidate and must not be described as physically verified across phone vendors.
