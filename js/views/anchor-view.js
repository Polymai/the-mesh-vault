import { subscribe } from "../state/store.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
let metricsSubscription = null;
const usedMegabytes = (bytes) => Math.round(Number(bytes || 0) / 104857.6) / 10;
function kindSummary(kinds = {}) {
  const entries = Object.entries(kinds).filter(([, count]) => Number(count) > 0).sort((left, right) => Number(right[1]) - Number(left[1]));
  return entries.length ? entries.map(([kind, count]) => `${kind.replaceAll("-", " ")}: ${count}`).join(" · ") : "No cached records yet.";
}
function updateMetrics(anchor = {}) {
  const values = { "[data-anchor-record-count]": Number(anchor.objectCount || 0).toLocaleString(), "[data-anchor-replicated-count]": Number(anchor.replicatedObjects || 0).toLocaleString(), "[data-anchor-cache-used]": `${usedMegabytes(anchor.bytesUsed)} MB`, "[data-anchor-kind-summary]": kindSummary(anchor.kinds) };
  for (const [selector, value] of Object.entries(values)) { const element = document.querySelector(selector); if (element && element.textContent !== value) element.textContent = value; }
}

export function renderAnchorView(state) {
  const anchor = state.anchor || {};
  const nativeActive = !!state.nativeNode?.supported && !!(state.nativeNode.running || state.nativeNode.enabled);
  const cacheMb = Math.round(Number(anchor.cacheLimitBytes || 104857600) / 1048576);
  const running = !!anchor.enabled && (nativeActive || anchor.status !== "paused");
  const statusLabel = !anchor.enabled ? "Mesh participant" : nativeActive ? "Android Backbone" : anchor.status === "paused" ? "Paused" : "Backbone online";
  const connected = Number(anchor.connectedBackbones ?? anchor.connectedParticipants ?? anchor.connectedAnchors ?? 0);
  return `<section class="view-head view-head--compact"><div><h1>Backbone</h1></div><span class="status-pill status-pill--${running ? "safe" : "neutral"}">${statusLabel}</span></section>
  <section class="panel settings-section anchor-panel">
    <div class="settings-section-head"><h2>This device</h2><p>Every online node helps with signed mesh coordination. Backbone mode additionally keeps a larger cache and asks the device to stay available.</p></div>
    <form data-anchor-form>
      <label><span>Public node name</span><input name="anchorLabel" maxlength="80" value="${esc(anchor.nodeName || "Browser node")}" required></label>
      <label class="range-label"><span><strong>Control cache</strong><output data-anchor-cache-output>${cacheMb} MB</output></span><input type="range" name="cacheMb" min="25" max="1024" step="25" value="${cacheMb}"></label>
      <label class="anchor-switch"><input type="checkbox" name="enabled" ${anchor.enabled ? "checked" : ""}><span><strong>Keep this device as a Backbone</strong><small>${nativeActive ? "Android keeps it active with a foreground service." : "A browser can only participate while this tab is running."}</small></span></label>
      <div class="anchor-ledger"><span>Cached records<strong data-anchor-record-count>${Number(anchor.objectCount || 0).toLocaleString()}</strong></span><span>Replicated<strong data-anchor-replicated-count>${Number(anchor.replicatedObjects || 0).toLocaleString()}</strong></span><span>Backbone peers<strong>${connected} connected</strong></span><span>Cache used<strong data-anchor-cache-used>${usedMegabytes(anchor.bytesUsed)} MB</strong></span><span>Wake Lock<strong>${esc(anchor.wakeLock || "released")}</strong></span><span>Control path<strong>${esc(anchor.coordinationMode || "fallback")}</strong></span></div>
      <details class="settings-technical"><summary>Cached record breakdown</summary><p data-anchor-kind-summary>${esc(kindSummary(anchor.kinds))}</p></details>
      <div class="anchor-actions"><button class="button" type="submit">Save Backbone settings</button><a class="button button--ghost" href="#/night-node">Open Night Node</a></div><p class="form-status" role="status"></p>
    </form>
  </section>
  <section class="panel settings-section backbone-host-panel">
    <div class="settings-section-head"><h2>Dedicated server</h2><p>Generate a config for an always-on computer or server. Its encrypted storage joins the same mesh.</p></div>
    <form data-backbone-host-form><div class="backbone-host-grid">
      <label><span>Server name</span><input name="hostLabel" maxlength="80" value="${esc(anchor.nodeName || "Home Backbone")}" required></label>
      <label><span>Storage paths</span><textarea name="storagePaths" rows="3" placeholder="D:\\TheMeshVault&#10;E:\\TheMeshVault" required>D:\\TheMeshVault</textarea></label>
      <label><span>Logical instances</span><input name="instanceCount" type="number" min="1" max="100" step="1" value="1" required></label>
      <label><span>GB per instance</span><input name="quotaGb" type="number" min="1" max="250000" step="1" value="100" required></label>
      <label><span>Public WSS address</span><input name="publicUrl" type="url" placeholder="wss://backbone.example.com"></label>
    </div><p class="settings-help">Add one path per disk. Instances are spread across the paths, while the host still counts as one independent device. A public WSS address is required before remote devices can store shards here.</p><div class="anchor-actions"><button class="button button--ghost" type="submit">Download server config</button><a class="button button--ghost" href="https://github.com/Polymai/the-mesh-vault/tree/main/native/backbone-host" target="_blank" rel="noopener">Server instructions</a></div><p class="form-status" role="status"></p></form>
  </section>`;
}

