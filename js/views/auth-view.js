export function renderLanding() {
  return `<section class="hero"><div class="hero-media" aria-hidden="true"></div><div class="hero-content"><span class="eyebrow">Private storage from spare devices</span><h1>Your files. Encrypted, split and stored across the mesh.</h1><p>Use TheMeshVault like a cloud drive. Only your Mesh Key can put the protected pieces back together.</p><div class="hero-actions"><a class="button" href="#/onboarding">Create my vault</a><a class="button button--ghost" href="#/security">How it works</a></div><div class="proof-row"><span>No named account required</span><span>No central file copy</span><span>Byte-exact recovery checks</span></div></div></section>
  <section id="how-it-works" class="landing-simple"><div class="landing-simple__head"><div><span class="eyebrow">Simple on the surface</span><h2>Store a file. The mesh handles the rest.</h2></div><a href="#/security">See every technical detail →</a></div><div class="landing-steps">
    <article><span>01</span><h3>Encrypt</h3><p>Your browser locks the file before it leaves your device.</p></article>
    <article><span>02</span><h3>Distribute</h3><p>Protected recovery pieces are verified across separate devices.</p></article>
    <article><span>03</span><h3>Recover</h3><p>Your Mesh Key rebuilds the file and verifies every byte.</p></article>
  </div></section>
  <section class="trust-band landing-node-callout"><div><span class="eyebrow">A spare device can help</span><h2>Turn unused storage into part of the mesh.</h2></div><a class="button button--dark" href="#/onboarding">Contribute storage</a></section>
  <section class="landing-final"><div><strong>Want to inspect the system first?</strong><span>See exactly what each device, peer and coordination service can access.</span></div><a href="#/security">Security & Architecture →</a></section>`;
}
