import { subscribe } from "../state/store.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
let metricsSubscription = null;
let backboneMonitorTimer = null;
const BACKBONE_LAUNCHES_KEY = "themeshvault.backboneLaunches.v1";
const BACKBONE_MANAGEMENT_PATH = "/_themeshvault/backbone";

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
function safeFilePart(value) { return String(value || "server").trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "server"; }
function quotePowerShell(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function powershellEncodedCommand(script) {
  const bytes = new Uint8Array(script.length * 2);
  for (let index = 0; index < script.length; index += 1) { const code = script.charCodeAt(index); bytes[index * 2] = code & 255; bytes[index * 2 + 1] = code >>> 8; }
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function backboneLaunches() {
  try { const value = JSON.parse(localStorage.getItem(BACKBONE_LAUNCHES_KEY) || "[]"); return Array.isArray(value) ? value.slice(-8) : []; } catch { return []; }
}
function saveBackboneLaunch(record) {
  const values = backboneLaunches().filter((item) => item.hostId !== record.hostId);
  values.push(record); localStorage.setItem(BACKBONE_LAUNCHES_KEY, JSON.stringify(values.slice(-8)));
}
function downloadQuickLauncher(serverNamePrefix, firstNumber, instanceCount, existing = null) {
  const hostId = existing?.hostId || crypto.randomUUID();
  const portHint = Number(existing?.port || Math.min(3817, 3717 + backboneLaunches().length));
  const lastNumber = firstNumber + instanceCount - 1;
  const displayName = instanceCount === 1 ? `${serverNamePrefix} ${firstNumber}` : `${serverNamePrefix} ${firstNumber}-${lastNumber}`;
  const baseUrl = new URL("./", location.href).href.split("#")[0];
  const packageUrl = new URL("downloads/themeshvault-backbone-host-v3.3.0.zip", baseUrl).href;
  const installFolder = `TheMeshVault\\Backbones\\Host-${hostId.slice(0, 8)}`;
  const script = `$ErrorActionPreference = 'Stop'\n$install = Join-Path $env:LOCALAPPDATA ${quotePowerShell(installFolder)}\n$zip = Join-Path $env:TEMP ${quotePowerShell(`themeshvault-backbone-${hostId.slice(0, 8)}.zip`)}\nWrite-Host 'Starting ${displayName.replaceAll("'", "''")}...' -ForegroundColor Cyan\nNew-Item -ItemType Directory -Path $install -Force | Out-Null\nInvoke-WebRequest -UseBasicParsing -Uri ${quotePowerShell(packageUrl)} -OutFile $zip\nExpand-Archive -LiteralPath $zip -DestinationPath $install -Force\n& (Join-Path $install 'quick-start.ps1') -ServerNamePrefix ${quotePowerShell(serverNamePrefix)} -FirstServerNumber ${firstNumber} -InstanceCount ${instanceCount} -HostId ${quotePowerShell(hostId)} -PortHint ${portHint}\nif ($LASTEXITCODE -ne 0) { Read-Host 'Press Enter to close' }\n`;
  const command = `@echo off\r\ntitle TheMeshVault - ${displayName.replace(/[\r\n&|<>^]/g, "")}\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${powershellEncodedCommand(script)}\r\nif errorlevel 1 pause\r\n`;
  const url = URL.createObjectURL(new Blob([command], { type: "application/octet-stream" }));
  const link = document.createElement("a"); link.href = url; link.download = `Start ${safeFilePart(displayName)}.cmd`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  saveBackboneLaunch({ hostId, port: portHint, serverNamePrefix, firstNumber, instanceCount, displayName, createdAt: existing?.createdAt || Date.now() });
  localStorage.setItem("themeshvault.backboneServerCount", String(lastNumber));
  return displayName;
}

function formatBytes(bytes) { const gb = Number(bytes || 0) / 1073741824; return gb >= 1 ? `${Math.round(gb * 10) / 10} GB` : `${Math.round(Number(bytes || 0) / 104857.6) / 10} MB`; }
async function localBackboneRequest(port, path = "/status", options = {}, timeoutMs = 1400) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${BACKBONE_MANAGEMENT_PATH}${path}`, { cache: "no-store", ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Local manager returned ${response.status}.`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function locateLocalBackbone(launch) {
  try {
    const status = await localBackboneRequest(launch.port, "/status", {}, 500);
    if (!status.launcherHostId || status.launcherHostId === launch.hostId) return { launch, status };
  } catch {}
  const ports = Array.from({ length: 101 }, (_, index) => 3717 + index).filter((port) => port !== Number(launch.port));
  const results = await Promise.all(ports.map(async (port) => {
    try { return { port, status: await localBackboneRequest(port, "/status", {}, 350) }; } catch { return null; }
  }));
  const match = results.find((result) => result?.status?.launcherHostId === launch.hostId);
  if (!match) throw new Error("Local Backbone host not found.");
  const corrected = { ...launch, port: match.port };
  saveBackboneLaunch(corrected);
  return { launch: corrected, status: match.status };
}
function instanceMarkup(instance, port) {
  const online = instance.state === "online";
  return `<article class="backbone-instance" data-backbone-instance="${esc(instance.id)}"><span class="backbone-instance-light backbone-instance-light--${online ? "online" : "stopped"}" aria-hidden="true"></span><div><strong>${esc(instance.label)}</strong><small>${online ? "Online" : "Stopped"} · ${formatBytes(instance.usedBytes)} of ${formatBytes(instance.quotaBytes)}</small></div><div class="backbone-instance-actions">${online ? `<button class="text-button" type="button" data-backbone-action="restart" data-instance-id="${esc(instance.id)}" data-port="${port}">Restart</button><button class="text-button text-button--danger" type="button" data-backbone-action="stop" data-instance-id="${esc(instance.id)}" data-port="${port}">Stop</button>` : `<button class="text-button" type="button" data-backbone-action="start" data-instance-id="${esc(instance.id)}" data-port="${port}">Start</button>`}</div></article>`;
}
async function updateBackboneManager() {
  const target = document.querySelector("[data-backbone-host-list]");
  if (!target || location.hash.split(/[?#]/)[0] !== "#/anchor") { clearInterval(backboneMonitorTimer); backboneMonitorTimer = null; return; }
  const launches = backboneLaunches();
  if (!launches.length) { target.innerHTML = `<p class="backbone-manager-empty">No local Backbone servers started from this browser yet.</p>`; return; }
  const hosts = await Promise.all(launches.map(async (launch) => {
    try { return await locateLocalBackbone(launch); } catch (error) { return { launch, error }; }
  }));
  if (!target.isConnected) return;
  target.innerHTML = hosts.map(({ launch, status }) => status?.ok
    ? `<section class="backbone-host-status"><header><div><strong>${esc(status.label)}</strong><small>${status.instances.length} logical server${status.instances.length === 1 ? "" : "s"} · one physical device</small></div><span class="status-pill status-pill--safe">Host online</span></header><div>${status.instances.map((instance) => instanceMarkup(instance, launch.port)).join("")}</div></section>`
    : `<section class="backbone-host-status backbone-host-status--offline"><header><div><strong>${esc(launch.displayName)}</strong><small>Local host not detected on port ${launch.port}</small></div><span class="status-pill status-pill--neutral">Host offline</span></header><button class="button button--ghost" type="button" data-backbone-redownload="${esc(launch.hostId)}">Download start file</button></section>`).join("");
}
function startBackboneMonitor() {
  clearInterval(backboneMonitorTimer); backboneMonitorTimer = setInterval(() => updateBackboneManager().catch(() => {}), 4000);
  updateBackboneManager().catch(() => {});
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
    <div class="settings-section-head"><h2>Start Backbone servers</h2><p>Choose how many logical servers this computer should run.</p></div>
    <form data-backbone-quickstart-form><input type="hidden" name="serverNumber" value="${number}"><label><span>Name</span><input name="serverNamePrefix" maxlength="60" value="Server" required></label><label><span>Servers</span><input name="instanceCount" type="number" min="1" max="32" step="1" value="8" required></label><button class="button" type="submit">Start servers</button><p class="backbone-failure-note">They share this computer and count as one physical device for recovery.</p><p class="form-status" role="status"></p></form>
  </section>
  <section class="panel settings-section backbone-manager-panel"><div class="settings-section-head"><h2>Local server status</h2></div><div data-backbone-host-list><p class="backbone-manager-empty">Checking this computer…</p></div></section>
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
  startBackboneMonitor();
  if (!metricsSubscription) metricsSubscription = subscribe((state) => { if (state.route === "anchor") updateMetrics(state.anchor); });
  const range = document.querySelector("[name='cacheMb']"); range?.addEventListener("input", () => { document.querySelector("[data-anchor-cache-output]").textContent = `${range.value} MB`; });
  document.querySelector("[data-anchor-form]")?.addEventListener("submit", async (event) => { event.preventDefault(); const status = event.target.querySelector(".form-status"); const values = new FormData(event.target); status.textContent = "Saving…"; try { await actions.anchor({ enabled: values.get("enabled") === "on", nodeName: values.get("anchorLabel"), cacheLimitBytes: Number(values.get("cacheMb")) * 1048576 }); (document.querySelector("[data-anchor-form] .form-status") || status).textContent = "Backbone settings saved."; } catch (error) { (document.querySelector("[data-anchor-form] .form-status") || status).textContent = error.message; } });
  document.querySelector("[data-backbone-quickstart-form]")?.addEventListener("submit", (event) => { event.preventDefault(); const values = new FormData(event.target); const status = event.target.querySelector(".form-status"); const prefix = String(values.get("serverNamePrefix") || "").trim(); const number = Number(values.get("serverNumber") || 1); const count = Math.max(1, Math.min(32, Math.trunc(Number(values.get("instanceCount") || 1)))); if (!prefix) { status.textContent = "Enter a name."; return; } const displayName = downloadQuickLauncher(prefix, number, count); status.textContent = `Open “Start ${safeFilePart(displayName)}.cmd” from Downloads once.`; event.target.elements.serverNumber.value = String(number + count); startBackboneMonitor(); });
  document.querySelector("[data-backbone-host-list]")?.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-backbone-action]");
    const redownload = event.target.closest("[data-backbone-redownload]");
    if (redownload) { const launch = backboneLaunches().find((item) => item.hostId === redownload.dataset.backboneRedownload); if (launch) downloadQuickLauncher(launch.serverNamePrefix, launch.firstNumber, launch.instanceCount, launch); return; }
    if (!action) return;
    action.disabled = true; const previous = action.textContent; action.textContent = action.dataset.backboneAction === "stop" ? "Stopping…" : "Starting…";
    try { await localBackboneRequest(Number(action.dataset.port), `/instances/${encodeURIComponent(action.dataset.instanceId)}/${action.dataset.backboneAction}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); await updateBackboneManager(); }
    catch { action.disabled = false; action.textContent = previous; }
  });
}
