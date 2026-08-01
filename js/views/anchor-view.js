import { subscribe } from "../state/store.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
let metricsSubscription = null;

function usedMegabytes(bytes) {
  return Math.round(Number(bytes || 0) / 104857.6) / 10;
}

function kindSummary(kinds = {}) {
  const entries = Object.entries(kinds).filter(([, count]) => Number(count) > 0).sort((left, right) => Number(right[1]) - Number(left[1]));
  if (!entries.length) return "No cached control records.";
  return entries.map(([kind, count]) => `${kind.replaceAll("-", " ")}: ${count}`).join(" · ");
}

function updateAnchorMetrics(anchor = {}) {
  const values = {
    "[data-anchor-record-count]": Number(anchor.objectCount || 0).toLocaleString(),
    "[data-anchor-replicated-count]": Number(anchor.replicatedObjects || 0).toLocaleString(),
    "[data-anchor-cache-used]": `${usedMegabytes(anchor.bytesUsed)} MB`,
    "[data-anchor-kind-summary]": kindSummary(anchor.kinds),
  };
  for (const [selector, value] of Object.entries(values)) {
    const element = document.querySelector(selector);
    if (element && element.textContent !== value) element.textContent = value;
  }
}

export function renderAnchorView(state) {
  const anchor = state.anchor || {};
  const remindersReady = state.survival?.wakeAssistance === "ready";
  const cacheMb = Math.round(Number(anchor.cacheLimitBytes || 104857600) / 1048576);
  const usedMb = usedMegabytes(anchor.bytesUsed);
  const running = !!anchor.enabled && anchor.status !== "paused";
  const statusLabel = !anchor.enabled ? "Off" : anchor.status === "paused" ? "Paused in background" : "Running";
  const tone = running ? "safe" : anchor.status === "paused" ? "warning" : "neutral";
  const connectedAnchors = Number(anchor.connectedAnchors || 0);
  const controlPath = {
    "anchor-primary": "Anchors",
    hybrid: "Anchors + backup",
    "mesh-degraded": "Anchors only",
    isolated: "Local only",
    "supabase-primary": "Supabase fallback",
  }[anchor.coordinationMode] || "Supabase fallback";
  const peerLabel = connectedAnchors ? `${connectedAnchors} connected` : "No peer Anchor";
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
      <label class="anchor-switch"><input type="checkbox" name="enabled" ${anchor.enabled ? "checked" : ""}><span><strong>Run as an Anchor</strong><small>${remindersReady ? "Node reminders on. Keep this tab open." : "Keep this tab open. Node reminders are optional."}</small></span></label>
      <div class="anchor-ledger">
        <span>Cached records<strong data-anchor-record-count>${Number(anchor.objectCount || 0).toLocaleString()}</strong></span>
        <span>Backed up<strong data-anchor-replicated-count>${Number(anchor.replicatedObjects || 0).toLocaleString()}</strong></span>
        <span>Anchor peers<strong>${peerLabel}</strong></span>
        <span>Cache used<strong data-anchor-cache-used>${usedMb} MB</strong></span>
        <span>Wake Lock<strong>${esc(anchor.wakeLock || "released")}</strong></span>
        <span>Control path<strong>${controlPath}</strong></span>
      </div>
      <details class="settings-technical"><summary>Cached record breakdown</summary><p data-anchor-kind-summary>${esc(kindSummary(anchor.kinds))}</p></details>
      <p class="storage-assurance">${assurance}</p>
      <div class="anchor-actions"><button class="button" type="submit">Save Anchor settings</button><a class="button button--ghost" href="#/night-node">Open Night Node</a></div>
      <p class="form-status" role="status"></p>
    </form>
  </section>`;
}

export function bindAnchorView(actions) {
  if (!metricsSubscription) {
    metricsSubscription = subscribe((state) => {
      if (state.route === "anchor") updateAnchorMetrics(state.anchor);
    });
  }
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
      (document.querySelector("[data-anchor-form] .form-status") || status).textContent = "Anchor settings saved.";
    } catch (error) {
      (document.querySelector("[data-anchor-form] .form-status") || status).textContent = error.message;
    }
  });
}
