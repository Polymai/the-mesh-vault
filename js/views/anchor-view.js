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
    ? `<strong>Anchor is off.</strong>`
    : anchor.status === "paused"
      ? `<strong>Paused in the background.</strong> Return to this tab to resume.`
    : connectedAnchors
      ? `<strong>Running.</strong> ${connectedAnchors} Anchor peer${connectedAnchors === 1 ? "" : "s"} connected.`
      : `<strong>Running.</strong> Waiting for another Anchor.`;
  return `<section class="view-head view-head--compact"><div><h1>Anchor</h1></div><span class="status-pill status-pill--${tone}">${statusLabel}</span></section>
  <section class="panel settings-section anchor-panel">
    <form data-anchor-form>
      <label><span>Public node name</span><input name="anchorLabel" maxlength="80" value="${esc(anchor.nodeName || "Browser node")}" required><small>Visible to other devices in Live Mesh.</small></label>
      <label class="range-label"><span><strong>Control cache</strong><output data-anchor-cache-output>${cacheMb} MB</output></span><input type="range" name="cacheMb" min="25" max="1024" step="25" value="${cacheMb}"></label>
      <label class="anchor-switch"><input type="checkbox" name="enabled" ${anchor.enabled ? "checked" : ""}><span><strong>Run as an Anchor</strong><small>Keep this tab open.</small></span></label>
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
