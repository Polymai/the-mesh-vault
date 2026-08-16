export const keyCustodyProcessDiagram = `<figure class="architecture-process architecture-process--keys" aria-labelledby="key-custody-title">
  <header class="architecture-process__head">
    <div><span>Key custody map</span><h3 id="key-custody-title">Where every secret lives</h3></div>
    <p>The root enters the browser once. Everything else is derived for one purpose.</p>
  </header>
  <div class="key-custody-map">
    <article class="process-node process-node--portable">
      <span class="process-node__zone">Your offline copy</span>
      <strong>24 words or complete v3 key file</strong>
      <p>Contains the same 256-bit root. You choose where to keep it. It is never uploaded automatically.</p>
      <b class="process-badge process-badge--danger">Complete vault authority</b>
    </article>
    <div class="process-connector" aria-hidden="true"><i></i><span>import / export by you</span></div>
    <article class="process-node process-node--browser">
      <span class="process-node__zone">Authorised browser profile</span>
      <strong>Local cryptographic vault</strong>
      <div class="process-storage-layer">
        <b>At rest · app-scoped IndexedDB</b>
        <p>Encoded 256-bit root, separate device identity, encrypted metadata and local protocol state.</p>
      </div>
      <div class="process-storage-layer process-storage-layer--memory">
        <b>While the vault is open · browser memory</b>
        <ul>
          <li>Ed25519 owner private key</li>
          <li>AES-256 metadata key</li>
          <li>HMAC-SHA-256 deduplication key</li>
          <li>HKDF segment root and temporary segment keys</li>
        </ul>
      </div>
      <small>Derived keys are not a server backup and are not hardware-backed. Temporary raw segment-key bytes are cleared on a best-effort basis after use.</small>
    </article>
    <div class="process-connector" aria-hidden="true"><i></i><span>bounded outputs only</span></div>
    <div class="process-output-stack">
      <article class="process-output process-output--control">
        <span>Mesh participants + Backbones; Supabase only for explicit durable features</span><strong>Public and protected control data</strong>
        <p>Public keys, signatures, hashes and signed or encrypted coordination records.</p>
        <b>No root · no owner private key · no shard payload</b>
      </article>
      <article class="process-output process-output--storage">
        <span>Storage peers · OPFS / IndexedDB</span><strong>Encrypted recovery shards</strong>
        <p>Hash-addressed Reed–Solomon shards without the key needed to decrypt the file.</p>
        <b>No readable file · no segment key</b>
      </article>
      <article class="process-output process-output--share">
        <span>Explicit share-link exception</span><strong>One-file encrypted key grant</strong>
        <p>The hosted record is opened by a 256-bit recipient secret kept in the URL fragment.</p>
        <b>Limited to one named file version</b>
      </article>
    </div>
  </div>
  <div class="process-boundary-note"><b>Private boundary</b><span>The root, Mesh Key phrase, owner private key and usable root-level keys remain in the authorised browser profile during normal storage and coordination.</span></div>
  <figcaption>IndexedDB is browser-profile storage, not a secure hardware enclave. Anyone who controls the device profile, app origin or full Mesh Key may obtain vault authority.</figcaption>
</figure>`;

export const coldStartProcessDiagram = `<figure class="architecture-process architecture-process--cold-start" aria-labelledby="cold-start-title">
  <header class="architecture-process__head">
    <div><span>Private cold start</span><h3 id="cold-start-title">A new device finds the mesh without exposing the peer list</h3></div>
    <p>Public relays transport encrypted rendezvous messages; they do not become the directory.</p>
  </header>
  <div class="process-step-grid process-step-grid--recovery">
    <article class="process-step process-step--key"><b>01</b><span>Pin trust</span><strong>Patient Zero public device key</strong><p>The app ships only an Ed25519 public key. Patient Zero keeps its private device key and separate transport secret locally.</p></article>
    <article class="process-step process-step--network"><b>02</b><span>Meet outbound</span><strong>Public WebSocket relays</strong><p>Both devices make ordinary outbound TLS connections, so Patient Zero can remain behind NAT and a firewall.</p></article>
    <article class="process-step process-step--crypto"><b>03</b><span>Ask privately</span><strong>NIP-44 encrypted request</strong><p>The relay sees transport pseudonyms, timing and ciphertext size, but not the peer directory, SDP or node details inside it.</p></article>
    <article class="process-step process-step--manifest"><b>04</b><span>Verify source</span><strong>Ed25519 signed directory</strong><p>The new device accepts a directory only when the pinned Patient Zero device signed it and it has not expired.</p></article>
    <article class="process-step"><b>05</b><span>Verify peers</span><strong>Device-signed presence</strong><p>Each listed node signs its own identity and presence. Patient Zero can select entries, but cannot silently rewrite their claims.</p></article>
    <article class="process-step process-step--network"><b>06</b><span>Leave bootstrap</span><strong>Direct WebRTC + mesh gossip</strong><p>The peers establish normal mesh connections. This deployment does not automatically fall back to Supabase after a timeout; hosted traffic is limited to an explicit feature that still needs a durable transaction.</p></article>
  </div>
  <div class="verification-gate">
    <span><b>Relays can observe</b>IP address, time, transport public key, recipient transport key and ciphertext size.</span>
    <span class="is-failed"><b>Relays do not receive</b>Mesh Key, private device key, readable peer list, SDP, filenames, file keys or shard payloads.</span>
  </div>
  <figcaption>The relays are replaceable transports, not trusted authorities. Availability improves by using several relays; authenticity comes from the pinned Patient Zero public device key and every peer's own signature.</figcaption>
</figure>`;

