export const LEGAL_VERSIONS = Object.freeze({
  terms: "2026-07-24.3-draft",
  privacy: "2026-07-24.3-draft",
});

const architecture = {
  id: "security",
  kind: "Technical reference",
  title: "Security & Architecture",
  summary: "What happens after you choose a file: which device sees which bytes, how the pieces are rebuilt, which limits are enforced, and where the current system still depends on Supabase.",
  version: "Storage protocol v2",
  updated: "24 July 2026",
  status: "Current implementation",
  sections: [
    {
      id: "overview",
      title: "What TheMeshVault actually stores",
      body: `<p>TheMeshVault stores a file by spreading encrypted pieces across other participating devices. The whole readable file is not copied to every device and is not uploaded to Supabase Storage. Your browser is the machine that cuts, encrypts, distributes and later rebuilds it.</p>
      <aside class="architecture-units"><strong>What does MiB mean?</strong><p><b>MB</b> is the familiar decimal unit: 1 MB is 1,000,000 bytes. <b>MiB</b> is the exact binary unit used by computers: 1 MiB is 1,048,576 bytes. The current processing block is 8 MiB, which is 8,388,608 bytes or about 8.4 MB. The rest of this page uses ordinary MB for readability and gives exact binary values only where they matter.</p></aside>
      <figure class="architecture-figure architecture-figure--pipeline" aria-labelledby="file-pipeline-title">
        <div class="architecture-figure__head"><div><span>Upload data flow</span><strong id="file-pipeline-title">One file, processed in bounded stages</strong></div><em>All sensitive processing happens in your browser</em></div>
        <div class="pipeline-diagram">
          <article><b>01</b><span>Read</span><strong>About 8 MB at a time</strong><small>The exact block is 8 MiB. The final block is usually smaller.</small></article>
          <article><b>02</b><span>Reduce</span><strong>Compress if useful</strong><small>gzip is kept only when it saves at least 5%. Already-compressed formats are skipped.</small></article>
          <article><b>03</b><span>Protect</span><strong>Encrypt separately</strong><small>Each segment gets a fresh AES-GCM key and nonce before it leaves the browser.</small></article>
          <article><b>04</b><span>Make recoverable</span><strong>Create shards</strong><small>The encrypted segment becomes K data shards plus R recovery shards.</small></article>
          <article><b>05</b><span>Distribute</span><strong>Verify devices</strong><small>Shards are hash-checked and placed across separate eligible browser devices.</small></article>
        </div>
        <div class="architecture-layers" aria-label="Storage and transport layers">
          <span><b>File layer</b>Any total size</span><i aria-hidden="true">→</i>
          <span><b>Segment layer</b>About 8 MB each</span><i aria-hidden="true">→</i>
          <span><b>Shard layer</b>Smaller coded pieces</span><i aria-hidden="true">→</i>
          <span><b>Transport layer</b>32 KiB WebRTC packets</span>
        </div>
        <figcaption>An 8 MiB segment is a local processing unit, not an 8 MiB object placed on another device. Erasure coding divides it into smaller shards, and transport divides each shard again into small network packets.</figcaption>
      </figure>
      <p>The system does not call a file recoverable merely because a manifest exists. Recovery status is calculated from observed, hash-verified shard placements on independent failure domains and the minimum shard count required by the active coding profile.</p>`,
    },
    {
      id: "example",
      title: "Follow one 20 MB video",
      body: `<p>Assume you upload a 20 MB video while eight independent storage devices are available. This is what the browser actually does:</p>
      <div class="architecture-example">
        <article><b>1</b><div><strong>Read the first block</strong><p>Only about 8 MB is worked on. The remaining file stays unread in the original file stream.</p></div></article>
        <article><b>2</b><div><strong>Skip pointless compression</strong><p>Video is already compressed, so the bytes are kept as they are. A text file would be compressed only if at least 5% is saved.</p></div></article>
        <article><b>3</b><div><strong>Encrypt that block</strong><p>The browser creates a new random key and nonce. From this point onward the block is unreadable without the vault-controlled key.</p></div></article>
        <article><b>4</b><div><strong>Turn it into eight pieces</strong><p>With a 6+2 profile, the encrypted block becomes eight shards of roughly 1.4 MB each. Any six can rebuild the block.</p></div></article>
        <article><b>5</b><div><strong>Send and verify</strong><p>Each shard is sent to a different eligible device where possible. The receiving browser confirms the shard hash before placement counts.</p></div></article>
        <article><b>6</b><div><strong>Release memory and repeat</strong><p>The browser discards temporary buffers, then processes the next block. A 20 MB file needs three block passes, not one 20 MB memory buffer.</p></div></article>
      </div>
      <p>After all three block groups are placed, Supabase may hold the signed map: which hashes exist, which devices reported them and how many are required. It does not hold the 20 MB video. To restore the file, a browser with the Mesh Key retrieves any six valid shards from <em>each</em> group, reverses the process and checks the final file hash.</p>
      <div class="architecture-glossary" aria-label="TheMeshVault terms in plain language">
        <span><b>Segment</b>A temporary working block of the original file.</span>
        <span><b>Shard</b>One encrypted recovery piece created from a segment.</span>
        <span><b>Node</b>A participating browser or app that stores and serves shards.</span>
        <span><b>Manifest</b>The signed map describing how to verify and rebuild the file.</span>
        <span><b>Mesh Key</b>The recovery authority that lets an owner regain access to the vault.</span>
        <span><b>6+2</b>Six shards required, plus two extra shards that may be missing.</span>
      </div>`,
    },
    {
      id: "file-path",
      title: "What happens to a file",
      body: `<ol>
        <li><strong>Streaming read.</strong> The browser reads the file in fixed logical segments of exactly 8 MiB at most instead of loading the whole file into memory. A 20 MB file is handled in three passes. The current 100 MB maximum is handled in twelve passes. Total file size therefore does not determine the size of the working buffer.</li>
        <li><strong>Adaptive compression.</strong> Formats that are commonly compressed already are skipped. Other segments use gzip only when the result is at least 5% smaller.</li>
        <li><strong>Independent encryption.</strong> Every selected representation is encrypted with AES-GCM using a new random 256-bit segment key, a unique nonce and authenticated context. The segment key is wrapped by the vault key; private segment metadata is encrypted separately.</li>
        <li><strong>Erasure coding.</strong> Each encrypted segment is independently encoded into K data shards and R recovery shards. Any K valid shards from that coding group can reconstruct the encrypted segment. The profile adapts to the number of independent placement candidates and the selected resilience class.</li>
        <li><strong>Verified placement.</strong> Shards are transferred as 32 KiB WebRTC DataChannel packets, reassembled, hashed and acknowledged. Placement prefers distinct browser/device failure domains and considers capacity, reliability, throughput, latency and coarse geographic diversity.</li>
        <li><strong>Signed manifest.</strong> A content-addressed manifest records hashes, sizes, coding parameters and verified locations. The vault owner signs it before publication.</li>
      </ol>
      <figure class="architecture-figure architecture-figure--shards" aria-labelledby="shard-model-title">
        <div class="architecture-figure__head"><div><span>Segment and shard model</span><strong id="shard-model-title">Why an 8 MiB segment does not mean an 8 MiB shard</strong></div><em>Illustrated with the normal 6+2 profile</em></div>
        <div class="shard-transform">
          <div class="shard-source"><span>Logical segment</span><strong>≤ 8 MiB</strong><small>Compression may make the encrypted representation smaller before coding.</small></div>
          <div class="shard-transform__arrow" aria-hidden="true"><span>6+2</span><i>→</i></div>
          <div class="shard-group" aria-label="Six data shards and two recovery shards">
            <div class="shard shard--data"><b>D1</b><span>data</span></div><div class="shard shard--data"><b>D2</b><span>data</span></div>
            <div class="shard shard--data"><b>D3</b><span>data</span></div><div class="shard shard--data"><b>D4</b><span>data</span></div>
            <div class="shard shard--data"><b>D5</b><span>data</span></div><div class="shard shard--data"><b>D6</b><span>data</span></div>
            <div class="shard shard--recovery"><b>R1</b><span>recovery</span></div><div class="shard shard--recovery"><b>R2</b><span>recovery</span></div>
          </div>
        </div>
        <div class="shard-rule"><strong>6 of 8</strong><span>Any six verified shards can reconstruct this segment. Each shard is approximately one sixth of the encrypted representation, plus small coding and encryption overhead.</span></div>
        <figcaption>Every segment has its own coding group. A large file therefore produces several independent groups of shards, rather than one enormous whole-file shard set.</figcaption>
      </figure>
      <div class="architecture-profile-grid" aria-label="Current erasure coding profiles">
        <article><span>Five devices</span><strong>3+2</strong><small>Five shards total · any three recover · approximately 67% redundancy.</small></article>
        <article><span>Small mesh</span><strong>4+2</strong><small>Six shards total · any four recover · 50% redundancy.</small></article>
        <article class="is-emphasized"><span>Normal mesh</span><strong>6+2</strong><small>Eight shards total · any six recover · approximately 33% redundancy.</small></article>
        <article><span>Ten devices</span><strong>7+3</strong><small>Ten shards total · any seven recover · approximately 43% redundancy.</small></article>
        <article><span>Sixteen devices</span><strong>12+4</strong><small>Sixteen shards total · any twelve recover · approximately 33% redundancy.</small></article>
        <article><span>High resilience</span><strong>10+6</strong><small>Sixteen shards total · any ten recover · 60% redundancy.</small></article>
      </div>
      <p><strong>K+R notation:</strong> K is the number of shards required for recovery; R is the additional recovery capacity. For example, 6+2 creates eight shards and survives any two missing shards in that segment group, provided the remaining six are valid and reachable. A profile applies per segment and can be upgraded later when enough independent nodes are available.</p>
      <p>The 8 MiB target is a deliberate browser trade-off. Smaller segments would create more database rows, hashes, encryption operations, manifests and transfer acknowledgements; much larger segments would increase temporary memory and repair cost. The current limit keeps memory bounded while leaving shards small enough for practical peer placement.</p>`,
    },
    {
      id: "operating-limits",
      title: "Current limits",
      body: `<p>These are the limits enforced by the current browser release. They are product boundaries, not promises about what every network or phone can achieve.</p>
      <div class="architecture-limit-grid">
        <article><span>Upload</span><strong>100 MB per file</strong><p>Exactly 100,000,000 bytes. Larger files are rejected before encryption starts. Multiple selected files are processed one at a time.</p></article>
        <article><span>File types</span><strong>No extension restriction</strong><p>Any file type may be encrypted. Already-compressed formats such as JPEG, PNG, MP4, PDF and ZIP skip gzip.</p></article>
        <article><span>Total vault</span><strong>No fixed account quota</strong><p>Usable storage is limited by the capacity currently offered by reachable mesh devices, not by a simulated cloud allowance.</p></article>
        <article><span>This browser contributes</span><strong>0 to 10 GiB</strong><p>The default is 1 GiB. The selected cap applies only to encrypted shards stored for the mesh in this browser.</p></article>
        <article><span>Processing block</span><strong>8 MiB maximum</strong><p>8,388,608 bytes per segment. Network transport then splits shards into 32 KiB packets.</p></article>
        <article><span>Recovery pieces</span><strong>16 shards maximum</strong><p>The largest current coding groups are 12+4 balanced and 10+6 extra-resilience.</p></article>
        <article><span>Share links</span><strong>24 hours by default</strong><p>Links created by the current Drive interface expire after one day and can be revoked sooner by deleting the file.</p></article>
        <article><span>Long operation</span><strong>6-hour timeout</strong><p>An individual upload or recovery task is cancelled if it cannot finish within six hours.</p></article>
        <article><span>Anchor cache</span><strong>25 MiB to 1 GiB</strong><p>100 MiB by default, used for signed or encrypted control records rather than readable file content.</p></article>
      </div>
      <details class="architecture-timers"><summary>Network maintenance timings</summary><p>A node is treated as stale after two minutes without a report. Storage proofs are considered fresh for 30 minutes. A missing placement receives a 30-minute repair grace period, and returning surplus copies receive a five-minute reconciliation grace period. Night Node leases last 90 seconds and renew every 30 seconds while the browser remains able to run.</p></details>`,
    },
    {
      id: "data-locations",
      title: "Where data is stored",
      body: `<figure class="architecture-figure architecture-figure--network" aria-labelledby="network-flow-title">
        <div class="architecture-figure__head"><div><span>Network architecture</span><strong id="network-flow-title">File bytes and coordination data take different paths</strong></div><em>Solid lines carry encrypted file material; dashed lines carry control data</em></div>
        <div class="network-diagram">
          <article class="network-node network-node--owner"><span>Owner browser</span><strong>Cryptographic authority</strong><small>Readable bytes, the Mesh Key phrase, private owner keys and unwrapped segment keys remain on an authorised endpoint.</small></article>
          <div class="network-route network-route--shards"><span>Encrypted shards</span><i aria-hidden="true">→</i><small>Direct WebRTC where possible</small></div>
          <article class="network-node network-node--peers"><span>Independent storage devices</span><strong>Store hash-addressed shards</strong><small>No readable file and no segment decryption key.</small></article>
          <div class="network-route network-route--control"><span>Signed / encrypted metadata</span><i aria-hidden="true">⇢</i><small>Discovery, signaling and placement</small></div>
          <article class="network-node network-node--coordination"><span>Supabase backbone</span><strong>Current operational control plane</strong><small>Anonymous sessions, metadata writes, discovery, signaling, placement, repair and encrypted caches. It is not the file-content store.</small></article>
          <div class="network-route network-route--relay"><span>Fallback relay</span><i aria-hidden="true">↝</i><small>Encrypted WebRTC traffic only</small></div>
          <article class="network-node network-node--turn"><span>TURN, when needed</span><strong>Relays an encrypted connection</strong><small>Can observe endpoints and traffic volume, but does not receive vault keys.</small></article>
        </div>
        <div class="architecture-boundary"><span><b>Never sent to Supabase or storage peers</b>Readable file bytes · Mesh Key phrase · private owner key · unwrapped segment keys</span><span><b>May leave the browser</b>Encrypted shards · public keys · hashes · signed/encrypted manifests · placement and connection metadata</span></div>
        <figcaption>Supabase is the normal fast path today. Anchors can replicate bounded signed or encrypted control records for an already-connected mesh, but they do not yet replace Supabase for cold-start discovery or every metadata write.</figcaption>
      </figure>
      <div class="document-table-wrap"><table><thead><tr><th>Location</th><th>What can be there</th><th>What is not intended to be there</th></tr></thead><tbody>
        <tr><td>Your browser</td><td>Vault and device keys, the Mesh Key phrase, encrypted metadata, manifests, operation log, settings, and any encrypted shards this browser stores. Shards use OPFS when available with IndexedDB metadata/fallback.</td><td>The application does not send the Mesh Key phrase, private owner key, unwrapped segment keys or readable file bytes to Supabase or storage nodes.</td></tr>
        <tr><td>Other browser nodes</td><td>Content-addressed encrypted shards, signed deletion orders, and bounded signed control objects when Anchor mode is enabled.</td><td>They should not receive the original plaintext file or the key needed to decrypt it.</td></tr>
        <tr><td>Supabase backbone</td><td>Pseudonymous anonymous-session identifiers, vault and device public keys, encrypted file/folder metadata, file sizes, coding records, shard hashes and placements, node capacity/status/location, short-lived signaling, transfer/repair/deletion state, signed/encrypted manifests, encrypted recovery envelopes, capability records and audit events.</td><td>The Mesh Key phrase, private owner key, unwrapped segment keys and full readable file are not stored there. This app does not use Supabase Storage for file content.</td></tr>
        <tr><td>TURN relay, when required</td><td>Encrypted WebRTC traffic and connection metadata while relaying a peer connection.</td><td>The relay is not given the vault's decryption key.</td></tr>
        <tr><td>Share link</td><td>The server-side record identifies an encrypted capability. The URL fragment carries the recipient secret and is not sent in a normal HTTP request.</td><td>A share link should never be treated as harmless: anyone who receives the complete link may be able to access the shared file until it expires or is revoked.</td></tr>
      </tbody></table></div>`,
    },
    {
      id: "supabase-backbone",
      title: "Supabase backbone today",
      body: `<p>Supabase is not the cryptographic owner of a vault, but it is operationally important in the current release. The browser normally creates a Supabase Auth user marked as anonymous after you choose to create, restore or contribute. You do not provide a name, email address or password for that session, but it is still a stable pseudonymous technical account used for Row Level Security and coordination.</p>
      <figure class="architecture-figure architecture-figure--backbone" aria-labelledby="backbone-title">
        <div class="architecture-figure__head"><div><span>Trust and availability</span><strong id="backbone-title">Ownership stays local; coordination has a fast path and a limited fallback</strong></div><em>These are different responsibilities</em></div>
        <div class="backbone-grid">
          <article class="backbone-card backbone-card--authority"><span>Local authority</span><strong>Your authorised browser</strong><ul><li>Creates and holds the Mesh Key phrase</li><li>Holds private owner and vault keys</li><li>Encrypts, signs, decrypts and verifies</li><li>Decides which signed operation is valid</li></ul><b>Supabase cannot replace this authority.</b></article>
          <article class="backbone-card backbone-card--fast"><span>Normal fast path</span><strong>Supabase backbone</strong><ul><li>Anonymous Auth session and RLS access</li><li>Vault and node registration</li><li>Presence, discovery and WebRTC signaling</li><li>File/segment/shard metadata and placements</li><li>Transfer, repair, deletion and audit state</li><li>Encrypted manifest and recovery caches</li></ul><b>Operationally important today.</b></article>
          <article class="backbone-card backbone-card--fallback"><span>Outage fallback</span><strong>Connected Anchors and peers</strong><ul><li>Replicate bounded signed control records</li><li>Relay signals within the known mesh</li><li>Serve cached manifests and locations</li><li>Keep established peer paths useful</li></ul><b>Not yet a complete cold-start replacement.</b></article>
        </div>
        <div class="backbone-outage"><span><b>Supabase available</b>Normal discovery, writes and maintenance use the backbone.</span><span><b>Supabase unavailable</b>A locally stored vault still opens; cached or already-connected paths may continue.</span><span><b>Current hard limits</b>Phrase-only cold recovery, new uploads, cold peer discovery and coordinated repair/deletion normally require Supabase.</span></div>
        <figcaption>“No account required” means no named user account is requested. It does not mean no server-side session or network metadata exists. The current anonymous Supabase session, stable vault/device identifiers and related activity are pseudonymous rather than guaranteed anonymous.</figcaption>
      </figure>
      <div class="document-table-wrap"><table><thead><tr><th>Supabase capability</th><th>Why the current app uses it</th><th>Data involved</th></tr></thead><tbody>
        <tr><td>Auth and RLS</td><td>Issue a pseudonymous session and scope database access without requiring email registration.</td><td>Anonymous Auth user/session identifier, tokens in the browser, request and security logs.</td></tr>
        <tr><td>Database and Realtime</td><td>Coordinate vault registration, nodes, live presence, file/segment/shard records, placements, transfers, repair, rebalancing, deletion, sharing and network measurements.</td><td>Public keys, encrypted metadata, sizes, hashes, status, coarse location and operational timestamps.</td></tr>
        <tr><td>Recovery cache</td><td>Let a new browser find the encrypted recovery envelope when only the Mesh Key phrase is entered.</td><td>A deterministic lookup hash, vault ID, random salt, nonce and ciphertext. The phrase and decrypted private material are not sent.</td></tr>
        <tr><td>Realtime signaling</td><td>Introduce browser nodes so they can establish direct WebRTC DataChannels.</td><td>Short-lived offers, answers, ICE candidates, sender/recipient node IDs and expiry timestamps.</td></tr>
        <tr><td>Edge Function</td><td>Return ICE/TURN configuration, coarse placement hints, optional account operations and protected push-wake actions.</td><td>Session token, requested action, coarse network hints and signed action payloads where applicable.</td></tr>
      </tbody></table></div>
      <p><strong>What Supabase does not receive as application data:</strong> the Mesh Key phrase, plaintext owner private key, unwrapped segment keys or the complete readable file. Encrypted recovery data and encrypted manifests are useful only after client-side key derivation and verification.</p>`,
    },
    {
      id: "identity",
      title: "Identity and control",
      body: `<p>A new vault creates a signing keypair, master key and Mesh Key phrase in the browser. The vault ID is derived from the owner's public key. Sensitive operations are signed, and clients verify signatures and hashes instead of trusting a coordination database row merely because it exists.</p>
      <p>The phrase itself is not uploaded. The current app derives a high-entropy lookup hash and an encryption key from it, then stores an encrypted recovery envelope in Supabase and connected Anchor caches. A new browser with only the phrase normally uses Supabase to locate that envelope; a matching recovery JSON file already contains the envelope and can restore the local identity without that lookup.</p>
      <p>An optional email account can be linked for convenience, but it does not replace cryptographic ownership. Losing every trusted copy of the Mesh Key can make the vault permanently inaccessible. Restoring the identity does not by itself guarantee file recovery: the browser must still find each signed manifest and at least K valid reachable shards for every segment.</p>`,
    },
    {
      id: "network-metadata",
      title: "Network and location metadata",
      body: `<p>Peer discovery and WebRTC require operational metadata. Participating nodes may expose a node identifier, device public key, user-chosen label, capacity, used bytes, online/lease state and measured connection quality. The app can record coarse country or region and a salted network-domain hash to improve failure-domain separation.</p>
      <p>Direct WebRTC peers can learn network-address information needed to establish the connection. A TURN provider can observe connection endpoints, timing and encrypted traffic volume when it relays traffic. TheMeshVault does not claim network anonymity.</p>`,
    },
    {
      id: "recovery",
      title: "Recovery, repair and verification",
      body: `<p>Download discovers a signed manifest, retrieves enough verified shards for each segment, reconstructs the encrypted representation, decrypts and decompresses locally, and calculates the whole-file SHA-256 hash incrementally. “Exact recovery verified” is shown only after that hash matches the signed manifest.</p>
      <figure class="architecture-figure architecture-figure--recovery" aria-labelledby="recovery-flow-title">
        <div class="architecture-figure__head"><div><span>Download data flow</span><strong id="recovery-flow-title">Recovery reverses the pipeline and verifies the result</strong></div><em>The original uploader does not need to be online</em></div>
        <div class="recovery-flow">
          <span><b>1</b><strong>Verify manifest</strong><small>Check owner signature and content hash.</small></span><i aria-hidden="true">→</i>
          <span><b>2</b><strong>Fetch any K shards</strong><small>Reject bytes that fail their shard hash.</small></span><i aria-hidden="true">→</i>
          <span><b>3</b><strong>Reconstruct segment</strong><small>Rebuild the exact encrypted representation.</small></span><i aria-hidden="true">→</i>
          <span><b>4</b><strong>Decrypt and expand</strong><small>Authenticate, decrypt and decompress locally.</small></span><i aria-hidden="true">→</i>
          <span><b>5</b><strong>Verify whole file</strong><small>Compare incremental SHA-256 with the signed original hash.</small></span>
        </div>
        <figcaption>Recovery succeeds only when every segment group has at least K valid reachable shards. One healthy segment cannot compensate for another segment that is below its recovery threshold.</figcaption>
      </figure>
      <p>When placements become unavailable, the repair coordinator can recreate missing shards from a recoverable segment and place replacements on eligible nodes. Returning surplus copies are reconciled after a grace period; they do not increase the logical erasure profile.</p>`,
    },
    {
      id: "deletion",
      title: "Deletion",
      body: `<p>Deleting a file revokes known share capabilities, tombstones the vault record and creates owner-signed deletion orders for known shard holders. Connected nodes can erase immediately. An offline node cannot receive an instruction until it reconnects, so an unreadable encrypted shard may remain on that device in the meantime.</p>
      <p>Hiding a cleanup row removes it from that browser's interface only. It does not cancel the signed deletion order. Deduplicated segments that are still referenced by another version are retained until no live reference remains.</p>`,
    },
    {
      id: "limits",
      title: "Threat model and limits",
      body: `<ul>
        <li>The design protects file confidentiality from ordinary storage nodes that possess only encrypted shards.</li>
        <li>Authenticated encryption, hashes and signatures are used to detect altered file material and forged manifests.</li>
        <li>Erasure coding protects availability only when enough verified independent devices actually hold the required shards.</li>
        <li>A compromised endpoint with an unlocked vault can read files available to that endpoint. Cryptography cannot protect plaintext while an authorised device is using it.</li>
        <li>Browser storage can be cleared by the user, browser or operating system. Mobile browsers may suspend or terminate background tabs despite Wake Lock, PWA, sync or push assistance.</li>
        <li>Traffic analysis, IP-address privacy, malicious browser extensions, operating-system compromise and loss of every Mesh Key copy are outside the protection offered by shard encryption.</li>
        <li>This is an early implementation. Independent security review and wider hostile-network testing remain necessary before describing it as suitable for high-risk or regulated data.</li>
      </ul>`,
    },
  ],
};

