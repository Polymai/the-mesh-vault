export function renderLanding() {
  return `<section class="hero landing-hero"><div class="hero-media" aria-hidden="true"></div><div class="hero-content"><span class="eyebrow">Private cloud storage</span><h1>A private cloud, built from spare devices.</h1><p>Store files like a cloud drive. TheMeshVault encrypts them and spreads protected pieces across participating devices.</p><div class="hero-actions"><a class="button" href="#/onboarding">Create my vault</a><a class="button button--ghost" href="#/home" data-scroll-target="mesh-in-one-look">See how it works</a></div><div class="proof-row" aria-label="Key benefits"><span>No account required</span><span>No central file copy</span><span>Mesh Key controls access</span></div></div></section>
  <section id="mesh-in-one-look" class="mesh-story" aria-labelledby="mesh-story-title">
    <header><span class="eyebrow">The whole idea</span><h2 id="mesh-story-title">One file. Many protected pieces.</h2></header>
    <div class="mesh-story__flow" aria-label="Your file becomes encrypted pieces stored on separate devices">
      <div class="mesh-story__stage"><span class="mesh-story__file" aria-hidden="true"></span><strong>Your file</strong></div>
      <i class="mesh-story__arrow" aria-hidden="true"></i>
      <div class="mesh-story__stage"><span class="mesh-story__shards" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><strong>Encrypted pieces</strong></div>
      <i class="mesh-story__arrow" aria-hidden="true"></i>
      <div class="mesh-story__stage"><span class="mesh-story__devices" aria-hidden="true"><i></i><i></i><i></i></span><strong>Separate devices</strong></div>
    </div>
    <footer><strong>Your Mesh Key opens the vault. Enough pieces put the file back together.</strong><a href="#/security">Security & Architecture <span aria-hidden="true">→</span></a></footer>
  </section>
  <section class="landing-paths" aria-labelledby="landing-paths-title">
    <header><span class="eyebrow">Join the mesh</span><h2 id="landing-paths-title">Choose what you want to do.</h2></header>
    <div class="landing-paths__grid">
      <article><span>01</span><div><h3>Store my files</h3><p>Create a private vault.</p></div><a class="button" href="#/onboarding">Create my vault</a></article>
      <article><span>02</span><div><h3>Share spare space</h3><p>Let this device strengthen the mesh.</p></div><a class="button button--ghost" href="#/onboarding">Contribute storage</a></article>
    </div>
  </section>
  <section class="landing-assurance"><strong>Files leave your browser encrypted.</strong><a href="#/security">See exactly how <span aria-hidden="true">→</span></a></section>`;
}
