export const LEGAL_VERSIONS = Object.freeze({
  terms: "2026-07-26.4-draft",
  privacy: "2026-07-27.1-draft",
});

const securityKeyFlowDiagram = `<svg viewBox="0 0 1240 760" role="img" aria-labelledby="security-key-flow-svg-title security-key-flow-svg-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="security-key-flow-svg-title">Protocol v3 key, coordination and file-shard boundaries</title>
  <desc id="security-key-flow-svg-desc">A 256-bit browser-generated root becomes a 24-word BIP39 Mesh Key and deterministically derives the Ed25519 owner identity, metadata key, deduplication key and segment-key root. Root and private keys stay in the browser profile. Supabase and Anchors receive only public keys and signed or encrypted coordination objects. Storage peers receive encrypted shards. Explicit share links expose only an encrypted, file-version-limited segment-key grant.</desc>
  <defs>
    <linearGradient id="flow-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#071424"/><stop offset="1" stop-color="#101b34"/></linearGradient>
    <linearGradient id="flow-local" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#102f4c"/><stop offset="1" stop-color="#10243d"/></linearGradient>
    <linearGradient id="flow-control" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2052"/><stop offset="1" stop-color="#1b2548"/></linearGradient>
    <linearGradient id="flow-storage" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#123d3a"/><stop offset="1" stop-color="#12302f"/></linearGradient>
    <marker id="flow-arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#7dd3fc"/></marker>
    <marker id="flow-arrow-green" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#6ee7b7"/></marker>
    <marker id="flow-arrow-amber" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#fbbf24"/></marker>
  </defs>
  <rect width="1240" height="760" rx="28" fill="url(#flow-bg)"/>
  <g font-family="Inter, ui-sans-serif, system-ui, sans-serif">
    <rect x="28" y="28" width="520" height="704" rx="22" fill="url(#flow-local)" stroke="#38bdf8" stroke-width="2"/>
    <text x="58" y="70" fill="#bae6fd" font-size="15" font-weight="700" letter-spacing="1.4">TRUSTED BROWSER PROFILE</text>
    <text x="58" y="101" fill="#f8fafc" font-size="25" font-weight="750">Local cryptographic authority</text>
    <rect x="58" y="127" width="208" height="88" rx="14" fill="#082f49" stroke="#38bdf8"/>
    <text x="78" y="158" fill="#7dd3fc" font-size="13" font-weight="700">CREATE ONCE</text>
    <text x="78" y="184" fill="#f8fafc" font-size="18" font-weight="700">256-bit root seed</text>
    <text x="78" y="203" fill="#cbd5e1" font-size="12">crypto.getRandomValues()</text>
    <path d="M266 171 H306" stroke="#7dd3fc" stroke-width="2.5" marker-end="url(#flow-arrow)"/>
    <rect x="316" y="127" width="202" height="88" rx="14" fill="#082f49" stroke="#38bdf8"/>
    <text x="336" y="158" fill="#7dd3fc" font-size="13" font-weight="700">PORTABLE RECOVERY</text>
    <text x="336" y="184" fill="#f8fafc" font-size="18" font-weight="700">24-word BIP39</text>
    <text x="336" y="203" fill="#cbd5e1" font-size="12">same root + checksum</text>
    <text x="58" y="252" fill="#bae6fd" font-size="14" font-weight="700">DOMAIN-SEPARATED DETERMINISTIC DERIVATIONS</text>
    <rect x="58" y="272" width="460" height="66" rx="12" fill="#0b2339" stroke="#285879"/>
    <circle cx="82" cy="305" r="8" fill="#38bdf8"/><text x="102" y="301" fill="#f8fafc" font-size="15" font-weight="700">Ed25519 owner key</text><text x="102" y="322" fill="#cbd5e1" font-size="12">Vault ID = SHA-256(raw public key)</text>
    <rect x="58" y="350" width="460" height="66" rx="12" fill="#0b2339" stroke="#285879"/>
    <circle cx="82" cy="383" r="8" fill="#a78bfa"/><text x="102" y="379" fill="#f8fafc" font-size="15" font-weight="700">Metadata AES-256 key</text><text x="102" y="400" fill="#cbd5e1" font-size="12">encrypts private names and control metadata</text>
    <rect x="58" y="428" width="460" height="66" rx="12" fill="#0b2339" stroke="#285879"/>
    <circle cx="82" cy="461" r="8" fill="#fbbf24"/><text x="102" y="457" fill="#f8fafc" font-size="15" font-weight="700">Deduplication HMAC key</text><text x="102" y="478" fill="#cbd5e1" font-size="12">vault-private equality tokens</text>
    <rect x="58" y="506" width="460" height="66" rx="12" fill="#0b2339" stroke="#285879"/>
    <circle cx="82" cy="539" r="8" fill="#6ee7b7"/><text x="102" y="535" fill="#f8fafc" font-size="15" font-weight="700">Segment HKDF root</text><text x="102" y="556" fill="#cbd5e1" font-size="12">one AES-256 key per authenticated segment context</text>
    <rect x="58" y="604" width="460" height="94" rx="15" fill="#171f33" stroke="#f87171" stroke-width="1.5"/>
    <text x="80" y="635" fill="#fca5a5" font-size="14" font-weight="800">LOCAL SECRET BOUNDARY</text>
    <text x="80" y="660" fill="#f8fafc" font-size="14">Root seed and owner private key are never transmitted.</text>
    <text x="80" y="683" fill="#cbd5e1" font-size="12">XSS, extensions or local profile access can still read them.</text>

    <rect x="692" y="28" width="520" height="230" rx="22" fill="url(#flow-control)" stroke="#a78bfa" stroke-width="2"/>
    <text x="722" y="69" fill="#ddd6fe" font-size="15" font-weight="700" letter-spacing="1.4">COORDINATION BOUNDARY</text>
    <text x="722" y="100" fill="#f8fafc" font-size="23" font-weight="750">Supabase + Anchor control caches</text>
    <rect x="722" y="122" width="456" height="50" rx="12" fill="#211b43" stroke="#6d5aac"/>
    <text x="744" y="153" fill="#f8fafc" font-size="14" font-weight="650">Public keys · signed/encrypted coordination objects</text>
    <rect x="722" y="185" width="456" height="44" rx="12" fill="#291d35" stroke="#fb7185"/>
    <text x="744" y="212" fill="#fecdd3" font-size="13" font-weight="700">NO root/private keys · NO usable segment keys · NO shard payloads</text>
    <path d="M548 142 C614 142 624 142 682 142" fill="none" stroke="#7dd3fc" stroke-width="2.5" stroke-dasharray="8 7" marker-end="url(#flow-arrow)"/>
    <text x="568" y="125" fill="#bae6fd" font-size="12" font-weight="700">verify + coordinate</text>

    <rect x="692" y="286" width="520" height="202" rx="22" fill="url(#flow-storage)" stroke="#34d399" stroke-width="2"/>
    <text x="722" y="327" fill="#a7f3d0" font-size="15" font-weight="700" letter-spacing="1.4">STORAGE PLANE</text>
    <text x="722" y="358" fill="#f8fafc" font-size="23" font-weight="750">Independent storage peers</text>
    <rect x="722" y="380" width="456" height="50" rx="12" fill="#0c2d2b" stroke="#2d7465"/>
    <text x="744" y="411" fill="#f8fafc" font-size="14" font-weight="650">Hash-addressed encrypted Reed-Solomon shards</text>
    <text x="722" y="458" fill="#a7f3d0" font-size="13">Peers cannot decrypt a shard or reconstruct alone.</text>
    <path d="M548 434 C614 434 624 390 682 390" fill="none" stroke="#6ee7b7" stroke-width="2.5" marker-end="url(#flow-arrow-green)"/>
    <text x="568" y="407" fill="#a7f3d0" font-size="12" font-weight="700">cipher shards only</text>

    <rect x="692" y="516" width="520" height="216" rx="22" fill="#332612" stroke="#fbbf24" stroke-width="2"/>
    <text x="722" y="557" fill="#fde68a" font-size="15" font-weight="700" letter-spacing="1.4">EXPLICIT SHARE LINK</text>
    <text x="722" y="588" fill="#f8fafc" font-size="23" font-weight="750">Bounded capability, not vault authority</text>
    <rect x="722" y="610" width="456" height="48" rx="12" fill="#2b2112" stroke="#8f6a1c"/>
    <text x="744" y="640" fill="#f8fafc" font-size="14" font-weight="650">Encrypted grant: one file version + named segment keys</text>
    <text x="722" y="685" fill="#fde68a" font-size="13">The URL fragment holds the recipient secret; expiry and revocation apply.</text>
    <path d="M548 548 C614 548 624 620 682 620" fill="none" stroke="#fbbf24" stroke-width="2.5" marker-end="url(#flow-arrow-amber)"/>
    <text x="565" y="594" fill="#fde68a" font-size="12" font-weight="700">explicit grant only</text>
  </g>
</svg>`;