export const uploadProtectionProcessDiagram = `<figure class="architecture-process architecture-process--upload" aria-labelledby="upload-protection-title">
  <header class="architecture-process__head">
    <div><span>Upload protection path</span><h3 id="upload-protection-title">From readable bytes to verified peer storage</h3></div>
    <p>Only encrypted shards cross the storage network.</p>
  </header>
  <div class="process-zone process-zone--local"><span>Inside your browser</span></div>
  <div class="process-step-grid process-step-grid--eight">
    <article class="process-step"><b>01</b><span>Stream</span><strong>File.stream()</strong><p>Up to 100 MB now. Read at most 8 MiB into the working buffer; never load the whole file at once.</p></article>
    <article class="process-step"><b>02</b><span>Fingerprint</span><strong>SHA-256 + HMAC-SHA-256</strong><p>Hash original bytes and make a vault-private deduplication token before compression.</p></article>
    <article class="process-step"><b>03</b><span>Compress</span><strong>gzip when useful</strong><p>Keep gzip only when it saves at least 5%; skip formats that are already compressed.</p></article>
    <article class="process-step process-step--key"><b>04</b><span>Derive key</span><strong>HKDF-SHA-256 → 256 bits</strong><p>Bind the key to protocol, Vault ID, segment ID, generations, format and private token.</p></article>
    <article class="process-step process-step--crypto"><b>05</b><span>Encrypt + authenticate</span><strong>AES-256-GCM</strong><p>Fresh random 96-bit nonce, authenticated context and a 128-bit authentication tag.</p></article>
    <article class="process-step process-step--coding"><b>06</b><span>Create redundancy</span><strong>Reed–Solomon K+R</strong><p>Turn the ciphertext into data and recovery shards. Any valid K rebuild the ciphertext.</p></article>
    <article class="process-step process-step--network"><b>07</b><span>Transfer + prove</span><strong>SHA-256 · WebRTC</strong><p>Send 32 KiB packets in parallel. Reassemble, hash-check and acknowledge each shard.</p></article>
    <article class="process-step process-step--manifest"><b>08</b><span>Publish map</span><strong>Ed25519 signed manifest</strong><p>Record sizes, hashes, coding generation and verified placements without storing shard bytes centrally.</p></article>
  </div>
  <div class="process-destination-row">
    <span><b>Browser storage nodes</b>Encrypted shard payloads in OPFS or IndexedDB</span>
    <span><b>Mesh control plane</b>Signed or encrypted metadata, hashes and placements; explicit durable transactions may also use Supabase</span>
  </div>
  <div class="crypto-role-legend" aria-label="Cryptographic role legend">
    <span><i class="is-encryption"></i><b>AES-256-GCM</b> encrypts and authenticates</span>
    <span><i class="is-signature"></i><b>Ed25519</b> proves the vault owner signed it</span>
    <span><i class="is-integrity"></i><b>SHA-256 / HMAC</b> verify or privately match bytes</span>
    <span><i class="is-coding"></i><b>Reed–Solomon</b> adds recoverability, not secrecy</span>
  </div>
  <figcaption>Compression happens before encryption because encrypted bytes should look random and will not compress effectively. Erasure coding happens after encryption so every storage node receives only protected bytes.</figcaption>
</figure>`;