const terms = {
  id: "terms",
  kind: "Legal",
  title: "Terms of Service",
  summary: "The participation rules for creating a no-account vault, contributing device storage, handling keys, and using a peer-powered service with a hosted Supabase backbone.",
  version: LEGAL_VERSIONS.terms,
  updated: "24 July 2026",
  status: "Pre-release draft",
  sections: [
    {
      id: "agreement",
      title: "1. Agreement and current project status",
      body: `<p>These Terms govern participation in the current TheMeshVault development network. By creating a vault or operating a storage node, you agree to the version shown at the top of this document and instruct the software to exchange encrypted material and the minimum protocol data needed to operate the mesh.</p>
      <p>The current build is a pre-release project and is not represented as being operated by an incorporated company. In these Terms, <strong>project maintainer</strong> means the person or people maintaining the software and the currently configured hosted coordination layer. A future production release must replace this paragraph with the legal operator's identity and contact details.</p>`,
    },
    {
      id: "service",
      title: "2. The service",
      body: `<p>TheMeshVault is a no-account, cryptographically owned peer-to-peer storage protocol and application. It encrypts files locally, distributes recovery shards across participating devices, and currently uses Supabase as an operational backbone for pseudonymous sessions, discovery, signaling, metadata, placement, repair and deletion coordination. Supabase is not intended to hold readable file contents, the Mesh Key phrase or plaintext private keys.</p>
      <p>It is not a guaranteed backup service. Recoverability depends on current verified shard placement, participating devices, network access, compatible software and possession of the required Mesh Key or sharing capability. A warm, already-connected mesh may continue during a coordination outage, but complete cold-start independence from the hosted coordination layer is not yet promised.</p>`,
    },
    {
      id: "eligibility",
      title: "3. Eligibility",
      body: `<p>You must have legal capacity to accept these Terms. A final minimum age and any country restrictions must be established before public release. If you use the service for an organisation, you represent that you are authorised to bind that organisation.</p>`,
    },
    {
      id: "keys",
      title: "4. Vault ownership and Mesh Keys",
      body: `<p>Your cryptographic key controls a no-account vault. You are responsible for saving the Mesh Key securely, protecting devices that can open the vault and revoking devices you no longer trust. We may be unable to reset, recover or replace a lost Mesh Key. An optional linked account or anonymous Supabase session does not become the cryptographic owner of a vault.</p>`,
    },
    {
      id: "content",
      title: "5. Your files",
      body: `<p>You retain your rights in files you store. By using the protocol, you instruct your browser, participating peer devices and the configured coordination infrastructure to perform only the operations needed for the features you request: create and retain encrypted representations, coordinate shard placement, relay encrypted traffic, maintain signed or encrypted metadata, repair resilience and carry out deletion or sharing instructions.</p>
      <p>You must have the right to store and share your content. Do not use the service for unlawful material, exploitation, malware distribution, unauthorised surveillance, infringement, harassment, or content whose storage or transfer violates applicable law.</p>`,
    },
    {
      id: "contribution",
      title: "6. Contributing storage",
      body: `<p>If you run a storage, Night or Anchor node, you offer capacity directly to the peer network and authorise the protocol to use up to the contribution limit you select for encrypted shards and bounded control data. You can pause the node or clear its local storage. Availability, battery use, data use and browser storage behaviour depend on your device and network.</p>
      <p>Storage nodes are participating network devices, not custodians of readable files. Contributing capacity does not transfer ownership of another participant's content to you and does not grant permission to inspect, manipulate, publish or deliberately retain material outside the protocol.</p>`,
    },
    {
      id: "availability",
      title: "7. Availability and recovery",
      body: `<p>Nodes can disconnect, storage can be cleared and browsers can be suspended. Capacity, performance, resilience labels and recovery times may change. You should keep independent backups of important files, particularly while a file is pending or below its target resilience.</p>`,
    },
    {
      id: "deletion-sharing",
      title: "8. Deletion and sharing",
      body: `<p>Deletion removes the file from your visible vault, revokes known share links and sends signed erase orders to known holders. Offline nodes process those orders when they reconnect; immediate physical erasure from an unreachable device cannot be guaranteed.</p>
      <p>Anyone with a complete active share link may be able to retrieve the shared file. You are responsible for recipients, optional passwords and expiry choices.</p>`,
    },
    {
      id: "suspension",
      title: "9. Abuse and suspension",
      body: `<p>The project maintainer or a future operator may restrict access to infrastructure under its control, revoke abusive hosted-coordination sessions or suspend features where reasonably necessary to protect participants, infrastructure, legal compliance or network integrity. This does not create control over independent peer devices. Because vault ownership is cryptographic, restricting coordination does not promise that every peer-held encrypted object can be remotely destroyed.</p>`,
    },
    {
      id: "third-parties",
      title: "10. Third-party services",
      body: `<p>The current build uses Supabase Auth, Postgres, Realtime and an Edge Function as the hosted operational backbone. The browser automatically creates a Supabase user marked as anonymous when coordination is needed; this requires no email or password but still creates a pseudonymous technical session. The app also depends on browser and operating-system vendors, internet providers, public STUN services, optional TURN relay and optional push delivery. Public pages currently load fonts from Google Fonts and the Supabase browser library from jsDelivr. These services may receive ordinary connection metadata and have their own terms and availability limits.</p>
      <p>Before production launch, the responsible operator must publish the final provider list and contractual roles. The peer network itself should not be described as centrally operated merely because Supabase is currently used for bootstrap and coordination.</p>`,
    },
    {
      id: "warranty",
      title: "11. Warranties and liability",
      body: `<p>This development build is experimental and is provided for testing without a production service-level commitment. Keep an independent copy of important files. Do not rely on this preview as the only storage for irreplaceable, safety-critical, regulated or legally mandated material.</p>
      <p>The future operator must insert jurisdiction-appropriate warranty language, mandatory consumer protections and liability limits. Nothing in the final Terms may exclude rights that applicable law does not allow to be excluded.</p>`,
    },
    {
      id: "changes",
      title: "12. Changes and contact",
      body: `<p>Material changes receive a new version and may require renewed acceptance in each browser. Before production launch, the final document must identify the responsible legal operator, governing law, dispute procedures, operator address and an accessible support contact.</p>`,
    },
  ],
};