const simpleArchitectureInfographic = `<figure class="architecture-simple" aria-labelledby="architecture-simple-title">
  <header class="architecture-simple__head">
    <span>TheMeshVault in one picture</span>
    <h3 id="architecture-simple-title">Save files. Share spare space. The mesh does both.</h3>
  </header>
  <div class="architecture-simple__flow" aria-label="How a file moves through TheMeshVault">
    <article>
      <b>1</b>
      <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 6h14l8 8v28H14z"/><path d="M28 6v9h8M19 24h12M19 30h12"/></svg>
      <strong>Pick a file</strong>
      <small>Your browser reads it on your device.</small>
    </article>
    <i aria-hidden="true">→</i>
    <article>
      <b>2</b>
      <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="11" y="21" width="26" height="20" rx="5"/><path d="M17 21v-6a7 7 0 0 1 14 0v6M24 29v5"/></svg>
      <strong>Lock it</strong>
      <small>It becomes encrypted pieces.</small>
    </article>
    <i aria-hidden="true">→</i>
    <article>
      <b>3</b>
      <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="18" y="5" width="12" height="14" rx="3"/><rect x="4" y="29" width="12" height="14" rx="3"/><rect x="32" y="29" width="12" height="14" rx="3"/><path d="M24 19v6M10 29v-4h28v4"/></svg>
      <strong>Spread the pieces</strong>
      <small>Different devices hold different pieces.</small>
    </article>
    <i aria-hidden="true">→</i>
    <article>
      <b>4</b>
      <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="18" cy="22" r="9"/><path d="m25 28 15 14M31 34l4-4M35 38l4-4"/></svg>
      <strong>Get it back</strong>
      <small>Your Mesh Key opens the vault. Enough valid pieces rebuild the exact file.</small>
    </article>
  </div>
  <div class="architecture-simple__coordinator">
    <span aria-hidden="true">↔</span>
    <p><strong>Connected Anchors help devices find each other; Supabase provides first contact and fallback.</strong> The readable file is not stored in Supabase Storage.</p>
  </div>
  <section class="architecture-simple__share" aria-labelledby="architecture-share-title">
    <div class="architecture-simple__phone" aria-hidden="true">
      <span>Your phone</span>
      <div class="architecture-simple__phone-screen">
        <i class="is-personal">Photos &amp; apps</i>
        <i class="is-shared">Shared limit</i>
      </div>
      <small>Only the amount you choose</small>
    </div>
    <div>
      <span class="architecture-simple__eyebrow">Share spare phone space</span>
      <h4 id="architecture-share-title">Your phone becomes one small part of the mesh.</h4>
      <ul>
        <li><b>Set a maximum.</b> The app stays inside that limit.</li>
        <li><b>Your own photos and apps stay untouched.</b></li>
        <li><b>The shared space holds unreadable encrypted pieces</b>, not complete readable files.</li>
        <li><b>Pause whenever you want.</b> Pausing stops new pieces; clearing the app's storage removes the pieces already held.</li>
      </ul>
      <p>The browser must be open to serve pieces. Transfers can use battery and data; a sleeping or closed phone simply becomes unavailable until it returns.</p>
    </div>
  </section>
  <figcaption>Your device can save your files, hold encrypted pieces for other people, or do both at the same time.</figcaption>
</figure>`;

