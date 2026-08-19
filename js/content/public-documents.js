import {
  coldStartProcessDiagram,
  keyCustodyProcessDiagram,
  nativeBackgroundProcessDiagram,
  recoveryVerificationProcessDiagram,
  uploadProtectionProcessDiagram,
} from "./security-process-diagrams.js";

export const LEGAL_VERSIONS = Object.freeze({
  terms: "2026-08-16.1-draft",
  privacy: "2026-08-16.1-draft",
});

const securityKeyFlowDiagram = `<svg viewBox="0 0 1240 760" role="img" aria-labelledby="security-key-flow-svg-title security-key-flow-svg-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="security-key-flow-svg-title">Protocol v3 key, coordination and file-shard boundaries</title>
  <desc id="security-key-flow-svg-desc">A 256-bit browser-generated root becomes a 24-word BIP39 Mesh Key and deterministically derives the Ed25519 owner identity, metadata key, deduplication key and segment-key root. Root and private keys stay in the browser profile. Mesh participants receive only public keys and signed or encrypted coordination objects. Storage peers receive encrypted shards. Supabase is used for a new profile's first contact and the public Patient Zero authority chain anchored to the app's genesis key.</desc>
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
    <text x="722" y="100" fill="#f8fafc" font-size="23" font-weight="750">Mesh-only control after first contact</text>
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
    <p><strong>Every online node helps exchange control data. A new profile uses Supabase once to reach Patient Zero; after the verified WebRTC connection, that profile stays inside the mesh.</strong> Files, shards, manifests and placements are never written to Supabase.</p>
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
    <strong>One first-contact session still creates technical data</strong>
    <p>An ordinary profile contacts Supabase only until it has verified Patient Zero over WebRTC. The classification below remains deliberately conservative.</p>
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
        <div><dt>Supabase receives</dt><dd>A temporary anonymous Auth ID and the requests needed for first contact. IP address, user-agent, timing and security-log data may also be processed by the provider.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase and the service operator. Other app clients cannot request a general node list.</dd></div>
        <div><dt>What it reveals</dt><dd>No name, email or phone is requested. The temporary identifier and network logs can still single out the installation during this short phase.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Vault and node identity</strong><span class="is-personal">Pseudonymous personal data</span></header>
      <dl>
        <div><dt>Supabase temporarily stores</dt><dd>Node ID, anonymous Auth ID, device public key, public node label, implementation type and failure-domain identifier.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase and the exact current Patient Zero discovery path verified from the app's genesis trust root. The temporary row is deleted best-effort after the peer is verified.</dd></div>
        <div><dt>What it reveals</dt><dd>Random IDs and public keys do not encode a name, but they can link activity during first contact. A personal node label can identify you directly.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Node status, storage and coarse location</strong><span class="is-personal">Pseudonymous personal data</span></header>
      <dl>
        <div><dt>Supabase temporarily stores</dt><dd>Online state, last-seen time, declared storage limit and use, reliability, uptime and—when available—coarse country/region and a network-domain hash.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase and the targeted Patient Zero lookup during first contact. Continuing Live Mesh state is exchanged peer-to-peer.</dd></div>
        <div><dt>What it reveals</dt><dd>It can describe the device's first-contact state and approximate area. It does not contain precise GPS coordinates, an address, browsing history or general device storage contents.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Vault and file-control records</strong><span class="is-local">Not sent</span></header>
      <dl>
        <div><dt>Where it lives</dt><dd>Encrypted vault indexes, operations, names, file sizes, coding parameters, deduplication tokens, shard hashes and placements, recovery/repair/deletion state, manifests, capabilities and audit objects stay local or move through authenticated mesh peers.</dd></div>
        <div><dt>Supabase access</dt><dd>The runtime request gate blocks these tables even during first contact.</dd></div>
        <div><dt>Important limit</dt><dd>Connected peers may still see the bounded public or protected control objects required for their mesh role.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>WebRTC signaling</strong><span class="is-personal">Treat as personal data</span></header>
      <dl>
        <div><dt>Supabase processes once</dt><dd>Sender and recipient node IDs, the WebRTC offer/answer and ICE candidates needed to connect the new profile to Patient Zero.</dd></div>
        <div><dt>Who can see it</dt><dd>Supabase and the subscriber to the random recipient topic. The application does not persist signaling payloads as database rows.</dd></div>
        <div><dt>What it reveals</dt><dd>ICE data can contain network-address information. After verification, this profile closes Realtime and never uses hosted signaling again.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Patient Zero exception</strong><span class="is-personal">Treat as personal data</span></header>
      <dl>
        <div><dt>What remains online</dt><dd>The one deployment-authorised Patient Zero profile keeps a minimal node row, recipient signaling listener and sparse heartbeat so completely new installations can find it.</dd></div>
        <div><dt>How it is authorised</dt><dd>The local operator flag is not enough: its Ed25519 public device key must match the current responder in a public signed authority chain verified from the immutable genesis key shipped with the app.</dd></div>
        <div><dt>What it does not store</dt><dd>Patient Zero is not a key escrow, file store or central manifest database. It introduces the new profile to the live mesh.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Patient Zero authority history</strong><span class="is-contextual">Public cryptographic data</span></header>
      <dl>
        <div><dt>Supabase retains</dt><dd>The current public authority and responder keys plus an append-only sequence of signed public key transitions.</dd></div>
        <div><dt>Why it exists</dt><dd>A new installation can verify the current Mainframe identity from the immutable genesis public key without requiring a new app release for every rotation.</dd></div>
        <div><dt>What is never uploaded</dt><dd>The active authority private key and separate offline recovery private key. Old public keys are verification history, not a loose administrator allow-list.</dd></div>
      </dl>
    </article>
    <article>
      <header><strong>Permanent local cutoff</strong><span class="is-local">Mesh only</span></header>
      <dl>
        <div><dt>What happens after verification</dt><dd>The profile deletes its temporary node row best-effort, clears the anonymous Auth session, closes Realtime and persists a local completion marker.</dd></div>
        <div><dt>What cannot reopen it</dt><dd>A timer, reload, focus event, later peer outage or missing mesh route cannot silently reopen Supabase for that profile.</dd></div>
        <div><dt>Recovery limit</dt><dd>A restored profile still needs one successful first contact. After that, recovery needs reachable mesh peers plus enough valid shards; Supabase is not a file fallback.</dd></div>
      </dl>
    </article>
    <article class="is-boundary">
      <header><strong>Secrets and file bytes kept out of Supabase</strong><span class="is-local">Not sent</span></header>
      <dl>
        <div><dt>Remains inside an authorised browser or app WebView profile in usable form</dt><dd>The 256-bit root seed, derived owner private key, metadata and deduplication keys, derived segment keys and readable file bytes. A user can deliberately save the same root as a 24-word BIP39 Mesh Key. An explicit share capability can encrypt a limited set of segment keys for its recipient, but the protocol never uploads the root, owner private key or root-level symmetric keys. The Android background worker does not receive them either.</dd></div>
        <div><dt>Stored on storage peers instead</dt><dd>Encrypted shard payloads. Mesh control caches receive coordination objects, not shard payload bytes; the current app does not use Supabase Storage for file or shard content.</dd></div>
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
  summary: "What happens after you choose a file, which device sees which bytes, and how a new profile uses Supabase once before continuing through the mesh.",
  version: "Storage protocol v3",
  updated: "16 August 2026",
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
      body: `<p><strong>No. Protocol v3 keeps the usable root seed and derived owner private key inside the authorised browser profile.</strong> A new vault starts with 32 bytes from <code>crypto.getRandomValues()</code>. Those 256 bits are encoded as a standard 24-word BIP39 Mesh Key and deterministically derive the Ed25519 owner identity and the vault's domain-separated key hierarchy. Protocol v3 does not create or upload recovery envelopes or wrapped segment keys.</p>
      <p>A user can deliberately copy or export the 24-word phrase for offline safekeeping. That phrase represents the complete root secret and must be protected like a private key. Mesh participants receive public keys and signed or encrypted coordination objects only. Storage peers receive encrypted file shards, never the root, owner private key or segment keys. Supabase receives only temporary first-contact information and WebRTC signaling.</p>
      <aside class="architecture-units"><strong>One root, separate cryptographic jobs.</strong><p>HKDF-SHA-256 domain separation derives independent material for the Ed25519 owner, private metadata, vault-private deduplication and per-segment encryption. A key used for one job is not reused directly for another.</p></aside>
      <figure class="security-key-flow" aria-labelledby="security-key-flow-title">
        <div class="architecture-figure__head"><div><span>Protocol v3 key and file boundary</span><strong id="security-key-flow-title">Local authority, narrow coordination and encrypted storage</strong></div><em>Code-native diagram · no external image dependency</em></div>
        <div class="security-key-flow__image">${securityKeyFlowDiagram}</div>
        <figcaption>The coordination path never carries the root, owner private key, segment keys or file-shard payloads. A share link is the deliberate exception for access: its signed encrypted capability grants only the named file version's segment keys, protected by a recipient secret in the URL fragment.</figcaption>
      </figure>
      ${keyCustodyProcessDiagram}
      <p><strong>Security consequence:</strong> a coordination-database leak or one encrypted shard does not reveal vault secrets. By contrast, anyone who obtains the 24-word Mesh Key, compromises same-origin application code through XSS, controls a privileged browser extension, or can read the local browser profile may obtain the root and derived secrets. The current browser storage is not a hardware-backed key vault.</p>`,
    },
    {
      id: "android-background",
      title: "Android availability",
      body: `<p>The optional Android build uses the same hosted vault interface, but can keep this device available through a native foreground service after the app is closed or the screen turns off. This is a platform capability, not a separate kind of storage node. The WebView remains the authorised vault: it creates or restores the Mesh Key, encrypts readable files, derives segment keys, decrypts downloads and signs owner operations. The native worker is deliberately less trusted and does not receive those secrets.</p>
      ${nativeBackgroundProcessDiagram}
      <p>The bridge accepts only public runtime values: protocol version, temporary Supabase first-contact configuration, Patient Zero genesis and verified responder public keys, Vault ID, public node label, coarse country or region, quotas and ICE configuration. The Java worker recursively rejects configuration keys that look like a Mesh Key, root seed, private key, file key, segment key, metadata key or deduplication key, and its status contract always reports <code>keysAccepted: false</code>.</p>
      <p>The native node creates its own Ed25519 device identity. Shards are hash-checked before an atomic local commit; manifests and control records are verified and bounded before caching. Its native identity seed is protected with Android Keystore AES-GCM. The temporary anonymous first-contact token is erased after the first verified mesh peer. Shards remain in the app's private files directory with SQLite metadata. A bounded partial Wake Lock is acquired only during an active shard transfer and expires after two minutes.</p>
      <p><strong>Availability boundary:</strong> after the user presses Start, Android runs a foreground service with a persistent notification and can restart an enabled node after device boot. This is substantially more durable than a browser tab or PWA when the screen is off. It is still subject to Android Doze, network loss, force-stop, battery restrictions and phone-vendor process policies. The app therefore reports actual service and peer state rather than promising that a node can never be stopped.</p>`,
    },
    {
      id: "overview",
      title: "What TheMeshVault actually stores",
      body: `<p>TheMeshVault stores a file by spreading encrypted pieces across other participating devices. The whole readable file is not copied to every device and is not uploaded to Supabase Storage. Your browser is the machine that cuts, encrypts, distributes and later rebuilds it.</p>
      <aside class="architecture-units"><strong>What does MiB mean?</strong><p><b>MB</b> is the familiar decimal unit: 1 MB is 1,000,000 bytes. <b>MiB</b> is the exact binary unit used by computers: 1 MiB is 1,048,576 bytes. The current processing block is 8 MiB, which is 8,388,608 bytes or about 8.4 MB. The rest of this page uses ordinary MB for readability and gives exact binary values only where they matter.</p></aside>
      ${uploadProtectionProcessDiagram}
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
      <p>After all three block groups are placed, the signed map is retained locally and replicated through connected mesh participants. Supabase receives neither that map nor the 20 MB video. To restore the file, a browser with the Mesh Key retrieves any six valid shards from <em>each</em> group, reverses the process and checks the final file hash.</p>
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
      body: `<p>These are the limits enforced by the current release. They are product boundaries, not promises about what every network or phone can achieve.</p>
      <div class="architecture-limit-grid">
        <article><span>Upload</span><strong>100 MB per file</strong><p>Exactly 100,000,000 bytes. Larger files are rejected before encryption starts. Multiple selected files are processed one at a time.</p></article>
        <article><span>File types</span><strong>No extension restriction</strong><p>Any file type may be encrypted. Already-compressed formats such as JPEG, PNG, MP4, PDF and ZIP skip gzip.</p></article>
        <article><span>Total vault</span><strong>No fixed account quota</strong><p>Usable storage is limited by the capacity currently offered by reachable mesh devices, not by a simulated cloud allowance.</p></article>
        <article><span>This device contributes</span><strong>0 to 2,000 GiB</strong><p>The default is 1 GiB and the amount is entered directly in Settings. An 800 GB limit is therefore valid, but the operating system, browser or available disk space may enforce a lower practical quota.</p></article>
        <article><span>Processing block</span><strong>8 MiB maximum</strong><p>8,388,608 bytes per segment. Network transport then splits shards into 32 KiB packets.</p></article>
        <article><span>Recovery pieces</span><strong>16 shards maximum</strong><p>Automatic reaches 10+6 at sixteen independent devices. Balanced can use 12+4 at the same size.</p></article>
        <article><span>Share links</span><strong>24 hours</strong><p>The current Drive interface creates one-day links. Deleting the file revokes known links. Password and download-limit fields exist in the protocol but are not exposed in the current Drive interface.</p></article>
        <article><span>Long operation</span><strong>6-hour timeout</strong><p>An individual upload or recovery task is cancelled if it cannot finish within six hours.</p></article>
        <article><span>Backbone cache</span><strong>25 MiB to 1 GiB</strong><p>100 MiB by default. Every node keeps a smaller bounded control cache; Backbone mode opts into a larger, more available cache. Node reminders remain optional.</p></article>
        <article><span>Compatibility</span><strong>Protocol v3 only</strong><p>The pre-release v3 cutover reset app-owned test data. Earlier Mesh Key files, manifests and storage formats are not imported or accepted.</p></article>
      </div>
      <details class="architecture-timers"><summary>Network maintenance timings</summary><p>A node is treated as stale after two minutes without a report. Storage proofs are considered fresh for 30 minutes. A missing placement receives a 30-minute repair grace period, and returning surplus copies receive a five-minute reconciliation grace period. Night Node leases last 90 seconds and renew every 30 seconds while the browser remains able to run.</p></details>
      <details class="architecture-timers"><summary>How optional node reminders work</summary><p>Participation and Backbone status are decided by renewable leases, not notification permission. If reminders are enabled, TheMeshVault stores a protected browser push endpoint and a selected buddy can request a notification through the Edge Function. Tapping it reopens Night Node; the notification cannot run WebRTC by itself.</p></details>
      <details class="architecture-timers"><summary>How the installed app refreshes mesh state</summary><p>When an installed PWA or ordinary tab becomes visible, the client resumes its local heartbeat and reuses recently discovered peers. A completely new local profile may briefly use Supabase to verify the public authority chain from the app's genesis key and reach its exact current Patient Zero responder. After the first verified peer, discovery, signaling, presence and Live Mesh refreshes use cached or connected mesh participants and invites; the local bootstrap-complete marker prevents Supabase from reopening. Windows in one browser profile share discovery metadata but own separate WebRTC links. This foreground refresh cannot keep a suspended mobile browser alive.</p></details>`,
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
          <article class="network-node network-node--coordination"><span>Control mesh</span><strong>Participants and Patient Zero</strong><small>Online nodes relay bounded signed or encrypted manifests, placements, repair records and peer context. Supabase introduces a new profile to Patient Zero once; it is not the continuing control database.</small></article>
          <div class="network-route network-route--relay"><span>Fallback relay</span><i aria-hidden="true">↝</i><small>Encrypted WebRTC traffic only</small></div>
          <article class="network-node network-node--turn"><span>TURN, when needed</span><strong>Relays an encrypted connection</strong><small>Can observe endpoints and traffic volume, but does not receive vault keys.</small></article>
        </div>
        <div class="architecture-boundary"><span><b>Never sent by the protocol</b>256-bit root · Mesh Key phrase · owner private key · metadata/deduplication roots · readable file bytes</span><span><b>May leave through bounded paths</b>Public keys and signed/encrypted coordination objects to mesh participants · temporary public node details and SDP/ICE to Supabase during first contact only · encrypted shard payloads to storage peers · an encrypted file-version-limited segment-key grant through an explicit share link</span></div>
        <figcaption>A new profile uses Supabase only until the signed authority chain and current Patient Zero responder are verified. Files, manifests, placements, sharing, deletion, repair and Live Mesh then remain in the peer mesh. Supabase retains the public rotation chain, never its private signing keys.</figcaption>
      </figure>
      <div class="document-table-wrap"><table><thead><tr><th>Location</th><th>What can be there</th><th>What is not intended to be there</th></tr></thead><tbody>
        <tr><td>Your browser or app vault UI</td><td>The encoded 256-bit root, separate device identity, derived owner and symmetric key material in memory, the 24-word Mesh Key while the vault is open, encrypted metadata, your private vault name, signed encrypted vault-index snapshots, an append-only signed operation queue, manifests, settings, and any encrypted shards this browser profile stores. Shards use OPFS when available with IndexedDB metadata/fallback. Local secrets rely on the browser/WebView profile and operating system for protection.</td><td>Normal storage and coordination do not send the root, Mesh Key phrase, owner private key, usable symmetric keys or readable file bytes to Supabase, Anchors, the Android native worker or storage nodes. An explicit share is the exception described below: it publishes an encrypted one-file key grant whose opening secret remains in the link fragment.</td></tr>
        <tr><td>Android native node, when enabled</td><td>A separate native device identity; Android-Keystore-protected device seed; a temporary first-contact session; public node configuration; SQLite indexes; hash-verified encrypted shards; and bounded verified manifest/control caches in private app storage.</td><td>The bridge and native worker do not receive the Mesh Key, root seed, owner private key, readable file bytes or usable metadata, deduplication or segment keys. Its first-contact token is erased after a verified peer. Native storage is separate from Chrome, Brave or another browser profile.</td></tr>
        <tr><td>Storage peers and Backbones</td><td>All online nodes can retain a small bounded set of verified control records. A storage peer can also hold content-addressed encrypted shard payloads. An opt-in Backbone keeps a larger control cache; the standalone server can additionally store real opaque shards under configured quotas.</td><td>The control cache receives no root/private/segment keys or readable files. A browser or server that contributes shard storage does so under a separate storage quota. Neither role becomes vault authority.</td></tr>
        <tr><td>Supabase first-contact gate</td><td>A temporary anonymous-session ID and node row, the targeted Patient Zero lookup, and transient offer/answer/ICE messages. Patient Zero alone keeps a minimal row, signaling listener and sparse heartbeat for future arrivals.</td><td>No files, shards, vault profile/index, operations, manifests, segment or placement records, repair/deletion state, capabilities, private keys or continuing network overview. The ordinary profile deletes its row best-effort and closes its local session after verification.</td></tr>
        <tr><td>TURN relay, when required</td><td>Encrypted WebRTC traffic and connection metadata while relaying a peer connection.</td><td>The relay is not given the vault's decryption key.</td></tr>
        <tr><td>Share link</td><td>The owner explicitly creates a signed capability whose encrypted payload contains only the segment-key grants needed for one named file version. The URL fragment carries the recipient secret used to open that payload and is not sent in a normal HTTP request. Expiry, revocation, optional password and download limits bound coordinated redemption.</td><td>The root and owner private key are never shared. A complete active link is still a bearer secret: anyone who receives it may access the granted file until the capability expires or is revoked, and revocation cannot erase plaintext already downloaded.</td></tr>
      </tbody></table></div>`,
    },
    {
      id: "supabase-backbone",
      title: "Supabase: purpose and data",
      body: `<p><strong>For an ordinary browser, PWA or Android profile, Supabase is used only during a bounded first-contact phase in a disconnected app lifecycle.</strong> The profile creates a temporary anonymous session, verifies the small public authority chain from the genesis key in the app, publishes a temporary public node row, asks for the exact current Patient Zero responder, and exchanges the SDP/ICE data needed to form that direct WebRTC connection. It does not query a general node directory.</p>
      <figure class="architecture-figure architecture-figure--backbone" aria-labelledby="backbone-title">
        <div class="architecture-figure__head"><div><span>Trust and availability</span><strong id="backbone-title">Ownership stays local; Supabase opens one door</strong></div><em>These are different responsibilities</em></div>
        <div class="backbone-grid">
          <article class="backbone-card backbone-card--authority"><span>Local authority</span><strong>Your authorised browser</strong><ul><li>Creates and stores the 256-bit root</li><li>Shows its 24-word BIP39 recovery form</li><li>Derives the Ed25519 owner and symmetric hierarchy</li><li>Encrypts, signs, decrypts and verifies</li></ul><b>Supabase cannot replace this authority.</b></article>
          <article class="backbone-card backbone-card--fast"><span>One-time introduction</span><strong>Supabase</strong><ul><li>Temporary anonymous Auth session</li><li>Public authority chain verified from genesis</li><li>Temporary public node row</li><li>Exact current Patient Zero lookup</li><li>Recipient-scoped SDP/ICE signaling</li><li>Best-effort row deletion and local logout</li></ul><b>No vault data, file metadata or shard payloads.</b></article>
           <article class="backbone-card backbone-card--fallback"><span>Continuing distributed path</span><strong>Patient Zero and mesh participants</strong><ul><li>The direct peer proves the chain-authorised responder identity</li><li>Peer context spreads through authenticated mesh connections</li><li>Manifests, placements and repairs stay in the mesh</li><li>The ordinary profile cannot silently reopen Supabase</li></ul><b>All normal operation continues peer-to-peer.</b></article>
        </div>
        <div class="backbone-outage"><span><b>Ordinary profile</b>After the first verified peer, the temporary row, session and Realtime channel are closed for the rest of that running lifecycle.</span><span><b>Patient Zero</b>The sole exception keeps a minimal listener and sparse heartbeat so a disconnected installation has somewhere to knock.</span><span><b>On a later disconnected start</b>If no cached route is reachable, the profile may use one new bounded first-contact window. Continuous Supabase discovery remains disabled.</span></div>
        <figcaption>“No account required” means no named account is requested. First contact still creates pseudonymous technical data and provider network logs, so it is not a promise of legal or network anonymity.</figcaption>
      </figure>
      ${coldStartProcessDiagram}
      ${supabaseDataDisclosure}
      <p><strong>Cold-start boundary:</strong> entering the 24 words reconstructs the same identity and key hierarchy locally; Supabase is never queried for secret material. Network discovery is separate. The public Patient Zero trust key is deployment data, while its private device key never belongs in source code or Supabase.</p>`,
    },
    {
      id: "identity",
      title: "Identity and control",
      body: `<p>A new vault creates one 256-bit random root in the browser and encodes it as a 24-word BIP39 Mesh Key. Domain-separated deterministic derivations produce the Ed25519 owner identity, private discovery identifier, metadata key, deduplication key and segment-key root. The Vault ID is SHA-256 of the raw owner public key. Sensitive operations are signed, and clients verify signatures and hashes instead of trusting a coordination database row merely because it exists.</p>
      <p>The current catalog has an encrypted, owner-signed vault-index snapshot and a local append-only signed operation queue. The browser reads the newest valid index from local state or connected mesh participants. Folder creation, metadata moves, uploads, manifests and placements remain local/mesh and can replay idempotently.</p>
      <p>The phrase itself is not uploaded. The 24-word phrase and a complete protocol-v3 Mesh Key file carry the same root secret. Typing the phrase or importing that file reconstructs the same root and identity locally. Possession of either form grants vault authority and it must be protected as a bearer secret. A disconnected profile can use the bounded Patient Zero introduction before continuing through the mesh. File recovery still requires a signed manifest and at least K valid reachable shards per segment.</p>
      <p><strong>Compatibility boundary:</strong> this release accepts protocol v3 identities, key files, manifests, capabilities and storage records only. The v3 rollout deliberately reset the app-owned pre-release test schema and local v1/v2 stores rather than migrating them. An earlier key file or recovery format cannot open a v3 vault.</p>
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
      ${recoveryVerificationProcessDiagram}
      <p>When placements become unavailable, the repair coordinator can recreate missing shards from a recoverable segment and place replacements on eligible nodes. A device-signed repair advisory is gossiped and retained by connected control participants. Candidate repairers publish short signed leases and deterministically select one winner; placement changes are signed and reconciled through the mesh. Returning surplus copies are reconciled after a grace period and do not increase the logical erasure profile.</p>`,
    },
    {
      id: "deletion",
      title: "Deletion",
      body: `<p>Deleting a file revokes known share capabilities, tombstones the local/mesh vault record and creates owner-signed deletion orders for known shard holders. Connected control participants retain and forward the orders. A returning holder verifies the owner signature and node binding before erasing, then publishes a device-signed acknowledgement that the owner browser verifies before finalising the placement. An offline node cannot receive an instruction until it reconnects, so an unreadable encrypted shard may remain on that device in the meantime.</p>
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
        <li>Browser storage can be cleared by the user, browser or operating system. Mobile browsers may suspend or terminate background tabs despite Wake Lock, PWA, sync or push assistance. The optional Android foreground service improves screen-off availability but Android may still constrain or stop it.</li>
        <li>The randomness guarantee depends on the browser and operating system correctly implementing <code>crypto.getRandomValues()</code>. The protocol avoids predictable application-level generators but cannot repair a compromised CSPRNG or endpoint.</li>
        <li>Traffic analysis, IP-address privacy and loss of every Mesh Key copy are outside the protection offered by shard encryption.</li>
        <li>A disconnected profile may depend on Supabase for one bounded introduction to the current Patient Zero responder during that app lifecycle. It verifies the public authority chain from the genesis key already in the app. Patient Zero itself keeps a minimal hosted listener and heartbeat. If that first-contact gate is unavailable, a profile with no reachable cached peer or invite cannot enter the mesh.</li>
        <li>This is an early implementation. Independent security review and wider hostile-network testing remain necessary before describing it as suitable for high-risk or regulated data.</li>
      </ul>`,
    },
  ],
};

const terms = {
  id: "terms",
  kind: "Legal",
  title: "Terms of Service",
  summary: "The participation rules for creating a no-account vault, contributing device storage, handling keys, and using a peer-powered service whose ordinary operation stays in the mesh.",
  version: LEGAL_VERSIONS.terms,
  updated: "16 August 2026",
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
      body: `<p>TheMeshVault is a no-account, cryptographically owned peer-to-peer storage protocol and application. It encrypts files locally and distributes recovery shards across participating devices. Every online node can exchange bounded signed or encrypted control records. A disconnected local profile may use a temporary Supabase session to load a public authority chain, verify it from the immutable genesis key in the app, locate the exact current Patient Zero responder and negotiate a direct WebRTC connection. Once that identity is verified, the ordinary profile closes that hosted path for the rest of the running lifecycle and continues through authenticated mesh peers.</p>
      <p>It is not a guaranteed backup service. Recoverability depends on verified independent placements, reachable devices and possession of the Mesh Key. Files, shards, manifests, placements, sharing, deletion and repair state are handled locally and through the mesh, not stored as continuing Supabase application data. Patient Zero is the sole intentional exception: while operator-enabled, it retains a minimal Supabase listener and sparse heartbeat so a brand-new profile has somewhere to make first contact.</p>`,
    },
    {
      id: "eligibility",
      title: "3. Eligibility",
      body: `<p>You must have legal capacity to accept these Terms. A final minimum age and any country restrictions must be established before public release. If you use the service for an organisation, you represent that you are authorised to bind that organisation.</p>`,
    },
    {
      id: "keys",
      title: "4. Vault ownership and Mesh Keys",
      body: `<p>Your 24-word protocol-v3 Mesh Key controls a no-account vault. A complete v3 Mesh Key file contains the same root secret, so either form must be protected like a private key. The phrase or file reconstructs the same Ed25519 owner identity locally; neither Supabase nor an Anchor can reset, recover or replace it. An optional linked account or anonymous Supabase session does not become the cryptographic owner of a vault.</p>
      <p>Restoring that identity is not the same as restoring every file. The new browser must also discover the signed manifest and reach at least the required number of valid shards for every segment. Earlier pre-v3 keys and storage formats are not supported by this release.</p>`,
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
      body: `<p>If you run a storage, Night, Backbone or dedicated server node, you offer capacity directly to the peer network and authorise the protocol to use up to the limit you select for encrypted shards and bounded control data. Every online node participates in the small control layer automatically; Backbone is a separate availability opt-in. You can pause the node or clear its local storage. The Android app can continue through a user-started foreground service; Android may still stop or restrict it.</p>
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
      body: `<p>The current build uses Supabase Auth, narrow Postgres RPCs and Realtime for the bounded first-contact phase. An ordinary profile creates a temporary anonymous technical session, verifies the small public Patient Zero authority chain from the genesis key shipped in the app, publishes a temporary public node row, looks up only the chain's current responder and exchanges recipient-scoped SDP/ICE messages. After a verified direct peer exists, it deletes the row best-effort, clears the local session and closes Supabase for the rest of that running lifecycle. It cannot silently reopen that path for normal discovery, presence, Live Mesh, file handling or repair during that lifecycle. A later disconnected cold start may use one new bounded first-contact window.</p>
      <p>Supabase retains the current public authority state and append-only signed rotation history so a Mainframe key can change without replacing the genesis trust root. Normal rotation is authorised by the current private authority key and also proved by the successor key; emergency rotation requires the separately saved offline recovery private key. Those private keys never enter Supabase. Patient Zero remains the sole runtime hosted exception and keeps a minimal row, listener and sparse heartbeat while enabled. The app also depends on browser and operating-system vendors, internet providers, public STUN services, an optional TURN relay and optional push delivery. Public pages currently load fonts from Google Fonts and the Supabase browser library from jsDelivr. Those services can receive ordinary connection metadata and have their own terms and availability limits.</p>`,
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
      body: `<p>Material changes receive a new version and may require renewed acceptance in each browser. The active version and date are always shown at the top of this document.</p>`,
    },
  ],
};

