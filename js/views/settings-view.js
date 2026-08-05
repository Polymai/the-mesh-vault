const gb = (bytes) => Math.round(Number(bytes || 0) / 107374182.4) / 10;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
function countryLabel(code) {
  if (!code) return "";
  try { return `${new Intl.DisplayNames(["en"], { type: "region" }).of(String(code).toUpperCase())} (${String(code).toUpperCase()})`; }
  catch { return String(code).toUpperCase(); }
}
function automaticLocation(node = {}) {
  const label = [node.regionCode, countryLabel(node.countryCode)].filter(Boolean).join(", ") || "Unknown";
  if (node.locationSource === "browser_coarse") return { label, detail: "Detected automatically." };
  if (node.locationSource === "edge_hint") return { label, detail: "Estimated automatically." };
  return { label, detail: "Not available." };
}
function installPresentation(install = {}) {
  if (install.installed) return {
    label: "Installed",
    tone: "safe",
    detail: "Open it from your home screen or app list.",
    button: `<button class="button button--ghost" type="button" disabled>Installed</button>`,
  };
  if (install.available) return {
    label: "Ready",
    tone: "safe",
    detail: "Add it to this device for quicker access and its own app window.",
    button: `<button class="button" type="button" data-install-pwa ${install.prompting ? "disabled" : ""}>${install.prompting ? "Opening…" : "Install"}</button>`,
  };
  if (install.platform === "ios") return {
    label: "Browser menu",
    tone: "neutral",
    detail: "Choose Share, Add to Home Screen, then Open as Web App.",
    button: "",
  };
  if (install.platform === "desktop" && install.browser === "safari") return {
    label: "Safari menu",
    tone: "neutral",
    detail: "Choose File or Share, then Add to Dock.",
    button: "",
  };
  if (install.platform === "desktop" && install.browser === "firefox" && install.os === "windows") return {
    label: "Firefox web app",
    tone: "neutral",
    detail: "In Firefox 143 or later, choose the web apps button in the address bar.",
    button: "",
  };
  if (install.platform === "desktop" && install.browser === "firefox") return {
    label: "Web app unavailable",
    tone: "neutral",
    detail: "Firefox only offers installed web apps on Windows. Use Safari on macOS or a Chromium browser.",
    button: "",
  };
  if (install.platform === "android" && install.browser === "firefox") return {
    label: "Firefox menu",
    tone: "neutral",
    detail: "Choose Install from the Firefox menu.",
    button: "",
  };
  return {
    label: "Browser menu",
    tone: "neutral",
    detail: "Choose Install TheMeshVault in your browser menu.",
    button: "",
  };
}
function wakeAssistanceSection(survival = {}) {
  const value = survival.wakeAssistance || "unknown";
  const states = {
    unknown: { status: "Checking", detail: "Checking browser support.", label: "Checking", action: "", disabled: true },
    available: { status: "Off", detail: "Optional. Allow a buddy Anchor to send this device a notification.", label: "Enable", action: "enable", disabled: false },
    "permission needed": { status: "Off", detail: "Optional. Allow a buddy Anchor to send this device a notification.", label: "Enable", action: "enable", disabled: false },
    ready: { status: "On", detail: "A buddy Anchor can send this device a reminder.", label: "Disable", action: "disable", disabled: false },
    blocked: { status: "Blocked", detail: "Anchor mode still works. Change site permissions only if you want reminders.", label: "Blocked", action: "", disabled: true },
    unsupported: { status: "Unavailable", detail: "Anchor mode still works without reminders.", label: "Unavailable", action: "", disabled: true },
    unavailable: { status: "Needs attention", detail: "Anchor mode still works. Retry only if you want reminders.", label: "Retry", action: "enable", disabled: false },
    "brave setup needed": { status: "Brave push needs setup", detail: "Enable Brave's push-messaging service, restart Brave, then retry.", label: "Retry", action: "enable", disabled: false },
    "setup needed": { status: "Network setup needed", detail: "Anchor mode still works. Reminders are not configured on the network.", label: "Retry", action: "enable", disabled: false },
  };
  const presentation = states[value] || states.unavailable;
  const detail = survival.wakeAssistanceMessage || presentation.detail;
  const help = value === "brave setup needed"
    ? `<small class="wake-assistance-help"><b>Brave:</b> open Settings → Privacy and security, search for <q>push messaging</q>, enable the Google push-messaging service if shown, and restart Brave.</small>`
    : presentation.action === "enable" ? "<small>If the browser offers a duration, choose Always to keep permission between visits.</small>" : "";
  return `<section class="panel settings-section wake-assistance-panel"><div class="settings-section-head"><h2>Node reminders</h2></div><div class="setting-row wake-assistance-setting"><div><strong>${esc(presentation.status)}</strong><span>${esc(detail)}</span>${help}</div><button class="button button--ghost" type="button" data-wake-assistance-action="${esc(presentation.action)}" ${presentation.disabled ? "disabled" : ""}>${esc(presentation.label)}</button></div><p class="form-status" data-wake-assistance-status role="status"></p></section>`;
}

