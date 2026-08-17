const packagePath = "downloads/themeshvault-backbone-host-v3.4.0.zip";

export function renderBackboneServerView() {
  return `<section class="view-head view-head--compact server-guide-head"><div><a class="back-link" href="#/anchor">← Back to Backbone</a><span class="eyebrow">Optional server</span><h1>Keep storage available without an open browser</h1><p>A dedicated Backbone runs on an always-on Windows or Linux computer. It stores encrypted pieces and helps devices find each other. It never receives a Mesh Key or readable file.</p></div></section>
  <section class="server-guide-summary" aria-label="What the server does"><article><strong>Stays online</strong><span>Runs separately from the browser.</span></article><article><strong>Shares disk space</strong><span>Only up to the limit you choose.</span></article><article><strong>Still one device</strong><span>Ten virtual nodes on one computer do not create ten independent copies.</span></article></section>
  <section class="panel settings-section server-guide">
    <div class="settings-section-head"><span class="eyebrow">Windows quick start</span><h2>Start in three steps</h2></div>
    <ol class="server-setup-steps">
      <li><span>1</span><div><h3>Download and unzip</h3><p>Keep the extracted folder on the computer that will stay on.</p><a class="button button--ghost" href="${packagePath}" download>Download server package</a></div></li>
      <li><span>2</span><div><h3>Download your configuration</h3><p>Choose the storage folder and total space on the Backbone page. Download <code>backbone-host.json</code>; the Windows launcher can find it in Downloads.</p><a class="text-button" href="#/anchor">Create configuration</a></div></li>
      <li><span>3</span><div><h3>Double-click the launcher</h3><p>Open the extracted folder and run <code>Start TheMeshVault Backbone.cmd</code>. It uses the correct folder, checks Node.js, installs the dependency and starts the server. Keep its window open.</p><p class="server-warning">If Node.js is missing, install version 20 or newer and run the launcher again.</p><a class="text-button" href="https://nodejs.org/en/download" target="_blank" rel="noopener">Download Node.js</a></div></li>
    </ol>
  </section>
  <section class="panel settings-section server-public-setup">
    <details class="settings-technical"><summary>Make the server reachable over the internet</summary><div><p>Public operation requires a TLS-enabled reverse proxy on port 3717 and a <code>wss://</code> address in the configuration. The public key printed by the server must then be pinned in the deployed Backbone seed list.</p><p class="server-warning">This is an advanced operator step. Without a public WSS address, the server is only available for local testing and advertises no remote storage capacity.</p></div></details>
  </section>
  <section class="panel settings-section server-guide-reference">
    <div class="settings-section-head"><h2>What the settings mean</h2></div>
    <dl><div><dt>Storage folder</dt><dd>The real folder where opaque encrypted pieces are written. TheMeshVault never formats a disk.</dd></div><div><dt>Total space</dt><dd>The maximum combined storage used by all virtual nodes on this computer.</dd></div><div><dt>Virtual nodes</dt><dd>Separate work queues for testing or capacity management. They all remain one physical failure domain.</dd></div><div><dt>Public server address</dt><dd>A secure WebSocket endpoint beginning with <code>wss://</code>. It allows remote devices to connect directly.</dd></div></dl>
    <details class="settings-technical"><summary>Run automatically on Windows</summary><p>After testing the foreground process, open PowerShell as Administrator and run <code>.\\install-backbone-service.ps1 -ConfigPath .\\backbone-host.json</code>. This creates one startup task. Use <code>.\\uninstall-backbone-service.ps1</code> to remove only that task.</p></details>
  </section>`;
}

export function bindBackboneServerView() {
  // The Windows package owns setup and startup so commands cannot run from the wrong directory.
}
