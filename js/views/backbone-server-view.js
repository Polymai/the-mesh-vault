const packagePath = "downloads/themeshvault-backbone-host-v3.1.0.zip";

export function renderBackboneServerView() {
  return `<section class="view-head view-head--compact server-guide-head"><div><a class="back-link" href="#/anchor">← Back to Backbone</a><span class="eyebrow">Optional server</span><h1>Keep storage available without an open browser</h1><p>A dedicated Backbone runs on an always-on Windows or Linux computer. It stores encrypted pieces and helps devices find each other. It never receives a Mesh Key or readable file.</p></div></section>
  <section class="server-guide-summary" aria-label="What the server does"><article><strong>Stays online</strong><span>Runs separately from the browser.</span></article><article><strong>Shares disk space</strong><span>Only up to the limit you choose.</span></article><article><strong>Still one device</strong><span>Ten virtual nodes on one computer do not create ten independent copies.</span></article></section>
  <section class="panel settings-section server-guide">
    <div class="settings-section-head"><span class="eyebrow">Windows or Linux</span><h2>Install in five steps</h2></div>
    <ol class="server-setup-steps">
      <li><span>1</span><div><h3>Download the server</h3><p>Unzip it into a permanent folder on the computer that will stay on.</p><a class="button button--ghost" href="${packagePath}" download>Download server package</a></div></li>
      <li><span>2</span><div><h3>Install Node.js 20 or newer</h3><p>The server uses Node.js. Skip this step if <code>node --version</code> already reports version 20 or newer.</p><a class="text-button" href="https://nodejs.org/en/download" target="_blank" rel="noopener">Download Node.js</a></div></li>
      <li><span>3</span><div><h3>Create the configuration</h3><p>Return to Backbone, choose the storage folder and space limit, then download <code>backbone-host.json</code>. Move it into the unzipped server folder.</p><a class="text-button" href="#/anchor">Create configuration</a></div></li>
      <li><span>4</span><div><h3>Check and start</h3><p>Open a terminal in the server folder and run:</p><pre><code>npm install
npm run check
npm start</code></pre><button class="text-button" type="button" data-copy-server-command>Copy commands</button><span class="server-copy-status" role="status"></span></div></li>
      <li><span>5</span><div><h3>Make it reachable</h3><p>For devices on the internet, expose port 3717 through a TLS-enabled reverse proxy and use its <code>wss://</code> address in the configuration. Then pin the public key printed by the server in the deployed Backbone seed list.</p><p class="server-warning">This networking step is for experienced operators. Without a public WSS address, the server is only suitable for local testing and advertises no remote storage capacity.</p></div></li>
    </ol>
  </section>
  <section class="panel settings-section server-guide-reference">
    <div class="settings-section-head"><h2>What the settings mean</h2></div>
    <dl><div><dt>Storage folder</dt><dd>The real folder where opaque encrypted pieces are written. TheMeshVault never formats a disk.</dd></div><div><dt>Total space</dt><dd>The maximum combined storage used by all virtual nodes on this computer.</dd></div><div><dt>Virtual nodes</dt><dd>Separate work queues for testing or capacity management. They all remain one physical failure domain.</dd></div><div><dt>Public server address</dt><dd>A secure WebSocket endpoint beginning with <code>wss://</code>. It allows remote devices to connect directly.</dd></div></dl>
    <details class="settings-technical"><summary>Run automatically on Windows</summary><p>After testing the foreground process, open PowerShell as Administrator and run <code>.\\install-backbone-service.ps1 -ConfigPath .\\backbone-host.json</code>. This creates one startup task. Use <code>.\\uninstall-backbone-service.ps1</code> to remove only that task.</p></details>
  </section>`;
}

export function bindBackboneServerView() {
  document.querySelector("[data-copy-server-command]")?.addEventListener("click", async () => {
    const status = document.querySelector(".server-copy-status");
    try {
      await navigator.clipboard.writeText("npm install\nnpm run check\nnpm start");
      if (status) status.textContent = "Commands copied.";
    } catch {
      if (status) status.textContent = "Select and copy the commands above.";
    }
  });
}