export function renderSettingsView(state) {
  const profile = state.vaultProfile || { name: "" };
  const privateNameStatus = profile.syncStatus === "synced"
    ? "Encrypted and available after this vault is restored on another browser."
    : profile.name ? "Saved in this browser. Encrypted sync is pending." : "Encrypted and visible only after this vault is opened.";
  const nodeLocation = automaticLocation(state.node);
  const install = installPresentation(state.pwaInstall);
  const publicUrl = String(state.pwaInstall?.publicUrl || "");
  const maxContributionGb = gb(window.__DATA__?.limits?.maxContributionBytes || 268435456000);
  const installSection = `<section class="panel settings-section pwa-install-panel"><div class="settings-section-head"><h2>Install or share TheMeshVault</h2></div><div class="pwa-install-row"><span class="pwa-install-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="3"/><path d="M9 6.5h6M12 16v-5m0 5-2-2m2 2 2-2"/><circle cx="12" cy="18.5" r=".5"/></svg></span><div><strong>${esc(install.label)}</strong><span>${esc(install.detail)}</span></div>${install.button}</div><div class="pwa-share-row"><a class="pwa-public-link" href="${esc(publicUrl)}" target="_blank" rel="noopener" aria-label="Open the public TheMeshVault link">${esc(publicUrl)}</a><div class="pwa-share-actions"><button class="button button--ghost" type="button" data-share-app>Share TheMeshVault</button><button class="button button--ghost" type="button" data-copy-app-link>Copy link</button></div></div><p class="form-status" data-install-status role="status"></p></section>`;
  return `<section class="view-head view-head--compact"><div><h1>Settings</h1></div><span class="status-pill status-pill--${state.node.status === "online" ? "safe" : "neutral"}">${state.node.status}</span></section>
  <div class="settings-grid">
    <section class="panel settings-section"><div class="settings-section-head"><h2>Storage you share</h2></div><form data-capacity-form><label class="range-label"><span><strong>Maximum on this browser</strong><output>${gb(state.node.capacityBytes)} GB</output></span><input type="range" name="capacity" min="0" max="${maxContributionGb}" step="0.25" value="${gb(state.node.capacityBytes)}"><small>Up to ${maxContributionGb} GB. Browser storage limits still apply.</small></label><button class="button" type="submit">Save limit</button><p class="form-status" role="status"></p></form></section>
    ${wakeAssistanceSection(state.survival)}
    ${state.identity ? `<section class="panel settings-section"><div class="settings-section-head"><h2>File protection</h2></div><form data-resilience-form><label><span>Protection mode</span><select name="resilienceClass"><option value="auto" ${state.erasureClass === "auto" ? "selected" : ""}>Automatic · recommended</option><option value="standard" ${state.erasureClass === "standard" ? "selected" : ""}>Balanced · less extra storage</option><option value="high" ${state.erasureClass === "high" ? "selected" : ""}>Extra · stronger at 16 nodes</option></select></label><details class="settings-technical"><summary>Technical details</summary><p>Automatic grows from 3+2 to 8+4 and then 10+6 as independent nodes join. Balanced uses 12+4 at 16 nodes; Extra uses 10+6.</p></details><button class="button" type="submit">Save protection</button><p class="form-status" role="status"></p></form></section>` : ""}
    <section class="panel settings-section"><div class="settings-section-head"><h2>This device</h2></div><form class="node-name-form" data-node-name-form><label><span>Public node name</span><input name="nodeName" maxlength="80" autocomplete="off" placeholder="Browser node" value="${esc(state.node.label || "Browser node")}" required><small>Visible to other devices in Live Mesh.</small></label><button class="button button--ghost" type="submit">Save public name</button><p class="form-status" role="status"></p></form><div class="setting-row"><div><strong>Mesh participation</strong><span>Store and send encrypted pieces while open.</span></div><button class="button button--ghost" type="button" data-toggle-node>${state.node.status === "online" ? "Pause" : "Resume"}</button></div><div class="setting-row"><div><strong>Hosted pieces</strong><span>See the encrypted shards stored in this browser.</span></div><a class="button button--ghost" href="#/hosted-storage">View</a></div><div class="setting-row"><div><strong>Persistent storage</strong><span>${state.node.persistence === "granted" ? "Protected from routine browser cleanup." : "Ask the browser to protect saved pieces."}</span></div><button class="button button--ghost" type="button" data-persist-storage ${state.node.persistence === "granted" ? "disabled" : ""}>${state.node.persistence === "granted" ? "Protected" : "Protect"}</button></div><div class="setting-row"><div><strong>Broad location</strong><span>${esc(nodeLocation.detail)}</span></div><strong class="node-location-value">${esc(nodeLocation.label)}</strong></div><div class="setting-row setting-row--danger"><div><strong>Remove stored pieces</strong><span>Files may need repair elsewhere.</span></div><button class="button button--danger" type="button" data-clear-storage>Remove from this browser</button></div></section>
    ${state.identity ? `<section class="panel settings-section vault-identity-panel"><div class="settings-section-head"><h2>Vault access</h2></div><div class="setting-row"><div><strong>Vault ID</strong><span class="mono-id">${state.identity.vaultId.slice(0, 24)}…</span></div></div><form class="vault-profile-form" data-vault-profile-form><div class="vault-profile-fields"><label><span>Private vault name (optional)</span><input name="profileName" maxlength="80" autocomplete="off" placeholder="My vault" value="${esc(profile.name)}"><small>${esc(privateNameStatus)}</small></label></div><div class="vault-profile-actions"><button class="button button--ghost" type="submit">Save private name</button></div><p class="form-status" role="status"></p></form><div class="setting-row"><div><strong>Mesh Key</strong><span>${state.identity.meshKeySaved ? "Saved" : "Not saved"}</span></div><a class="button button--ghost" href="#/recovery">Manage</a></div><div class="setting-row"><div><strong>Optional account</strong></div><a class="button button--ghost" href="#/account">Connect</a></div></section>` : `<section class="panel settings-section"><div class="settings-section-head"><h2>Storage-only device</h2></div><a class="button" href="#/onboarding">Create a vault</a></section>`}
    ${installSection}
  </div>`;
}