const privacy = {
  id: "privacy",
  kind: "Legal",
  title: "Privacy Notice",
  summary: "How a no-account vault works without asking who you are, which pseudonymous technical data is still processed, and exactly what Supabase and participating peers can see.",
  version: LEGAL_VERSIONS.privacy,
  updated: "24 July 2026",
  status: "Pre-release draft",
  sections: [
    {
      id: "controller",
      title: "1. Scope and development status",
      body: `<p>This notice covers TheMeshVault's public site, browser-local vault, peer-to-peer transfers, storage-node participation, current Supabase coordination and optional account linking.</p>
      <p><strong>Current production controller:</strong> Not yet designated; this is a development build.<br><strong>Future coordination-layer controller:</strong> Company or other responsible legal person to be supplied before production launch.<br><strong>Privacy contact:</strong> To be supplied before production launch.</p>
      <p>The future operator is expected to determine the purposes and means of the hosted coordination layer and to name Supabase and other contracted infrastructure providers in their correct roles. The legal role of independent peer participants depends on the actual processing and applicable law; this notice does not label every storage node as a processor of a central operator.</p>`,
    },
    {
      id: "anonymous-first",
      title: "2. What no-account access means",
      body: `<p>You can create and use a new vault without supplying a name, email address, telephone number, password or conventional user account. The cryptographic vault identity is generated locally. File contents are encrypted before distribution, and ordinary storage nodes are not given the key required to read them.</p>
      <p>When hosted coordination is used, the browser still creates a Supabase Auth user marked as anonymous. That technical user, the stable vault/device identifiers, IP-address information and related activity can distinguish the same browser or vault over time. TheMeshVault therefore promises <strong>no named account required</strong>, not legal or network anonymity. These records are described conservatively as pseudonymous technical data and may remain personal data under applicable law.</p>`,
    },
    {
      id: "local-data",
      title: "3. Data kept in your browser",
      body: `<p>The app can store vault and device key material, recovery state, settings, encrypted names and metadata, signed manifests, operation logs, cached control objects and encrypted shards in app-scoped browser storage. OPFS is preferred for shard bytes, with IndexedDB used for metadata and fallback storage.</p>
      <p>This data may remain until you delete it, clear site data, remove the browser profile or the browser/operating system evicts it. The application does not send the Mesh Key phrase, readable file contents, plaintext owner private key or unwrapped segment keys to Supabase or storage nodes. It does send a lookup hash derived from the phrase and an encrypted recovery envelope containing protected key material so phrase-only recovery can work on a new browser.</p>`,
    },
    {
      id: "mesh-data",
      title: "4. What other mesh devices receive",
      body: `<p>A storage node receives content-addressed encrypted shards, hashes needed to verify them and limited protocol information required to store, retrieve, repair or delete those shards. Connected peers can also see node and device identifiers, connection timing, requested shard hashes, transfer sizes, capacity claims, verification results and coarse failure-domain information.</p>
      <p>An ordinary storage node should not receive your name, email address, Mesh Key, readable filename or complete plaintext file. Encrypted shard bytes may nevertheless originate from a file that contains personal information; encryption makes that information unintelligible to a node that lacks the key.</p>`,
    },
    {
      id: "coordination-data",
      title: "5. What hosted coordination processes",
      body: `<p>The current Supabase backbone can process an anonymous Auth user/session identifier; vault and device public keys; encrypted file and folder metadata; file sizes and coding parameters; segment and shard hashes; placement and recovery status; node labels; coarse country/region; salted network-domain hashes; capacity, usage, lease, uptime and reliability measurements; short-lived connection signals; transfers; repair jobs; encrypted manifests and recovery envelopes; signed operation metadata; deletion progress; share-capability records; and security or audit events.</p>
      <p>These records do not directly state who you are, but stable identifiers and related activity can single out the same vault or device. They are therefore described as <strong>pseudonymous technical data</strong>, not promised to be irreversibly anonymous.</p>
      <p>Supabase is currently used to make the service function, not merely for optional analytics: new uploads, metadata writes, cold peer discovery, phrase-only recovery lookup, signaling and coordinated repair/deletion normally depend on it. The application does not use Supabase Storage as a central bucket for complete file contents.</p>
      <p>If you voluntarily link an account, the supplied email address and provider account identifier become identifiable account data. Account linking remains optional and does not replace cryptographic vault ownership.</p>`,
    },
    {
      id: "network-data",
      title: "6. IP addresses, location and external connections",
      body: `<p>WebRTC peers exchange connection-negotiation data and may learn the IP-address information needed to establish a direct connection. Public STUN services help determine network reachability. A TURN provider can observe connection endpoints, timestamps and encrypted traffic volume when it relays traffic. Supabase and normal web infrastructure can also receive IP address, user-agent and request timing in ordinary server logs.</p>
      <p>Approximate country location may be derived locally after browser location permission or from an edge/network hint. The storage schema is designed for coarse country or region and does not intend to retain precise coordinates.</p>
      <p>The current public pages request fonts from Google Fonts and the Supabase browser library from jsDelivr. The current WebRTC configuration can contact Google and Cloudflare STUN services. A production deployment should reassess or self-host these dependencies where practical and name the final providers in this notice.</p>`,
    },
    {
      id: "purposes",
      title: "7. Why the data is used",
      body: `<div class="document-table-wrap"><table><thead><tr><th>Purpose</th><th>Typical data</th><th>Expected legal basis</th></tr></thead><tbody>
        <tr><td>Provide the vault and mesh</td><td>Anonymous Supabase session, keys' public parts, encrypted metadata, manifests, placements, signaling, transfers and recovery state</td><td>Performance of the service contract</td></tr>
        <tr><td>Keep the network reliable and secure</td><td>Lease, capacity, reliability, repair, deletion and audit events</td><td>Contract and legitimate interests in security and integrity</td></tr>
        <tr><td>Optional account features</td><td>Email address, account identifier and preferences</td><td>Contract; consent only for genuinely optional communications where required</td></tr>
        <tr><td>Meet legal obligations</td><td>Records required by applicable law</td><td>Legal obligation</td></tr>
      </tbody></table></div>
      <p>This table records the intended production model. The future controller must validate each legal basis before launch. Acknowledging this Privacy Notice is not blanket consent to marketing, analytics or unrelated processing.</p>`,
    },
    {
      id: "recipients",
      title: "8. Recipients and roles",
      body: `<p>Depending on the feature used, limited data can be received by participating peer devices, Supabase as the current hosted coordination provider, public STUN or configured TURN providers, hosting and CDN providers, browser and operating-system vendors, optional push-delivery services, and authorities where disclosure is legally required.</p>
      <p>Participating peers receive encrypted shard material and protocol metadata as independent network participants. The production notice must identify the future controller, its contracted processors and subprocessors, processing locations, retention commitments and safeguards for any transfers outside the EU/EEA.</p>`,
    },
    {
      id: "retention",
      title: "9. Retention and deletion",
      body: `<p>Short-lived signaling records expire automatically. Presence and renewable lease information changes as devices report. Browser-local data remains under the browser profile's storage lifecycle. Other coordination records, encrypted manifests, recovery envelopes, audit events and optional account links currently follow the service's operational and database lifecycle; the future controller must publish exact retention periods before production launch.</p>
      <p>A file deletion queues signed erase orders. Connected copies can be removed promptly, while an offline browser may retain an unreadable encrypted shard until it reconnects or its local site data is cleared. Some operational records may be retained where necessary for security, dispute handling or legal compliance.</p>`,
    },
    {
      id: "rights",
      title: "10. Your choices and rights",
      body: `<p>Depending on the applicable law and legal basis, you may have rights to information, access, correction, deletion, restriction, portability, objection, withdrawal of consent and complaint to a supervisory authority.</p>
      <p>You can use the core vault without linking an account, deny optional browser location permission, stop contributing capacity, revoke share links, delete files and clear this browser's site data. Some actions cannot reach an offline independent node until it reconnects.</p>
      <p>A no-account vault may contain no name, email address or conventional account identifier even though Supabase holds a pseudonymous Auth identifier and protocol records. A valid vault or device signature may therefore be needed to locate records safely and prevent disclosure or modification at another person's request. The future controller must provide a working rights-request channel before production launch.</p>`,
    },
    {
      id: "security",
      title: "11. Security and limits",
      body: `<p>The service uses authenticated encryption, content hashes, signed manifests and operations, app-scoped browser storage and row-level database controls. The coordination database is treated as an untrusted cache for sensitive protocol claims; clients are expected to verify signatures and hashes.</p>
      <p>No technical measure eliminates all risk, and TheMeshVault does not claim network anonymity. Keep the Mesh Key offline, protect authorised devices, avoid exposing complete share links and keep independent copies of important files during the pre-release stage.</p>`,
    },
    {
      id: "children-changes",
      title: "12. Children, changes and contact",
      body: `<p>The target age and any parental-consent process must be set before release. The service should not knowingly process a child's data on a consent basis without the safeguards required in the child's country.</p>
      <p>Material changes receive a new version date and may require a new acknowledgement. Before production launch, this section must name the responsible company or other legal person, its privacy contact and the competent supervisory authority. Users in Sweden can contact Integritetsskyddsmyndigheten (IMY) about data-protection concerns.</p>`,
    },
  ],
};

export const PUBLIC_DOCUMENTS = Object.freeze({
  security: architecture,
  terms,
  privacy,
});

export function getPublicDocument(id) {
  return PUBLIC_DOCUMENTS[id] || null;
}
