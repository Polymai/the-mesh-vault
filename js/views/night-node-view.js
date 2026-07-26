const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const duration = (seconds) => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${remainder}s`;
};
const lease = (milliseconds) => milliseconds > 0 ? `${Math.ceil(milliseconds / 1000)}s` : "expired";

export function renderNightNodeView(state) {
  const survival = state.survival || {};
  const anchor = state.anchor || {};
  const active = !!survival.enabled;
  return `<section class="night-node ${active ? "is-running" : ""}" aria-labelledby="night-node-title">
    <header class="night-node__head">
      <a href="#/settings" class="night-node__exit">Exit Night Node</a>
      <span class="night-node__brand">THEMESHVAULT / NIGHT NODE</span>
      <span class="night-node__pulse" aria-hidden="true"></span>
    </header>
    <div class="night-node__core">
      <span class="eyebrow">${active ? "Anchor active" : "Ready"}</span>
      <h1 id="night-node-title">${active ? "Night Node is running." : "Run an overnight Anchor."}</h1>
      ${active ? "" : "<p>Best for a plugged-in spare phone.</p>"}
      <button class="night-node__power" type="button" data-night-toggle data-enabled="${active}">
        <span>${active ? "Stop Night Node" : "Start Night Node"}</span>
        <small>${active ? "Stop the Anchor session" : "Keep this browser active"}</small>
      </button>
    </div>
    <div class="night-node__telemetry" aria-live="polite">
      <div><span>Lease</span><strong data-night-lease>${lease(survival.leaseRemainingMs)}</strong><small>${esc(survival.lifecycle || "stopped")}</small></div>
      <div><span>Continuous session</span><strong data-night-uptime>${duration(survival.uptimeSeconds)}</strong><small>this browser run</small></div>
      <div><span>Reliability</span><strong>${Math.round(Number(survival.reliabilityScore || 0) * 100)}%</strong><small>${esc(survival.reliabilityLabel || "unproven")}</small></div>
      <div><span>Anchor buddies</span><strong>${survival.buddyNodeIds?.length || 0}</strong><small>${anchor.connectedAnchors || 0} anchors connected</small></div>
      <div><span>Wake Lock</span><strong>${esc(anchor.wakeLock || "released")}</strong><small>${survival.fullscreen ? "fullscreen" : "browser window"}</small></div>
      <div><span>Wake assistance</span><strong>${esc(survival.wakeAssistance || "unknown")}</strong><small>${esc(survival.serviceWorker || "unsupported")} service worker</small></div>
    </div>
    ${survival.buddyNodeIds?.length ? `<div class="night-node__buddies"><span>Buddy fallback</span>${survival.buddyNodeIds.map((nodeId) => `<button type="button" data-wake-buddy="${esc(nodeId)}">Wake ${esc(nodeId.slice(0, 8))}…</button>`).join("")}</div>` : ""}
    <footer class="night-node__foot">
      <span>${esc(anchor.nodeName || "Browser node")}</span>
      <span>${anchor.objectCount || 0} control objects · ${Math.round(Number(state.node.usedBytes || 0) / 1048576)} MB local shards</span>
      <span>Keep power connected. Your OS may still suspend any browser.</span>
    </footer>
  </section>`;
}

export function bindNightNodeView(actions) {
  let ticker = window.setInterval(() => {
    const expires = Date.parse(actions.status().leaseExpiresAt || 0);
    const remaining = Math.max(0, expires - Date.now());
    const leaseNode = document.querySelector("[data-night-lease]");
    const uptimeNode = document.querySelector("[data-night-uptime]");
    if (leaseNode) leaseNode.textContent = lease(remaining);
    if (uptimeNode) uptimeNode.textContent = duration(actions.status().uptimeSeconds + 1);
    if (!document.querySelector(".night-node")) { window.clearInterval(ticker); ticker = null; }
  }, 1000);
  document.querySelector("[data-night-toggle]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const enabled = button.dataset.enabled === "true";
    button.disabled = true;
    try { await actions.toggle(!enabled); }
    finally { button.disabled = false; }
  });
  document.querySelectorAll("[data-wake-buddy]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await actions.wake(button.dataset.wakeBuddy); button.textContent = "Wake sent"; }
    catch (error) { button.textContent = error.message; }
  }));
}