const supabaseDataDisclosure = `<div class="supabase-disclosure" data-supabase-disclosure>
  <header class="supabase-disclosure__intro">
    <span>Supabase data map</span>
    <strong>No named account does not mean no technical data</strong>
    <p>The classification below is deliberately conservative. A stable online identifier can still be personal data when it singles out a browser or can be combined with other information.</p>
  </header>
  <div class="supabase-disclosure__legend" aria-label="Privacy classifications">
    <span class="is-personal">Treat as personal data</span>
    <span class="is-contextual">Not directly identifying alone</span>
    <span class="is-local">Not sent to Supabase</span>
  </div>
  <div class="supabase-disclosure__list">
    <article>
      <header><strong>Anonymous session and request records</strong><span class="is-personal">Treat as personal data</span></header>
      <dl>
        <div><dt>Supabase receives</dt><dd>An anonymous Auth user ID, authenticated requests and operational timestamps. IP address, user-agent and request timing may also occur in ordinary provider or security logs.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase and the service operator. Under the current node policy, authenticated mesh sessions can query recent active node rows, although the standard interface does not display another node's Auth ID.</dd></div>
        <div><dt>What it reveals</dt><dd>No name, email or phone is requested in no-account mode. The persistent session and network logs can still single out and correlate the same browser over time.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Vault and browser-node identity</strong><span class="is-personal">Pseudonymous personal data</span></header>
      <dl>
        <div><dt>Supabase stores</dt><dd>Vault ID, node ID, anonymous Auth ID, owner and device public keys, browser-profile failure-domain ID, and the public node label you choose.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase. Authenticated mesh sessions can read recent active node records and coordination/cache records allowed by the current Row Level Security policies.</dd></div>
        <div><dt>What it reveals</dt><dd>Random IDs and public keys do not contain a civil identity and cannot be decoded into a name. They do provide stable links to the same vault or browser. A personal node label can identify you directly.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Node status, storage and coarse location</strong><span class="is-personal">Pseudonymous personal data</span></header>
      <dl>
        <div><dt>Supabase stores</dt><dd>Online state, last-seen time, shared limit, app shard usage, reliability, uptime, Anchor lease, Wake Lock state, buddy node IDs, coarse country/region, a salted network-domain hash, coordination protocol/mode and bounded Anchor load/capacity counters.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase and authenticated mesh sessions while a node is recent under the current policy. Selected values are intentionally shown in Live Mesh.</dd></div>
        <div><dt>What it reveals</dt><dd>It can describe a device's participation pattern and approximate area. The app table does not store precise GPS coordinates, an address, browsing history, other tabs or general device storage contents.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Encrypted vault and file-control records</strong><span class="is-contextual">Content protected; context linkable</span></header>
      <dl>
        <div><dt>Supabase stores</dt><dd>An owner-signed encrypted private vault profile, an owner-signed encrypted vault-index snapshot, immutable signed vault operations, encrypted names and metadata, file sizes, coding parameters, vault-keyed deduplication tokens, shard hashes and placements, recovery status, transfer/repair/deletion records, signed or encrypted manifests, encrypted share-capability records and audit events. It does not store file-shard payloads or secret vault keys.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase. Current authenticated coordination/cache policies permit mesh sessions to read relevant rows; clients must treat them as untrusted and verify signatures, hashes and ciphertext.</dd></div>
        <div><dt>What it reveals</dt><dd>Ciphertext does not reveal the readable name or file without the key, and keyed fingerprints cannot be compared across vaults. Sizes, timestamps, hashes and activity can still be associated with a stable vault ID.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>WebRTC signaling</strong><span class="is-personal">Treat as personal data</span></header>
      <dl>
        <div><dt>Supabase processes</dt><dd>Sender and recipient node IDs, offers, answers and ICE candidates when the hosted signaling fallback is used. Protocol v3 delivers them as transient Realtime Broadcast messages through a recipient topic protected by a random 256-bit token kept in an app-owned RLS table; the application does not persist signaling payloads as database rows.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase and a subscriber that knows the random topic token. The app-owned topic table exposes that token only to the anonymous session that owns the recipient node; it is not returned by peer discovery.</dd></div>
        <div><dt>What it reveals</dt><dd>ICE data may contain network-address information. Broadcast messages are transient at the application layer, but normal infrastructure logs can follow separate retention rules.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Optional node reminders</strong><span class="is-personal">Treat as personal data</span></header>
      <dl>
        <div><dt>Supabase stores when enabled</dt><dd>The node ID, browser push endpoint and push encryption material, plus the last wake-request time.</dd></div>
        <div><dt>Who can see it</dt><dd>The protected Edge Function through its service role; browser clients have no direct table policy. The selected browser or operating-system push provider also processes delivery data.</dd></div>
        <div><dt>What it reveals</dt><dd>The endpoint can address one browser installation and should be treated as a pseudonymous device identifier. It does not contain the Mesh Key or file content.</dd></div>
        <div><dt>What it does</dt><dd>A selected buddy Anchor can request a user-visible notification. The user must tap it to reopen Night Node; it does not run WebRTC or shard transfer in the background. The current build does not send these reminders automatically.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Optional linked account</strong><span class="is-personal">Direct personal data</span></header>
      <dl>
        <div><dt>Supabase stores when used</dt><dd>The account's email and Auth identifier, plus a record linking that account identifier to the vault ID.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase and the service operator. The email is held by Auth; the current coordination policy exposes account-link identifiers, not the Auth email, to authenticated sessions.</dd></div>
        <div><dt>What it reveals</dt><dd>This can directly connect a vault to a conventional account. Account linking is optional and does not become cryptographic ownership.</dd></div>
      </dl>
    </article>
    <article class="is-boundary">
      <header><strong>Secrets and file bytes kept out of Supabase</strong><span class="is-local">Not sent</span></header>
      <dl>
        <div><dt>Remains inside an authorised browser profile in usable form</dt><dd>The 256-bit root seed, derived owner private key, metadata and deduplication keys, derived segment keys and readable file bytes. A user can deliberately save the same root as a 24-word BIP39 Mesh Key. An explicit share capability can encrypt a limited set of segment keys for its recipient, but the protocol never uploads the root, owner private key or root-level symmetric keys.</dd></div>
        <div><dt>Stored on storage peers instead</dt><dd>Encrypted shard payloads. Supabase and Anchor control caches receive coordination objects, not shard payload bytes; the current app does not use Supabase Storage for file or shard content.</dd></div>
        <div><dt>Important limit</dt><dd>Encrypted data is protected from being read without its key, but its surrounding identifiers, size and timing can still be personal data when linked to a device or vault.</dd></div>
      </dl>
    </article>
  </div>
  <aside class="supabase-disclosure__conclusion">
    <strong>What cannot normally identify you by itself?</strong>
    <p>A random vault/node ID, public key, nonce, ciphertext or keyed hash does not contain a name and cannot simply be decoded into your identity or file. We still do not promise that stable records are untraceable: an IP log, personal node label, optional account or information held elsewhere may create the missing link. Only data made genuinely unlinkable to any person should be described as anonymous.</p>
    <p>See the EU definitions of <a href="https://eur-lex.europa.eu/eli/reg/2016/679/art_4/par_1/oj" target="_blank" rel="noopener">personal data and pseudonymisation</a> and the <a href="https://www.edpb.europa.eu/topics/ai-and-technology/anonymisationpseudonymisation_en" target="_blank" rel="noopener">EDPB explanation of anonymisation and pseudonymisation</a>.</p>
  </aside>
</div>`;

