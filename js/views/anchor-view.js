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
function nextServerNumber(state) {
  const current = Math.max(0, Number(localStorage.getItem("themeshvault.backboneServerCount") || 0));
  const visible = (state?.nodes || []).map((node) => /^Server\s+(\d+)$/i.exec(String(node.label || node.name || "")))
    .filter(Boolean).map((match) => Number(match[1])).filter(Number.isFinite);
  return Math.max(current, 0, ...visible) + 1;
}
function safeFilePart(value) {
  return String(value || "server").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "server";
}
function quotePowerShell(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function powershellEncodedCommand(script) {
  const bytes = new Uint8Array(script.length * 2);
  for (let index = 0; index < script.length; index += 1) { const code = script.charCodeAt(index); bytes[index * 2] = code & 255; bytes[index * 2 + 1] = code >>> 8; }
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function downloadQuickLauncher(serverName, number) {
  const instanceId = crypto.randomUUID();
  const baseUrl = new URL("./", location.href).href.split("#")[0];
  const packageUrl = new URL("downloads/themeshvault-backbone-host-v3.2.0.zip", baseUrl).href;
  const installFolder = `TheMeshVault\\Backbones\\${safeFilePart(serverName)}-${instanceId.slice(0, 8)}`;
  const script = `$ErrorActionPreference = 'Stop'\n$install = Join-Path $env:LOCALAPPDATA ${quotePowerShell(installFolder)}\n$zip = Join-Path $env:TEMP ${quotePowerShell(`themeshvault-backbone-${instanceId.slice(0, 8)}.zip`)}\nWrite-Host 'Starting ${serverName.replaceAll("'", "''")}...' -ForegroundColor Cyan\nNew-Item -ItemType Directory -Path $install -Force | Out-Null\nInvoke-WebRequest -UseBasicParsing -Uri ${quotePowerShell(packageUrl)} -OutFile $zip\nExpand-Archive -LiteralPath $zip -DestinationPath $install -Force\n& (Join-Path $install 'quick-start.ps1') -ServerName ${quotePowerShell(serverName)} -InstanceId ${quotePowerShell(instanceId)}\nif ($LASTEXITCODE -ne 0) { Read-Host 'Press Enter to close' }\n`;
  const command = `@echo off\r\ntitle TheMeshVault - ${serverName.replace(/[\r\n&|<>^]/g, "")}\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${powershellEncodedCommand(script)}\r\nif errorlevel 1 pause\r\n`;
  const url = URL.createObjectURL(new Blob([command], { type: "application/octet-stream" }));
  const link = document.createElement("a"); link.href = url; link.download = `Start ${safeFilePart(serverName)}.cmd`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  localStorage.setItem("themeshvault.backboneServerCount", String(number));
}

export function renderAnchorView(state) {
  const anchor = state.anchor || {};
  const nativeActive = !!state.nativeNode?.supported && !!(state.nativeNode.running || state.nativeNode.enabled);
  const cacheMb = Math.round(Number(anchor.cacheLimitBytes || 104857600) / 1048576);
  const running = !!anchor.enabled && (nativeActive || anchor.status !== "paused");
  const statusLabel = !anchor.enabled ? "Mesh participant" : nativeActive ? "Android Backbone" : anchor.status === "paused" ? "Paused" : "Backbone online";
  const connected = Number(anchor.connectedBackbones ?? anchor.connectedParticipants ?? anchor.connectedAnchors ?? 0);
  const number = nextServerNumber(state);
  return `<section class="view-head view-head--compact"><div><h1>Backbone</h1></div><span class="status-pill status-pill--${running ? "safe" : "neutral"}">${statusLabel}</span></section>
  <section class="panel settings-section backbone-quickstart-panel">
    <div class="settings-section-head"><h2>Start Backbone server</h2></div>
    <form data-backbone-quickstart-form><input type="hidden" name="serverNumber" value="${number}"><label><span>Server name</span><input name="serverName" maxlength="80" value="Server ${number}" required></label><button class="button" type="submit">Start Backbone server</button><p class="form-status" role="status"></p></form>
  </section>
  <details class="panel settings-section anchor-panel anchor-device-settings">
    <summary><span>This browser</span><small>Backbone settings</small></summary>
    <form data-anchor-form>
      <label><span>Public node name</span><input name="anchorLabel" maxlength="80" value="${esc(anchor.nodeName || "Browser node")}" required></label>
      <label class="range-label"><span><strong>Control cache</strong><output data-anchor-cache-output>${cacheMb} MB</output></span><input type="range" name="cacheMb" min="25" max="1024" step="25" value="${cacheMb}"></label>
      <label class="anchor-switch"><input type="checkbox" name="enabled" ${anchor.enabled ? "checked" : ""}><span><strong>Keep this device as a Backbone</strong><small>${nativeActive ? "Android keeps it active with a foreground service." : "A browser participates while this tab is running."}</small></span></label>
      <div class="anchor-ledger"><span>Cached records<strong data-anchor-record-count>${Number(anchor.objectCount || 0).toLocaleString()}</strong></span><span>Replicated<strong data-anchor-replicated-count>${Number(anchor.replicatedObjects || 0).toLocaleString()}</strong></span><span>Backbone peers<strong>${connected} connected</strong></span><span>Cache used<strong data-anchor-cache-used>${usedMegabytes(anchor.bytesUsed)} MB</strong></span><span>Wake Lock<strong>${esc(anchor.wakeLock || "released")}</strong></span><span>Control path<strong>${esc(anchor.coordinationMode || "fallback")}</strong></span></div>
      <details class="settings-technical"><summary>Cached record breakdown</summary><p data-anchor-kind-summary>${esc(kindSummary(anchor.kinds))}</p></details>
      <div class="anchor-actions"><button class="button" type="submit">Save Backbone settings</button><a class="button button--ghost" href="#/night-node">Open Night Node</a></div><p class="form-status" role="status"></p>
    </form>
  </details>`;
}

export function bindAnchorView(actions) {
  if (!metricsSubscription) metricsSubscription = subscribe((state) => { if (state.route === "anchor") updateMetrics(state.anchor); });
  const range = document.querySelector("[name='cacheMb']"); range?.addEventListener("input", () => { document.querySelector("[data-anchor-cache-output]").textContent = `${range.value} MB`; });
  document.querySelector("[data-anchor-form]")?.addEventListener("submit", async (event) => { event.preventDefault(); const status = event.target.querySelector(".form-status"); const values = new FormData(event.target); status.textContent = "Saving…"; try { await actions.anchor({ enabled: values.get("enabled") === "on", nodeName: values.get("anchorLabel"), cacheLimitBytes: Number(values.get("cacheMb")) * 1048576 }); (document.querySelector("[data-anchor-form] .form-status") || status).textContent = "Backbone settings saved."; } catch (error) { (document.querySelector("[data-anchor-form] .form-status") || status).textContent = error.message; } });
  document.querySelector("[data-backbone-quickstart-form]")?.addEventListener("submit", (event) => { event.preventDefault(); const values = new FormData(event.target); const status = event.target.querySelector(".form-status"); const serverName = String(values.get("serverName") || "").trim(); const number = Number(values.get("serverNumber") || 1); if (!serverName) { status.textContent = "Enter a server name."; return; } downloadQuickLauncher(serverName, number); status.textContent = `Open “Start ${safeFilePart(serverName)}.cmd” from Downloads once.`; event.target.elements.serverNumber.value = String(number + 1); event.target.elements.serverName.value = `Server ${number + 1}`; });
}