export function bindSettingsView(actions) {
  const installStatus = document.querySelector("[data-install-status]");
  document.querySelector("[data-share-app]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await actions.shareApp();
      installStatus.textContent = result.outcome === "shared" ? "App link shared." : result.outcome === "copied" ? "App link copied." : result.outcome === "cancelled" ? "Sharing cancelled." : `Copy this link: ${result.url}`;
    } catch (error) { installStatus.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.querySelector("[data-copy-app-link]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await actions.copyAppLink();
      installStatus.textContent = result.outcome === "copied" ? "App link copied." : `Copy this link: ${result.url}`;
    } catch (error) { installStatus.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.querySelector("[data-install-pwa]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget; const status = document.querySelector("[data-install-status]");
    button.disabled = true; status.textContent = "Opening the browser install dialog…";
    try {
      const result = await actions.installApp();
      status.textContent = result.outcome === "accepted" ? "Installation approved." : result.outcome === "dismissed" ? "Installation cancelled." : "";
    } catch (error) {
      status.textContent = error.message; button.disabled = false;
    }
  });
  document.querySelector("[data-wake-assistance-action]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const action = button.dataset.wakeAssistanceAction;
    const status = document.querySelector("[data-wake-assistance-status]");
    button.disabled = true;
    try {
      if (action === "disable") await actions.disableNotifications();
      else await actions.enableNotifications();
    }
    catch (error) { if (status) status.textContent = error.message; }
    finally { if (button.isConnected) button.disabled = false; }
  });
  const range = document.querySelector("[name='capacity']");
  range?.addEventListener("input", () => { range.closest("label").querySelector("output").textContent = `${range.value} GB`; });
  document.querySelector("[data-capacity-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status");
    try { await actions.capacity(Number(new FormData(event.target).get("capacity")) * 1073741824); status.textContent = "Storage limit saved."; } catch (error) { status.textContent = error.message; }
  });
  document.querySelector("[data-node-name-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status"); const value = new FormData(event.target).get("nodeName");
    try {
      await actions.nodeName(value);
      (document.querySelector("[data-node-name-form] .form-status") || status).textContent = "Public node name saved.";
    }
    catch (error) { status.textContent = error.message; }
  });
  document.querySelector("[data-toggle-node]")?.addEventListener("click", actions.toggleNode);
  document.querySelector("[data-resilience-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status"); const value = new FormData(event.target).get("resilienceClass");
    try {
      const saved = await actions.resilienceClass(value);
      status.textContent = saved === "high" ? "Extra protection saved." : saved === "standard" ? "Balanced protection saved." : "Automatic protection saved.";
    }
    catch (error) { status.textContent = error.message; }
  });
  document.querySelector("[data-persist-storage]")?.addEventListener("click", actions.persist);
  document.querySelector("[data-clear-storage]")?.addEventListener("click", async (event) => {
    if (!confirm("Clear all encrypted shards stored by this browser?")) return;
    const button = event.currentTarget; button.disabled = true;
    try { await actions.clear(); }
    catch (error) { alert(error.message); button.disabled = false; }
  });
  document.querySelector("[data-vault-profile-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status"); const values = new FormData(event.target); status.textContent = "Saving name…";
    try {
      const profile = await actions.profile({ name: values.get("profileName") });
      (document.querySelector("[data-vault-profile-form] .form-status") || status).textContent = profile.synced ? "Private name encrypted and synced." : "Private name saved here; sync pending.";
    }
    catch (error) { status.textContent = error.message; }
  });
}