function downloadHostConfig(form) {
  const values = new FormData(form); const count = Math.max(1, Math.min(100, Math.trunc(Number(values.get("instanceCount")) || 1))); const quotaBytes = Math.trunc(Math.max(1, Number(values.get("quotaGb")) || 100) * 1024 ** 3); const label = String(values.get("hostLabel") || "TheMeshVault Backbone").trim().slice(0, 80); const publicConfig = window.__POLYMAI_SUPABASE_CONFIG__ || {};
  const paths = String(values.get("storagePaths") || "").split(/\r?\n/).map((path) => path.trim()).filter(Boolean); if (!paths.length) throw new Error("Add at least one storage path.");
  const publicUrl = String(values.get("publicUrl") || "").trim(); if (publicUrl && !/^wss:\/\//i.test(publicUrl)) throw new Error("The public address must start with wss://.");
  const storagePools = paths.map((path, index) => ({ id: `pool-${index + 1}`, path, physicalDeviceId: "auto" }));
  const config = { protocolVersion: 3, physicalHostId: crypto.randomUUID(), label, listen: { host: "0.0.0.0", port: 3717 }, publicUrl, tls: { certificatePath: "", privateKeyPath: "" }, supabase: { url: publicConfig.url || "", publishableKey: publicConfig.anonKey || "", heartbeatMs: 600000 }, reserveBytesPerPool: 1073741824, storagePools, instances: Array.from({ length: count }, (_, index) => ({ id: crypto.randomUUID(), label: `${label} ${index + 1}`, poolId: storagePools[index % storagePools.length].id, quotaBytes })) };
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "backbone-host.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return count;
}

export function bindAnchorView(actions) {
  if (!metricsSubscription) metricsSubscription = subscribe((state) => { if (state.route === "anchor") updateMetrics(state.anchor); });
  const range = document.querySelector("[name='cacheMb']"); range?.addEventListener("input", () => { document.querySelector("[data-anchor-cache-output]").textContent = `${range.value} MB`; });
  document.querySelector("[data-anchor-form]")?.addEventListener("submit", async (event) => { event.preventDefault(); const status = event.target.querySelector(".form-status"); const values = new FormData(event.target); status.textContent = "Saving…"; try { await actions.anchor({ enabled: values.get("enabled") === "on", nodeName: values.get("anchorLabel"), cacheLimitBytes: Number(values.get("cacheMb")) * 1048576 }); (document.querySelector("[data-anchor-form] .form-status") || status).textContent = "Backbone settings saved."; } catch (error) { (document.querySelector("[data-anchor-form] .form-status") || status).textContent = error.message; } });
  document.querySelector("[data-backbone-host-form]")?.addEventListener("submit", (event) => { event.preventDefault(); const status = event.target.querySelector(".form-status"); try { const count = downloadHostConfig(event.target); status.textContent = `${count} instance${count === 1 ? "" : "s"} configured. The file contains stable node IDs, but no vault key.`; } catch (error) { status.textContent = error.message; } });
}