const privacy = {
  id: "privacy",
  kind: "Legal",
  title: "Privacy Notice",
  summary: "How a no-account vault works without asking who you are, which pseudonymous technical data is still processed, and exactly what Supabase and participating peers can see.",
  version: LEGAL_VERSIONS.privacy,
  updated: "16 August 2026",
  status: "Pre-release draft",
  sections: [
    {
      id: "controller",
      title: "1. Scope and development status",
      body: `<p>This notice covers TheMeshVault's public site, browser- or app-local vault, optional Android native background node, peer-to-peer transfers, storage-node participation and the temporary Supabase first-contact gate.</p>
      <p><strong>Current production controller:</strong> Not yet designated; this is a development build.<br><strong>Future coordination-layer controller:</strong> Company or other responsible legal person to be supplied before production launch.<br><strong>Privacy contact:</strong> To be supplied before production launch.</p>
      <p>The future operator is expected to determine the purposes and means of the hosted coordination layer and to name Supabase and other contracted infrastructure providers in their correct roles. The legal role of independent peer participants depends on the actual processing and applicable law; this notice does not label every storage node as a processor of a central operator.</p>`,
    },
    {
      id: "anonymous-first",
      title: "2. What no-account access means",
      body: `<p>You can create and use a new vault without supplying a name, email address, telephone number, password or conventional user account. The cryptographic vault identity is generated locally. File contents are encrypted before distribution, and ordinary storage nodes are not given the key required to read them.</p>
      <p>During a new profile's first contact, the browser creates a temporary Supabase Auth user marked as anonymous. That technical identifier, the temporary public node details, IP-address information, user agent and timing can still distinguish a device during the bootstrap window. A private vault name remains local or encrypted within the mesh; it is not used as the public node label. TheMeshVault therefore promises <strong>no named account required</strong>, not legal or network anonymity. First-contact records and provider logs are conservatively treated as pseudonymous technical data and may remain personal data under applicable law.</p>`,
    },
    {
      id: "local-data",
      title: "3. Data kept in your browser",
      body: `<p>The app stores the encoded 256-bit root, separate device identity, recovery status, settings, encrypted names and metadata, signed manifests, operation logs, cached control objects and encrypted shards in app-scoped browser storage. It reconstructs the Ed25519 owner and domain-separated metadata, deduplication and segment-key hierarchy locally from the root. OPFS is preferred for shard bytes, with IndexedDB used for metadata and fallback storage.</p>
      <p>This data may remain until you delete it, clear site data, remove the browser profile or the browser/operating system evicts it. Normal storage and coordination do not send the root, 24-word Mesh Key, readable file contents, owner private key or usable derived symmetric keys to Supabase, mesh participants or storage nodes. Protocol v3 has no hosted recovery envelope or wrapped segment-key store. If you deliberately create a share link, its one-file encrypted grant is distributed through the mesh; only the bearer secret in the URL fragment can open it. A phrase or complete v3 Mesh Key file reconstructs identity locally; network discovery remains a separate step.</p>`,
    },
    {
      id: "android-local-data",
      title: "4. Android background-node data",
      body: `<p>The optional Android app has two separate local stores. Its hosted WebView keeps the vault UI and Mesh Key in that app's WebView profile. Its native foreground service has a separate private database and files directory for opaque encrypted shards and bounded signed or encrypted coordination records. Installing the Android app does not import Chrome, Brave, Edge or Safari site data, and those stores cannot be silently shared.</p>
      <p>The native service creates a separate random device identity. Its private identity seed is encrypted locally with an Android Keystore key. A temporary anonymous Supabase token may exist only while the native profile performs its first contact and is erased after a verified mesh peer is established. It stores public configuration such as Vault ID, node label, capacity, coarse location, the Patient Zero genesis trust root and verified current responder identity. It does not accept the Mesh Key, root seed, owner private key, file content or usable derived file keys.</p>
      <p>During first contact, Supabase receives a separate temporary anonymous Auth session and native node row with the same categories of pseudonymous bootstrap data described below. This can distinguish that app installation during the bootstrap window even though it does not contain a civil identity. Normal background-node operation then uses the mesh and does not maintain a Supabase session. Stopping the node ends active participation; removing Android pieces deletes its local shard/control store.</p>`,
    },
    {
      id: "mesh-data",
      title: "5. What other mesh devices receive",
      body: `<p>A storage node receives content-addressed encrypted shards, hashes needed to verify them and limited protocol information required to store, retrieve, repair or delete those shards. Connected peers can also see node and device identifiers, connection timing, requested shard hashes, transfer sizes, capacity claims, verification results and coarse failure-domain information.</p>
      <p>An ordinary storage node can see the public label chosen for your browser node, but should not receive your private vault name, email address, Mesh Key, readable filename or complete plaintext file. Encrypted shard bytes may nevertheless originate from a file that contains personal information; encryption makes that information unintelligible to a node that lacks the key.</p>`,
    },
    {
      id: "coordination-data",
      title: "6. What Supabase receives",
      body: `<p>Supabase is a narrow first-contact gate, not the continuing mesh database and not an analytics service. The exact application-data boundary, visibility and conservative privacy classification are shown below.</p>
      ${supabaseDataDisclosure}
      <p>Stable identifiers and related activity can single out the same vault or device. They are therefore described as <strong>pseudonymous technical data</strong>, not promised to be irreversibly anonymous.</p>
      <p>For an ordinary browser, PWA or Android profile, the permitted calls are limited to temporary anonymous Auth, reading and verifying the public authority chain, temporary node registration, exact current-responder discovery and recipient-scoped WebRTC signaling. Once Patient Zero or another verified mesh peer is connected, the local bootstrap-complete marker prevents normal operation from reopening Supabase. Files, manifests, segment and shard placements, sharing, deletion, repair, audit state, presence and Live Mesh use local or peer-mesh data instead.</p>
      <p>Patient Zero is the only deliberate continuing exception. While enabled by the deployment operator, it keeps a minimal hosted node row, signaling listener and sparse heartbeat so completely new profiles can reach the mesh.</p>`,
    },
    {
      id: "network-data",
      title: "7. IP addresses, location and external connections",
      body: `<p>WebRTC peers exchange connection-negotiation data and may learn the IP-address information needed to establish a direct connection. Public STUN services help determine network reachability. A TURN provider can observe connection endpoints, timestamps and encrypted traffic volume when it relays traffic. During first contact, Supabase receives the transient SDP/ICE signaling needed to connect the new profile specifically to Patient Zero. Supabase and normal web infrastructure can also receive IP address, user-agent and request timing in ordinary server logs.</p>
      <p>Approximate country location may be derived locally after browser location permission or from an edge/network hint. The storage schema is designed for coarse country or region and does not intend to retain precise coordinates.</p>
      <p>The current public pages request fonts from Google Fonts and the Supabase browser library from jsDelivr. The current WebRTC configuration can contact Google and Cloudflare STUN services. A production deployment should reassess or self-host these dependencies where practical and name the final providers in this notice.</p>`,
    },
    {
      id: "purposes",
      title: "8. Why the data is used",
      body: `<div class="document-table-wrap"><table><thead><tr><th>Purpose</th><th>Typical data</th><th>Expected legal basis</th></tr></thead><tbody>
        <tr><td>Open the first mesh connection</td><td>Temporary anonymous Supabase session, public signed authority chain, temporary public node details, exact current Patient Zero lookup and transient SDP/ICE</td><td>Performance of the service contract</td></tr>
        <tr><td>Provide the vault and mesh after first contact</td><td>Public-key parts, signed or encrypted metadata, manifests, placements, signaling, transfers and recovery state exchanged locally or between participating peers</td><td>Performance of the service contract</td></tr>
        <tr><td>Keep the network reliable and secure</td><td>Lease, capacity, reliability, repair, deletion and audit events</td><td>Contract and legitimate interests in security and integrity</td></tr>
        <tr><td>Optional account features</td><td>Email address, account identifier and preferences</td><td>Contract; consent only for genuinely optional communications where required</td></tr>
        <tr><td>Meet legal obligations</td><td>Records required by applicable law</td><td>Legal obligation</td></tr>
      </tbody></table></div>
      <p>This table records the intended production model. The future controller must validate each legal basis before launch. Acknowledging this Privacy Notice is not blanket consent to marketing, analytics or unrelated processing.</p>`,
    },
    {
      id: "recipients",
      title: "9. Recipients and roles",
      body: `<p>Depending on the feature used, limited data can be received by participating peer devices, Supabase during the bounded first-contact phase, public STUN or configured TURN providers, hosting and CDN providers, browser and operating-system vendors, optional push-delivery services, and authorities where disclosure is legally required.</p>
      <p>Participating peers receive encrypted shard material and protocol metadata as independent network participants. The production notice must identify the future controller, its contracted processors and subprocessors, processing locations, retention commitments and safeguards for any transfers outside the EU/EEA.</p>`,
    },
    {
      id: "retention",
      title: "10. Retention and deletion",
      body: `<p>After first contact, protocol v3 signaling and control use mesh providers rather than automatic Supabase Realtime fallback. Browser-local data remains under the browser profile's storage lifecycle. Mesh control records expire by type: repair leases after about two minutes, repair requests after about 30 minutes, and signed indexes, operations, deletion records and completion records after up to 30 days in bounded caches. An ordinary profile asks to delete its temporary Supabase node row, clears its local anonymous session and closes Realtime after verification. Infrastructure logs and backups can follow the provider's separate lifecycle. Patient Zero's minimal row remains only while that operator role is enabled.</p>
      <p>The pre-release v3 cutover removed the former app-owned coordination tables and instructs current clients to remove known v1/v2 local stores. It does not promise immediate deletion from provider backups, infrastructure logs or an offline independent browser that has not run the reset. Current clients reject those earlier identities and storage formats rather than migrating them.</p>
      <p>A file deletion queues signed erase orders. Connected copies can be removed promptly, while an offline browser may retain an unreadable encrypted shard until it reconnects or its local site data is cleared. Some operational records may be retained where necessary for security, dispute handling or legal compliance.</p>`,
    },
    {
      id: "rights",
      title: "11. Your choices and rights",
      body: `<p>Depending on the applicable law and legal basis, you may have rights to information, access, correction, deletion, restriction, portability, objection, withdrawal of consent and complaint to a supervisory authority.</p>
      <p>You can use the core vault without linking an account, deny optional browser location permission, stop contributing capacity, revoke share links, delete files and clear this browser's site data. Some actions cannot reach an offline independent node until it reconnects.</p>
      <p>A no-account vault may contain no name, email address or conventional account identifier. Supabase can nevertheless hold a temporary pseudonymous Auth identifier and bootstrap record, and provider logs may retain connection metadata. A valid device signature or the temporary identifier may therefore be needed to locate a record safely and prevent disclosure or modification at another person's request. The future controller must provide a working rights-request channel before production launch.</p>`,
    },
    {
      id: "security",
      title: "12. Security and limits",
      body: `<p>The service uses authenticated encryption, content hashes, signed manifests and operations, app-scoped browser storage and row-level database controls. The coordination database is treated as an untrusted cache for sensitive protocol claims; clients are expected to verify signatures and hashes.</p>
      <p>No technical measure eliminates all risk, and TheMeshVault does not claim network anonymity. The local root is not hardware-backed: XSS or other code executing in the app origin, a privileged extension, an unlocked endpoint, operating-system compromise or direct access to the browser profile may expose it and any available plaintext. Keep the 24-word Mesh Key offline, protect authorised devices, avoid exposing complete share links and keep independent copies of important files during the pre-release stage.</p>`,
    },
    {
      id: "children-changes",
      title: "13. Children, changes and contact",
      body: `<p>The target age and any parental-consent process must be set before release. The service should not knowingly process a child's data on a consent basis without the safeguards required in the child's country.</p>
      <p>Material changes receive a new version date and may require a new acknowledgement. The active version and date are always shown at the top of this notice. Users in Sweden can contact Integritetsskyddsmyndigheten (IMY) about data-protection concerns.</p>`,
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
