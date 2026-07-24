const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

export function renderAnchorView(state) {
  const anchor = state.anchor || {};
  const cacheMb = Math.round(Number(anchor.cacheLimitBytes || 104857600) / 1048576);
  const usedMb = Math.round(Number(anchor.bytesUsed || 0) / 104857.6) / 10;
  const running = !!anchor.enabled && anchor.status !== "paused";
  const statusLabel = !anchor.enabled ? "Off" : anchor.status === "paused" ? "Paused in background" : "Running";
  const tone = running ? "safe" : anchor.status === "paused" ? "warning" : "neutral";
  const connectedAnchors = Number(anchor.connectedAnchors || 0);
  const peerLabel = connectedAnchors ? `${connectedAnchors} connected` : "No peer Anchor";
  const readiness = anchor.status === "paused" ? "Return to this tab" : anchor.warmIndependent ? "Ready" : connectedAnchors ? "Keep this tab awake" : "Needs another Anchor";
  const assurance = !anchor.enabled
    ? `<strong>Anchor mode is off.</strong> Enable it above when you want this browser to help keep mesh control information available.`
    : anchor.status === "paused"
      ? `<strong>Anchor mode is enabled, but this tab is in the background.</strong> The browser may pause its live connections. Return to this tab to resume its active Anchor session.`
    : connectedAnchors
      ? `<strong>This Anchor is running with a peer.</strong> ${connectedAnchors} other Anchor${connectedAnchors === 1 ? " is" : "s are"} connected now. ${anchor.warmIndependent ? "The live peer path and Wake Lock are ready." : "Keep this tab visible so its live peer path remains available."}`
      : `<strong>This Anchor is running.</strong> No other Anchor is connected yet, so its control records do not currently have a live Anchor replica. That is expected in a one-Anchor mesh; another enabled Anchor will connect automatically when discovered.`;
  return `<section class="view-head"><div><span class="eyebrow">Mesh control layer</span><h1>Anchor</h1><p>Run this browser as an Anchor to keep peer discovery and recovery information available when the main coordination service cannot be reached.</p></div><span class="status-pill status-pill--${tone}">${statusLabel}</span></section>
  <section class="panel settings-section anchor-panel">
    <div class="settings-section-head"><span class="eyebrow">This browser</span><h2>Run as an Anchor</h2><p>An Anchor keeps signed manifests and peer contact information available for the mesh. Its control cache does not contain readable files, Mesh Keys or authority over another vault.</p></div>
    <form data-anchor-form>
      <label><span>Anchor name</span><input name="anchorLabel" maxlength="80" value="${esc(anchor.nodeName || "Browser node")}" required></label>
      <label class="range-label"><span><strong>Anchor cache</strong><output data-anchor-cache-output>${cacheMb} MB</output></span><input type="range" name="cacheMb" min="25" max="1024" step="25" value="${cacheMb}"><small>Maximum space for encrypted and signed network records.</small></label>
      <label class="anchor-switch"><input type="checkbox" name="enabled" ${anchor.enabled ? "checked" : ""}><span><strong>Run this browser as an Anchor</strong><small>Keep the tab open. TheMeshVault requests Wake Lock and protected browser storage where supported.</small></span></label>
      <div class="anchor-ledger">
        <span>Control records<strong>${anchor.objectCount || 0}</strong></span>
        <span>Replicated records<strong>${anchor.replicatedObjects || 0}</strong></span>
        <span>Anchor peers<strong>${peerLabel}</strong></span>
        <span>Cache used<strong>${usedMb} MB</strong></span>
        <span>Wake Lock<strong>${esc(anchor.wakeLock || "released")}</strong></span>
        <span>Outage path<strong>${readiness}</strong></span>
      </div>
      <p class="storage-assurance">${assurance}</p>
      <div class="anchor-actions"><button class="button" type="submit">Save Anchor settings</button><a class="button button--ghost" href="#/night-node">Open Night Node</a></div>
      <p class="form-status" role="status"></p>
    </form>
  </section>`;
}

export function bindAnchorView(actions) {
  const range = document.querySelector("[name='cacheMb']");
  range?.addEventListener("input", () => {
    document.querySelector("[data-anchor-cache-output]").textContent = `${range.value} MB`;
  });
  document.querySelector("[data-anchor-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = event.target.querySelector(".form-status");
    const values = new FormData(event.target);
    status.textContent = "Saving Anchor settings…";
    try {
      await actions.anchor({
        enabled: values.get("enabled") === "on",
        nodeName: values.get("anchorLabel"),
        cacheLimitBytes: Number(values.get("cacheMb")) * 1048576,
      });
      status.textContent = "Anchor settings saved.";
    } catch (error) {
      status.textContent = error.message;
    }
  });
}