const architecture = {
  id: "security",
  kind: "Technical reference",
  title: "Security & Architecture",
  summary: "What happens after you choose a file: which device sees which bytes, how the pieces are rebuilt, which limits are enforced, and where the current system still depends on Supabase.",
  version: "Storage protocol v3",
  updated: "4 August 2026",
  status: "Current implementation",
  sections: [
    {
      id: "simple-overview",
      title: "The whole idea",
      body: simpleArchitectureInfographic,
    },
    {
      id: "key-boundary",
      title: "Does my private key leave my device?",
      body: `<p><strong>No. Protocol v3 keeps the usable root seed and derived owner private key inside the authorised browser profile.</strong> A new vault starts with 32 bytes from <code>crypto.getRandomValues()</code>. Those 256 bits are encoded as a standard 24-word BIP39 Mesh Key and deterministically derive the Ed25519 owner identity and the vault's domain-separated key hierarchy. The protocol does not upload a secret key package for later recovery.</p>
      <p>A user can deliberately copy or export the 24-word phrase for offline safekeeping. That phrase represents the complete root secret and must be protected like a private key. Supabase and Anchor control caches receive public keys and signed or encrypted coordination objects only. Ordinary storage peers receive encrypted file shards, never the root, owner private key or segment keys.</p>
      <aside class="architecture-units"><strong>One root, separate cryptographic jobs.</strong><p>HKDF-SHA-256 domain separation derives independent material for the Ed25519 owner, private metadata, vault-private deduplication and per-segment encryption. A key used for one job is not reused directly for another.</p></aside>
      <figure class="security-key-flow" aria-labelledby="security-key-flow-title">
        <div class="architecture-figure__head"><div><span>Protocol v3 key and file boundary</span><strong id="security-key-flow-title">Local authority, narrow coordination and encrypted storage</strong></div><em>Code-native diagram · no external image dependency</em></div>
        <div class="security-key-flow__image">${securityKeyFlowDiagram}</div>
        <figcaption>The coordination path never carries the root, owner private key, segment keys or file-shard payloads. A share link is the deliberate exception for access: its signed encrypted capability grants only the named file version's segment keys, protected by a recipient secret in the URL fragment.</figcaption>
      </figure>
      <div class="architecture-example">
        <article><b>1</b><div><strong>Create the root locally</strong><p>The browser requests 256 random bits from <code>crypto.getRandomValues()</code> and encodes them with a BIP39 checksum as 24 English words.</p></div></article>
        <article><b>2</b><div><strong>Derive identity locally</strong><p>A domain-separated derivation produces the Ed25519 owner seed. The Vault ID is SHA-256 of its raw public key, so the same phrase reconstructs the same identity.</p></div></article>
        <article><b>3</b><div><strong>Separate every key purpose</strong><p>Other domain labels derive the AES metadata key, HMAC deduplication key and segment-key root. Per-segment context then deterministically derives each AES-256 key.</p></div></article>
        <article><b>4</b><div><strong>Send only bounded outputs</strong><p>Supabase and Anchors coordinate with public keys and signed or encrypted objects. Storage peers receive only hash-addressed encrypted shards.</p></div></article>
        <article><b>5</b><div><strong>Restore identity, then discover data</strong><p>A new browser reconstructs the identity locally from the 24 words. It still needs the hosted backbone or an already-connected mesh to discover manifests, peers and enough valid shards; Anchors do not yet replace a completely new cold start.</p></div></article>
      </div>
      <p><strong>Security consequence:</strong> a coordination-database leak or one encrypted shard does not reveal vault secrets. By contrast, anyone who obtains the 24-word Mesh Key, compromises same-origin application code through XSS, controls a privileged browser extension, or can read the local browser profile may obtain the root and derived secrets. The current browser storage is not a hardware-backed key vault.</p>`,
    },
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
          <article><b>03</b><span>Protect</span><strong>Encrypt separately</strong><small>Each new unique segment gets a context-derived AES-256-GCM key and a fresh random nonce before it leaves the browser.</small></article>
          <article><b>04</b><span>Make recoverable</span><strong>Create shards</strong><small>The encrypted segment becomes K data shards plus R recovery shards.</small></article>
          <article><b>05</b><span>Distribute</span><strong>Verify devices</strong><small>Shards are hash-checked and placed across separate eligible browser devices.</small></article>
        </div>
        <div class="architecture-layers" aria-label="Storage and transport layers">
          <span><b>File layer</b>Up to 100 MB now</span><i aria-hidden="true">→</i>
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
        <article><b>3</b><div><strong>Encrypt that block</strong><p>If this vault does not already have the same verified segment, the browser deterministically derives its 256-bit key from the vault root and authenticated segment context, then creates a fresh random 96-bit nonce. From this point onward the block is unreadable without the vault-controlled key.</p></div></article>
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
        <li><strong>Vault-private reuse.</strong> Before encryption, the browser calculates a keyed HMAC fingerprint scoped to this vault. If the same aligned segment already exists in a ready version of this vault, that encrypted segment can be reused. An identical segment in another vault has a different fingerprint, so there is no cross-vault deduplication.</li>
        <li><strong>Independent encryption.</strong> Every newly created representation is encrypted with AES-256-GCM using a deterministic per-segment key, a fresh random 96-bit nonce and authenticated context. HKDF binds the key to protocol v3, Vault ID, segment ID, key-derivation version, encryption generation, storage format and vault-private deduplication token. The key is recomputed locally instead of stored or transported; private segment metadata is encrypted separately with the domain-separated metadata key. Reused vault-local segments keep their existing verified ciphertext and derivation context.</li>
        <li><strong>Erasure coding.</strong> Each encrypted segment is independently encoded into K data shards and R recovery shards. Any K valid shards from that coding group can reconstruct the encrypted segment. The profile adapts to the number of independent placement candidates and the selected resilience class.</li>
        <li><strong>Verified placement.</strong> Shards are transferred as 32 KiB WebRTC DataChannel packets, reassembled, hashed and acknowledged. Only durable placements on distinct browser/device failure domains count as independent protection within a shard group. A local fallback copy may be kept while repair is pending, but it does not count as another independent device. Across the whole file, placement first prefers devices that do not already hold one of its segments, then balances necessary reuse by capacity, reliability, network diversity and measured connection quality.</li>
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
        <article><span>Six devices</span><strong>4+2</strong><small>Six shards total · any four recover · 50% redundancy.</small></article>
        <article><span>Eight devices</span><strong>6+2</strong><small>Eight shards total · any six recover · approximately 33% redundancy.</small></article>
        <article><span>Ten devices</span><strong>7+3</strong><small>Ten shards total · any seven recover · approximately 43% redundancy.</small></article>
        <article class="is-emphasized"><span>Twelve devices</span><strong>8+4</strong><small>Twelve shards total · any eight recover · 50% redundancy.</small></article>
        <article><span>Automatic at sixteen</span><strong>10+6</strong><small>Sixteen shards total · any ten recover · 60% redundancy.</small></article>
        <article><span>Balanced at sixteen</span><strong>12+4</strong><small>Optional lower-overhead mode · any twelve recover · approximately 33% redundancy.</small></article>
      </div>
      <p><strong>K+R notation:</strong> K is the number of shards required for recovery; R is the additional recovery capacity. For example, 6+2 creates eight shards and survives any two missing shards in that segment group, provided the remaining six are valid and reachable. A profile applies per segment and can be upgraded later when enough independent nodes are available.</p>
      <p>The 8 MiB target is a deliberate browser trade-off. Smaller segments would create more database rows, hashes, encryption operations, manifests and transfer acknowledgements; much larger segments would increase temporary memory and repair cost. The current limit keeps memory bounded while leaving shards small enough for practical peer placement.</p>`,
    },
    {
      id: "cryptography",
      title: "Cryptography used today",
      body: `<p>The current browser release uses the Web Crypto API. Vault creation requests exactly 32 random bytes from the browser's cryptographically secure generator, <code>crypto.getRandomValues()</code>; it does not use <code>Math.random()</code>. BIP39 adds a checksum and encodes those 256 random bits as a 24-word English Mesh Key. Fresh AES-GCM nonces and share secrets also use the browser CSPRNG.</p>
      <div class="document-table-wrap"><table><thead><tr><th>Purpose</th><th>Current construction</th><th>What it protects</th></tr></thead><tbody>
        <tr><td>Root and Mesh Key</td><td>256 CSPRNG bits encoded with a BIP39 checksum as 24 English words.</td><td>The words reproduce the same root locally. They are the complete recovery secret and are never uploaded by the protocol.</td></tr>
        <tr><td>Vault authority</td><td>Ed25519 only. A domain-separated HKDF-SHA-256 derivation from the root creates the signing seed; the Vault ID is SHA-256 of the raw owner public key.</td><td>Signed manifests and owner operations can be verified against a deterministic, self-certifying vault identifier.</td></tr>
        <tr><td>Derived key hierarchy</td><td>Separate HKDF-SHA-256 domains derive the AES-256 metadata key, HMAC-SHA-256 deduplication key and HKDF segment-key root.</td><td>A compromise or misuse of one derived purpose does not directly reuse the same key bytes for another purpose.</td></tr>
        <tr><td>File segments</td><td>AES-256-GCM with a deterministic context-bound 256-bit segment key and a fresh random 96-bit nonce for every newly created representation. The context binds protocol, vault, segment, derivation, encryption generation, storage format and private deduplication token.</td><td>Confidentiality and tamper detection before erasure coding. Reused segments inside the same vault retain their verified ciphertext and derivation context; the segment key is recomputed locally rather than stored or transported.</td></tr>
        <tr><td>Hashes and private reuse</td><td>SHA-256 for public identifiers and integrity hashes; HMAC-SHA-256 under the domain-separated deduplication key for vault-private matching.</td><td>Detects changed shards, ciphertext, manifests and restored bytes. The keyed token can match data inside one vault but differs across vaults.</td></tr>
      </tbody></table></div>
      <p><strong>Local-key boundary:</strong> the current web app stores the encoded 256-bit root and separate device identity material in app-scoped IndexedDB so the same browser profile can reopen the vault. The owner key and vault key hierarchy are reconstructed locally from that root. They rely on browser-profile, operating-system and device access controls; they are not hardware-backed or protected from code already executing in the application origin. XSS, a malicious extension, a compromised browser profile, an unlocked endpoint or a copied 24-word Mesh Key can therefore grant vault access. The security of newly generated roots and nonces also depends on the browser and operating system implementing their CSPRNG correctly.</p>`,
    },
    {
      id: "operating-limits",
      title: "Current limits",
      body: `<p>These are the limits enforced by the current browser release. They are product boundaries, not promises about what every network or phone can achieve.</p>
      <div class="architecture-limit-grid">
        <article><span>Upload</span><strong>100 MB per file</strong><p>Exactly 100,000,000 bytes. Larger files are rejected before encryption starts. Multiple selected files are processed one at a time.</p></article>
        <article><span>File types</span><strong>No extension restriction</strong><p>Any file type may be encrypted. Already-compressed formats such as JPEG, PNG, MP4, PDF and ZIP skip gzip.</p></article>
        <article><span>Total vault</span><strong>No fixed account quota</strong><p>Usable storage is limited by the capacity currently offered by reachable mesh devices, not by a simulated cloud allowance.</p></article>
        <article><span>This browser contributes</span><strong>0 to 250 GiB</strong><p>The default is 1 GiB. The selected cap applies only to encrypted shards stored for the mesh in this browser and cannot exceed storage the browser actually grants.</p></article>
        <article><span>Processing block</span><strong>8 MiB maximum</strong><p>8,388,608 bytes per segment. Network transport then splits shards into 32 KiB packets.</p></article>
        <article><span>Recovery pieces</span><strong>16 shards maximum</strong><p>Automatic reaches 10+6 at sixteen independent devices. Balanced can use 12+4 at the same size.</p></article>
        <article><span>Share links</span><strong>24 hours</strong><p>The current Drive interface creates one-day links. Deleting the file revokes known links. Password and download-limit fields exist in the protocol but are not exposed in the current Drive interface.</p></article>
        <article><span>Long operation</span><strong>6-hour timeout</strong><p>An individual upload or recovery task is cancelled if it cannot finish within six hours.</p></article>
        <article><span>Anchor cache</span><strong>25 MiB to 1 GiB</strong><p>100 MiB by default, used for signed or encrypted control records rather than readable file content. Node reminders are optional and add a small availability signal when enabled.</p></article>
      </div>
      <details class="architecture-timers"><summary>Network maintenance timings</summary><p>A node is treated as stale after two minutes without a report. Storage proofs are considered fresh for 30 minutes. A missing placement receives a 30-minute repair grace period, and returning surplus copies receive a five-minute reconciliation grace period. Night Node leases last 90 seconds and renew every 30 seconds while the browser remains able to run.</p></details>
      <details class="architecture-timers"><summary>How optional node reminders work</summary><p>Anchor activity is decided by its renewable lease, not by notification permission. If reminders are enabled, TheMeshVault stores a protected browser push endpoint and a selected buddy Anchor can request a notification through the Edge Function. The service worker displays it, and tapping it reopens Night Node. The notification cannot keep WebRTC running by itself, and disabling or losing the subscription does not stop an otherwise active Anchor.</p></details>`,
    },
    {
      id: "data-locations",
      title: "Where data is stored",
      body: `<figure class="architecture-figure architecture-figure--network" aria-labelledby="network-flow-title">
        <div class="architecture-figure__head"><div><span>Network architecture</span><strong id="network-flow-title">File bytes and coordination data take different paths</strong></div><em>Solid lines carry encrypted file material; dashed lines carry control data</em></div>
        <div class="network-diagram">
          <article class="network-node network-node--owner"><span>Owner browser</span><strong>Cryptographic authority</strong><small>Readable bytes, the 256-bit root, the Mesh Key phrase and all derived private keys remain inside the authorised browser profile during operation.</small></article>
          <div class="network-route network-route--shards"><span>Encrypted shards</span><i aria-hidden="true">→</i><small>Direct WebRTC where possible</small></div>
          <article class="network-node network-node--peers"><span>Independent storage devices</span><strong>Store hash-addressed shards</strong><small>No readable file and no segment decryption key.</small></article>
          <div class="network-route network-route--control"><span>Signed / encrypted metadata</span><i aria-hidden="true">⇢</i><small>Discovery, signaling and placement</small></div>
          <article class="network-node network-node--coordination"><span>Supabase backbone</span><strong>Current operational control plane</strong><small>Anonymous sessions, public keys and signed or encrypted coordination objects for discovery, signaling, placement and repair. It receives no shard payloads or secret vault keys.</small></article>
          <div class="network-route network-route--relay"><span>Fallback relay</span><i aria-hidden="true">↝</i><small>Encrypted WebRTC traffic only</small></div>
          <article class="network-node network-node--turn"><span>TURN, when needed</span><strong>Relays an encrypted connection</strong><small>Can observe endpoints and traffic volume, but does not receive vault keys.</small></article>
        </div>
        <div class="architecture-boundary"><span><b>Never sent by the protocol</b>256-bit root · Mesh Key phrase · owner private key · metadata/deduplication roots · readable file bytes</span><span><b>May leave through bounded paths</b>Public keys and signed/encrypted coordination objects to Supabase/Anchors · encrypted shard payloads to storage peers · an encrypted file-version-limited segment-key grant through an explicit share link</span></div>
        <figcaption>After three healthy Anchors have remained connected, current clients prefer their discovery, signaling relay and bounded control cache. Supabase remains the first-contact and immediate fallback path and still holds the persistent coordination metadata described below.</figcaption>
      </figure>
      <div class="document-table-wrap"><table><thead><tr><th>Location</th><th>What can be there</th><th>What is not intended to be there</th></tr></thead><tbody>
        <tr><td>Your browser</td><td>The encoded 256-bit root, separate device identity, derived owner and symmetric key material in memory, the 24-word Mesh Key while the vault is open, encrypted metadata, your private vault name, signed encrypted vault-index snapshots, an append-only signed operation queue, manifests, settings, and any encrypted shards this browser stores. Shards use OPFS when available with IndexedDB metadata/fallback. Local secrets rely on the browser profile and operating system for protection.</td><td>Normal storage and coordination do not send the root, Mesh Key phrase, owner private key, usable symmetric keys or readable file bytes to Supabase, Anchors or storage nodes. An explicit share is the exception described below: it publishes an encrypted one-file key grant whose opening secret remains in the link fragment.</td></tr>
        <tr><td>Storage peers and Anchors</td><td>A browser acting as a storage peer can hold content-addressed encrypted shard payloads. The separate Anchor control role retains only bounded signed or encrypted coordination objects such as encrypted vault indexes, signed operations, repair requests and leases, and owner-signed deletion orders with device-signed acknowledgements.</td><td>An Anchor control cache receives no file-shard payloads or root/private/segment keys. A browser that separately contributes shard storage does so under the storage role and quota. Neither role receives the private vault name, original plaintext file or vault authority.</td></tr>
        <tr><td>Supabase backbone</td><td>Pseudonymous anonymous-session identifiers, vault and device public keys, an owner-signed encrypted private vault profile and vault index, immutable signed vault operations, public node labels, encrypted file/folder metadata, file sizes, vault-private keyed deduplication tokens, coding records, shard hashes and placements, node capacity/status/location, transient signaling, transfer/repair/deletion state, signed or encrypted manifests, encrypted capability records and audit events.</td><td>The private vault name and vault-index contents remain ciphertext. The root, Mesh Key phrase, owner private key, root-level symmetric keys, readable file and encrypted shard payloads are not stored there. An explicit share record can contain a file-version-limited segment-key grant encrypted for the recipient, but Supabase does not receive its fragment secret or usable keys. This app does not use Supabase Storage for file content.</td></tr>
        <tr><td>TURN relay, when required</td><td>Encrypted WebRTC traffic and connection metadata while relaying a peer connection.</td><td>The relay is not given the vault's decryption key.</td></tr>
        <tr><td>Share link</td><td>The owner explicitly creates a signed capability whose encrypted payload contains only the segment-key grants needed for one named file version. The URL fragment carries the recipient secret used to open that payload and is not sent in a normal HTTP request. Expiry, revocation, optional password and download limits bound coordinated redemption.</td><td>The root and owner private key are never shared. A complete active link is still a bearer secret: anyone who receives it may access the granted file until the capability expires or is revoked, and revocation cannot erase plaintext already downloaded.</td></tr>
      </tbody></table></div>`,
    },
    {
      id: "supabase-backbone",
      title: "Supabase: purpose and data",
      body: `<p>Supabase is not the cryptographic owner of a vault, but it is operationally important in the current release. The browser normally creates a Supabase Auth user marked as anonymous after you choose to create, restore or contribute. You do not provide a name, email address or password for that session, but it is still a stable pseudonymous technical account used for Row Level Security and coordination.</p>
      <figure class="architecture-figure architecture-figure--backbone" aria-labelledby="backbone-title">
        <div class="architecture-figure__head"><div><span>Trust and availability</span><strong id="backbone-title">Ownership stays local; coordination has a fast path and a limited fallback</strong></div><em>These are different responsibilities</em></div>
        <div class="backbone-grid">
          <article class="backbone-card backbone-card--authority"><span>Local authority</span><strong>Your authorised browser</strong><ul><li>Creates and stores the 256-bit root</li><li>Shows its 24-word BIP39 recovery form</li><li>Derives the Ed25519 owner and symmetric hierarchy</li><li>Encrypts, signs, decrypts and verifies</li></ul><b>Supabase cannot replace this authority.</b></article>
          <article class="backbone-card backbone-card--fast"><span>Hosted backbone</span><strong>Supabase</strong><ul><li>Anonymous Auth session and RLS access</li><li>Vault and node public registration</li><li>Bounded first-contact discovery</li><li>Opaque recipient signaling fallback</li><li>File/segment/shard metadata and placements</li><li>Durable signed index and operation fallback</li><li>Transfer, repair, deletion and audit state</li><li>Signed or encrypted manifest/control caches</li></ul><b>Operationally important today; no shard payloads or secret keys.</b></article>
          <article class="backbone-card backbone-card--fallback"><span>Distributed active path</span><strong>Connected Anchors and peers</strong><ul><li>Select three primary and two reserve Anchors</li><li>Replicate an encrypted signed vault index</li><li>Replicate immutable signed operations</li><li>Relay signals and serve cached manifests</li><li>Carry repair leases and deletion orders</li></ul><b>Not yet a complete cold-start replacement. Preferred after three Anchors are stable.</b></article>
        </div>
        <div class="backbone-outage"><span><b>Three stable Anchors</b>An already-connected client can prefer Anchor relay and control replication. Ordinary clients write node presence to Supabase at a reduced ten-minute cadence while signed operations are periodically backed up.</span><span><b>Fewer than two Anchors</b>The client immediately restores Supabase discovery and opaque recipient signaling. With two Anchors it stays hybrid while stability is measured.</span><span><b>Current hard limits</b>The 24 words reconstruct identity locally, but a completely new browser still needs the hosted backbone or existing reachable mesh context to discover manifests, peers and placements. New file ingestion, durable segment/placement records and the atomic repair job remain Supabase-backed.</span></div>
        <figcaption>“No account required” means no named user account is requested. It does not mean no server-side session or network metadata exists. The current anonymous Supabase session, stable vault/device identifiers and related activity are pseudonymous rather than guaranteed anonymous.</figcaption>
      </figure>
      ${supabaseDataDisclosure}
      <p><strong>Cold-start boundary:</strong> entering the 24 words reconstructs the same root, Ed25519 owner, Vault ID and derived key hierarchy entirely in the new browser. No hosted secret-key lookup occurs. Supabase remains the present bootstrap/backbone/fallback for locating the vault's signed or encrypted coordination records and reachable peers; connected Anchors cannot yet guarantee discovery for a browser starting with no network context.</p>`,
    },
    {
      id: "identity",
      title: "Identity and control",
      body: `<p>A new vault creates one 256-bit random root in the browser and encodes it as a 24-word BIP39 Mesh Key. Domain-separated deterministic derivations produce the Ed25519 owner identity, private discovery identifier, metadata key, deduplication key and segment-key root. The Vault ID is SHA-256 of the raw owner public key. Sensitive operations are signed, and clients verify signatures and hashes instead of trusting a coordination database row merely because it exists.</p>
      <p>The current catalog also has an encrypted, owner-signed vault-index snapshot and a local append-only signed operation queue. The browser reads the newest valid index in local-first, Anchor-second, Supabase-fallback order. Folder creation and metadata moves can remain locally queued during a temporary coordination failure and replay idempotently when the backbone returns. File bytes, segment placement and initial upload records still require the current Supabase-backed storage workflow.</p>
      <p>The phrase itself is not uploaded. Typing it or importing the current Mesh Key file reconstructs the same root and identity locally; the file contains the 24 words and public Vault ID, not a hosted secret-key package. Possession of either form grants vault authority and it must be protected as a bearer secret. Identity restoration is deterministic, but data discovery is a separate network step: a completely new browser still depends on Supabase or existing reachable mesh context to locate current signed manifests, peers and placements.</p>
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
      body: `<p>Download discovers a signed manifest, retrieves enough verified shards for each segment, reconstructs the encrypted representation, decrypts and decompresses locally, and calculates the whole-file SHA-256 hash incrementally. “Exact recovery verified” is shown only after that hash matches the signed manifest. Recovery tries at most four shard tasks at once, starts one delayed fallback request when useful, retries temporary failures with bounded backoff, and cancels excess requests as soon as K valid shards have arrived.</p>
      <figure class="architecture-figure architecture-figure--recovery" aria-labelledby="recovery-flow-title">
        <div class="architecture-figure__head"><div><span>Download data flow</span><strong id="recovery-flow-title">Recovery reverses the pipeline and verifies the result</strong></div><em>The original uploader need not be online when enough other verified shards are reachable</em></div>
        <div class="recovery-flow">
          <span><b>1</b><strong>Verify manifest</strong><small>Check owner signature and content hash.</small></span><i aria-hidden="true">→</i>
          <span><b>2</b><strong>Fetch any K shards</strong><small>Reject bytes that fail their shard hash.</small></span><i aria-hidden="true">→</i>
          <span><b>3</b><strong>Reconstruct segment</strong><small>Rebuild the exact encrypted representation.</small></span><i aria-hidden="true">→</i>
          <span><b>4</b><strong>Decrypt and expand</strong><small>Authenticate, decrypt and decompress locally.</small></span><i aria-hidden="true">→</i>
          <span><b>5</b><strong>Verify whole file</strong><small>Compare incremental SHA-256 with the signed original hash.</small></span>
        </div>
        <figcaption>Recovery succeeds only when every segment group has at least K valid reachable shards. One healthy segment cannot compensate for another segment that is below its recovery threshold.</figcaption>
      </figure>
      <p>When placements become unavailable, the repair coordinator can recreate missing shards from a recoverable segment and place replacements on eligible nodes. A device-signed repair advisory is gossiped and retained by connected Anchors. Candidate repairers publish short signed leases and deterministically select one winner before the request is copied into the Supabase-backed atomic job queue. The actual placement mutation still uses that hosted queue in this release. Returning surplus copies are reconciled after a grace period and do not increase the logical erasure profile.</p>`,
    },
    {
      id: "deletion",
      title: "Deletion",
      body: `<p>Deleting a file revokes known share capabilities, tombstones the vault record and creates owner-signed deletion orders for known shard holders. The orders are copied to connected Anchors as well as the Supabase-backed deletion state. A returning holder verifies the owner signature and node binding before erasing, then publishes a device-signed acknowledgement that the owner browser verifies before finalising the placement. An offline node cannot receive an instruction until it reconnects, so an unreadable encrypted shard may remain on that device in the meantime.</p>
      <p>Hiding a cleanup row removes it from that browser's interface only. It does not cancel the signed deletion order. Deduplicated segments that are still referenced by another version are retained until no live reference remains.</p>`,
    },
    {
      id: "limits",
      title: "Threat model and limits",
      body: `<ul>
        <li>The design protects file confidentiality from ordinary storage nodes that possess only encrypted shards.</li>
        <li>Authenticated encryption, hashes and signatures are used to detect altered file material and forged manifests.</li>
        <li>Erasure coding protects availability only when enough verified independent devices actually hold the required shards.</li>
        <li>A same-origin XSS flaw or other malicious application code can read the root from IndexedDB, invoke local signing/decryption operations and capture plaintext. The cryptographic network boundary does not defend against code already executing with the app's browser-origin privileges.</li>
        <li>Anyone who can read or control the local browser profile, a sufficiently privileged extension, an unlocked endpoint or the operating system may obtain local secrets. The current root storage is app-scoped, not hardware-backed.</li>
        <li>A compromised endpoint with an unlocked vault can read files available to that endpoint. Cryptography cannot protect plaintext while an authorised device is using it.</li>
        <li>Browser storage can be cleared by the user, browser or operating system. Mobile browsers may suspend or terminate background tabs despite Wake Lock, PWA, sync or push assistance.</li>
        <li>The randomness guarantee depends on the browser and operating system correctly implementing <code>crypto.getRandomValues()</code>. The protocol avoids predictable application-level generators but cannot repair a compromised CSPRNG or endpoint.</li>
        <li>Traffic analysis, IP-address privacy and loss of every Mesh Key copy are outside the protection offered by shard encryption.</li>
        <li>Anchors assist an already-connected mesh but do not yet guarantee bootstrap for a completely new browser. Supabase remains the operational bootstrap, backbone and immediate fallback.</li>
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
  updated: "26 July 2026",
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
      body: `<p>TheMeshVault is a no-account, cryptographically owned peer-to-peer storage protocol and application. It encrypts files locally, distributes recovery shards across participating storage devices, and currently uses Supabase as an operational bootstrap, backbone and fallback for pseudonymous sessions, discovery, signaling, metadata, placement, repair and deletion coordination. Supabase and Anchor control caches are not intended to hold readable file contents, encrypted shard payloads, the Mesh Key root or private vault keys.</p>
      <p>It is not a guaranteed backup service. Recoverability depends on current verified shard placement, participating devices, network access, compatible software and possession of the required Mesh Key or sharing capability. Some operations over already-established peer and Anchor connections may survive a hosted-coordination interruption, but this is not an offline guarantee. A completely new browser cannot currently rely on Anchors alone for cold-start discovery.</p>`,
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
      <p>Anyone with a complete active share link may be able to retrieve the shared file. Each link combines a signed encrypted capability with a recipient secret in the URL fragment and grants only the segment keys for one named file version; it does not grant the vault root or owner private key. Current Drive links expire after 24 hours; deleting the file revokes its known links. The protocol supports optional password and download restrictions, but the current Drive interface does not expose those controls.</p>`,
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
  updated: "27 July 2026",
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
      <p>When hosted coordination is used, the browser still creates a Supabase Auth user marked as anonymous. That technical user, the stable vault/device identifiers, public node label, IP-address information and related activity can distinguish the same browser or vault over time. A private vault name is encrypted locally before its signed ciphertext is synced; it is not used as a public mesh label. TheMeshVault therefore promises <strong>no named account required</strong>, not legal or network anonymity. These records are described conservatively as pseudonymous technical data and may remain personal data under applicable law.</p>`,
    },
    {
      id: "local-data",
      title: "3. Data kept in your browser",
      body: `<p>The app stores the encoded 256-bit root, separate device identity, recovery status, settings, encrypted names and metadata, signed manifests, operation logs, cached control objects and encrypted shards in app-scoped browser storage. It reconstructs the Ed25519 owner and domain-separated metadata, deduplication and segment-key hierarchy locally from the root. OPFS is preferred for shard bytes, with IndexedDB used for metadata and fallback storage.</p>
      <p>This data may remain until you delete it, clear site data, remove the browser profile or the browser/operating system evicts it. Normal storage and coordination do not send the root, 24-word Mesh Key, readable file contents, owner private key or usable derived symmetric keys to Supabase, Anchors or storage nodes. If you deliberately create a share link, Supabase stores an encrypted key grant limited to that file version; only the bearer secret in the URL fragment can open it. A phrase restore reconstructs the identity locally and sends no secret-key lookup; network coordination is still needed to discover remote metadata and shards.</p>`,
    },
    {
      id: "mesh-data",
      title: "4. What other mesh devices receive",
      body: `<p>A storage node receives content-addressed encrypted shards, hashes needed to verify them and limited protocol information required to store, retrieve, repair or delete those shards. Connected peers can also see node and device identifiers, connection timing, requested shard hashes, transfer sizes, capacity claims, verification results and coarse failure-domain information.</p>
      <p>An ordinary storage node can see the public label chosen for your browser node, but should not receive your private vault name, email address, Mesh Key, readable filename or complete plaintext file. Encrypted shard bytes may nevertheless originate from a file that contains personal information; encryption makes that information unintelligible to a node that lacks the key.</p>`,
    },
    {
      id: "coordination-data",
      title: "5. What Supabase receives",
      body: `<p>The current Supabase backbone is used to make the service function, not merely for optional analytics. The exact application-data boundary, visibility and conservative privacy classification are shown below.</p>
      ${supabaseDataDisclosure}
      <p>Stable identifiers and related activity can single out the same vault or device. They are therefore described as <strong>pseudonymous technical data</strong>, not promised to be irreversibly anonymous.</p>
      <p>Supabase is currently used to make the service function, not merely for optional analytics: new file ingestion, durable segment and placement writes, cold peer discovery, signaling fallback and the atomic repair queue normally depend on it. The 24 words reconstruct keys locally, but a completely new browser still needs coordination to find remote manifests, peers and placements. Signed catalog operations, encrypted index snapshots, repair notices and signed deletion orders can also travel through already-connected Anchors and later reconcile with the backbone. Anchor control caches cannot yet replace a new cold start. Neither Supabase nor Anchor control caches receive file-shard payloads, the root or derived private keys.</p>
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
      body: `<p>Protocol v3 recipient-topic signaling is transmitted as transient Realtime Broadcast messages rather than application database rows. Presence and renewable lease information changes as devices report. Browser-local data remains under the browser profile's storage lifecycle. Anchor control objects expire by type: repair leases after about two minutes, repair requests after about 30 minutes, and signed indexes, operations, deletion records and completion records after up to 30 days in the current cache. Supabase fallback copies, signed or encrypted manifests and control records, audit events and optional account links follow the service's operational and database lifecycle; the future controller must publish exact retention periods before production launch.</p>
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
      <p>No technical measure eliminates all risk, and TheMeshVault does not claim network anonymity. The local root is not hardware-backed: XSS or other code executing in the app origin, a privileged extension, an unlocked endpoint, operating-system compromise or direct access to the browser profile may expose it and any available plaintext. Keep the 24-word Mesh Key offline, protect authorised devices, avoid exposing complete share links and keep independent copies of important files during the pre-release stage.</p>`,
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