export const recoveryVerificationProcessDiagram = `<figure class="architecture-process architecture-process--recovery" aria-labelledby="recovery-verification-title">
  <header class="architecture-process__head">
    <div><span>Recovery verification path</span><h3 id="recovery-verification-title">Every layer must verify before a file is released</h3></div>
    <p>Missing or altered evidence stops the download.</p>
  </header>
  <div class="process-step-grid process-step-grid--recovery">
    <article class="process-step"><b>01</b><span>Trust the map</span><strong>Verify Ed25519 manifest</strong><p>Check its content address, owner public key, self-certifying Vault ID and protocol-v3 structure.</p></article>
    <article class="process-step process-step--network"><b>02</b><span>Collect</span><strong>Fetch any K valid shards</strong><p>Ask reachable holders in parallel and reject every shard whose SHA-256 does not match.</p></article>
    <article class="process-step process-step--coding"><b>03</b><span>Rebuild ciphertext</span><strong>Reed–Solomon decode</strong><p>Reconstruct the original encrypted segment length, then verify its signed ciphertext hash.</p></article>
    <article class="process-step process-step--key"><b>04</b><span>Recreate key</span><strong>HKDF-SHA-256</strong><p>Derive the same AES-256 key locally from the Mesh Key root and authenticated segment context.</p></article>
    <article class="process-step process-step--crypto"><b>05</b><span>Open safely</span><strong>AES-256-GCM verify + decrypt</strong><p>The 128-bit tag and authenticated data must pass before plaintext is accepted.</p></article>
    <article class="process-step"><b>06</b><span>Restore bytes</span><strong>gunzip when marked</strong><p>Restore the original segment size and compare its SHA-256 with encrypted private metadata.</p></article>
    <article class="process-step process-step--manifest"><b>07</b><span>Complete file</span><strong>Streaming whole-file SHA-256</strong><p>Write segments in order and compare final size and hash with the signed manifest.</p></article>
  </div>
  <div class="verification-gate">
    <span><b>All checks pass</b>Exact recovery verified · release the completed file</span>
    <span class="is-failed"><b>Any check fails</b>Stop · discard the unverified result · show an error</span>
  </div>
  <figcaption>The Mesh Key restores authority and derives keys; it does not replace missing shards. Every segment still needs at least K valid, reachable pieces.</figcaption>
</figure>`;

export const nativeBackgroundProcessDiagram = `<figure class="architecture-process architecture-process--native" aria-labelledby="native-background-title">
  <header class="architecture-process__head">
    <div><span>Optional Android execution</span><h3 id="native-background-title">The vault UI and the background node have different authority</h3></div>
    <p>The foreground service keeps the storage connection available without receiving the Mesh Key.</p>
  </header>
  <div class="process-step-grid process-step-grid--native">
    <article class="process-step process-step--key"><b>01</b><span>Vault UI</span><strong>Keys stay in the authorised WebView</strong><p>You restore the vault in the app UI. Encryption, decryption and owner signing continue in the protocol-v3 JavaScript vault.</p></article>
    <article class="process-step"><b>02</b><span>Narrow bridge</span><strong>Public configuration only</strong><p>The bridge sends Vault ID, public Supabase configuration, node label, coarse location, quotas and role settings. Secret-looking fields are rejected.</p></article>
    <article class="process-step process-step--network"><b>03</b><span>Native node</span><strong>Foreground service + WebRTC</strong><p>A separate native device identity signs node activity. The service stores and serves opaque shards, caches verified control records and can keep running with the screen off.</p></article>
    <article class="process-step process-step--manifest"><b>04</b><span>Android protection</span><strong>Private app storage + Keystore</strong><p>Shard bytes stay in the app sandbox. The native device seed and anonymous Supabase refresh token are encrypted with an Android Keystore key.</p></article>
  </div>
  <div class="verification-gate">
    <span><b>Native worker can receive</b>Encrypted shards, public identifiers, signatures, hashes, manifests, placements and bounded encrypted or signed control records.</span>
    <span class="is-failed"><b>Native worker rejects</b>Mesh Key words, root seed, owner private key, metadata keys, deduplication keys and segment decryption keys.</span>
  </div>
  <figcaption>Starting the node is an explicit user action and Android shows a persistent foreground-service notification. Android and phone-vendor power policies can still delay or stop network work, so this improves screen-off availability without promising an immortal process.</figcaption>
</figure>`;
