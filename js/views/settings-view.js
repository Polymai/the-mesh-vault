import { patientZeroOperatorEnabled } from "../platform/patient-zero-operator.js";

const gb = (bytes) => Math.round(Number(bytes || 0) / 107374182.4) / 10;
const compactBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(bytes >= 10737418240 ? 0 : 1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};
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
    available: { status: "Off", detail: "Get a notification when the mesh needs this device back online.", label: "Enable", action: "enable", disabled: false },
    "permission needed": { status: "Off", detail: "Get a notification when the mesh needs this device back online.", label: "Enable", action: "enable", disabled: false },
    ready: { status: "On", detail: "The mesh can remind you to bring this device online.", label: "Disable", action: "disable", disabled: false },
    blocked: { status: "Blocked", detail: "Change this site's notification permission to use reminders.", label: "Blocked", action: "", disabled: true },
    unsupported: { status: "Unavailable", detail: "This browser does not support node reminders.", label: "Unavailable", action: "", disabled: true },
    unavailable: { status: "Needs attention", detail: "Reminders could not be enabled. You can retry later.", label: "Retry", action: "enable", disabled: false },
    "brave setup needed": { status: "Brave push needs setup", detail: "Enable Brave's push-messaging service, restart Brave, then retry.", label: "Retry", action: "enable", disabled: false },
    "setup needed": { status: "Network setup needed", detail: "Reminders are not configured on the network.", label: "Retry", action: "enable", disabled: false },
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
  const maxContributionGb = gb(window.__DATA__?.limits?.maxContributionBytes || 2147483648000);
  const nativeNode = state.nativeNode || {};
  const contributionLimitBytes = Number(state.contributionLimitBytes ?? state.node.capacityBytes) || 0;
  const deviceOnline = state.node.status === "online" || nativeNode.running;
  const operatorSection = patientZeroOperatorEnabled() ? `<section class="panel settings-section patient-zero-settings-card"><div class="settings-section-head"><div><span class="eyebrow">Operator</span><h2>Patient Zero</h2><p>Public bootstrap setup for this deployment.</p></div></div><div class="setting-row"><div><strong>Deployment tools</strong><span>Export public trust from this browser profile.</span></div><a class="button button--ghost" href="#/anchor">Open</a></div><button class="text-button" type="button" data-disable-patient-zero>Hide operator tools on this device</button></section>` : "";
  const nativeDeviceRows = nativeNode.supported ? `<div class="setting-row"><div><strong>Keep helping when closed</strong><span>${nativeNode.running ? "On. Android keeps this device available with a system notification." : nativeNode.enabled ? "Will resume after the Android service restarts." : "Off. This device still helps while the app is open."}</span></div><button class="button button--ghost" type="button" data-native-node-toggle="${nativeNode.enabled || nativeNode.running ? "off" : "on"}">${nativeNode.enabled || nativeNode.running ? "Turn off" : "Turn on"}</button></div>${nativeNode.enabled || nativeNode.running ? `<div class="setting-row"><div><strong>Battery use</strong><span>Allow unrestricted battery use for the most reliable availability.</span></div><button class="button button--ghost" type="button" data-native-power>Open settings</button></div>` : ""}<div class="setting-row"><div><strong>Android storage</strong><span>${compactBytes(nativeNode.usedBytes)} · ${Number(nativeNode.shardCount || 0)} encrypted pieces</span></div><button class="button button--ghost button--danger" type="button" data-native-clear ${nativeNode.running ? "disabled" : ""}>Remove</button></div>${nativeNode.lastError ? `<p class="form-status form-status--error">${esc(nativeNode.lastError)}</p>` : ""}<p class="form-status" data-native-node-status role="status"></p>` : "";
  const installSection = `<section class="panel settings-section pwa-install-panel"><div class="settings-section-head"><h2>Install or share TheMeshVault</h2></div><div class="pwa-install-row"><span class="pwa-install-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="3"/><path d="M9 6.5h6M12 16v-5m0 5-2-2m2 2 2-2"/><circle cx="12" cy="18.5" r=".5"/></svg></span><div><strong>${esc(install.label)}</strong><span>${esc(install.detail)}</span></div>${install.button}</div><div class="pwa-share-row"><a class="pwa-public-link" href="${esc(publicUrl)}" target="_blank" rel="noopener" aria-label="Open the public TheMeshVault link">${esc(publicUrl)}</a><div class="pwa-share-actions"><button class="button button--ghost" type="button" data-share-app>Share TheMeshVault</button><button class="button button--ghost" type="button" data-copy-app-link>Copy link</button></div></div><p class="form-status" data-install-status role="status"></p></section>`;
  const meshKeyReady = Boolean(state.identity?.meshKeySaved);
  const dangerZone = state.identity ? `<section class="panel settings-section danger-zone-panel"><div class="settings-section-head"><h2>Danger zone</h2></div><div class="setting-row setting-row--danger"><div><strong>Remove vault from this device</strong><span>${meshKeyReady ? "Forget this vault here without deleting its files from the mesh." : "Save your Mesh Key before removing local access."}</span>${meshKeyReady ? "" : `<a class="text-button" href="#/recovery">Save Mesh Key first</a>`}</div><button class="button button--ghost button--danger" type="button" data-open-device-reset ${meshKeyReady ? "" : "disabled"}>Remove</button></div><div class="setting-row setting-row--danger"><div><strong>Delete vault contents</strong><span>Delete every file, revoke known links and remove this device's access.</span></div><button class="button button--danger" type="button" data-open-vault-delete>Delete</button></div></section>
    <dialog class="dialog danger-dialog" data-device-reset-dialog><form method="dialog" data-device-reset-form><div class="dialog-head"><div><span class="eyebrow">This device only</span><h2>Remove this vault?</h2></div><button type="button" data-close-device-reset aria-label="Close">Close</button></div><p>Your Mesh Key and private vault data will be removed from this browser. Files remain in the mesh and can be opened again with your saved Mesh Key.</p><div class="danger-dialog__note">This device keeps its node identity, Patient Zero settings and encrypted pieces stored for other vaults.</div><p class="form-status form-status--error" data-device-reset-status role="status"></p><div class="dialog-actions danger-dialog__actions"><button class="button button--ghost" type="button" data-close-device-reset>Cancel</button><button class="button button--danger" type="submit">Remove from this device</button></div></form></dialog>
  <dialog class="dialog danger-dialog" data-vault-delete-dialog><form method="dialog" data-vault-delete-form><div class="dialog-head"><div><span class="eyebrow">Vault contents</span><h2>Delete everything?</h2></div><button type="button" data-close-vault-delete aria-label="Close">Close</button></div><p>TheMeshVault will delete every file, revoke known share links and send signed erase orders to known storage nodes. Offline nodes erase unreadable encrypted pieces when they reconnect.</p><div class="danger-dialog__note">A minimal pseudonymous coordination record may remain. This cannot recall plaintext already downloaded through a share link.</div><label><span>Type DELETE to continue</span><input name="confirmation" autocomplete="off" spellcheck="false" placeholder="DELETE"></label><p class="form-status" data-vault-delete-status role="status"></p><div class="dialog-actions danger-dialog__actions"><button class="button button--ghost" type="button" data-close-vault-delete>Cancel</button><button class="button button--danger" type="submit">Delete vault contents</button></div></form></dialog>` : "";
  return `<section class="view-head view-head--compact"><div><h1>Settings</h1></div><span class="status-pill status-pill--${deviceOnline ? "safe" : "neutral"}">${deviceOnline ? "online" : state.node.status}</span></section>
  <div class="settings-grid">
    <section class="panel settings-section"><div class="settings-section-head"><h2>Storage you share</h2></div><form class="capacity-form" data-capacity-form><label class="capacity-entry"><span>Space to share</span><span class="input-with-unit"><input type="number" name="capacity" inputmode="decimal" min="0" max="${maxContributionGb}" step="1" value="${gb(contributionLimitBytes)}" required><b>GB</b></span><small>Enter 0 to stop sharing. Your device may set a lower practical limit.</small></label><button class="button" type="submit">Save</button><p class="form-status" role="status"></p></form></section>
    ${wakeAssistanceSection(state.survival)}
    ${state.identity ? `<section class="panel settings-section"><div class="settings-section-head"><h2>File protection</h2></div><form data-resilience-form><label><span>Protection mode</span><select name="resilienceClass"><option value="auto" ${state.erasureClass === "auto" ? "selected" : ""}>Automatic · recommended</option><option value="standard" ${state.erasureClass === "standard" ? "selected" : ""}>Balanced · less extra storage</option><option value="high" ${state.erasureClass === "high" ? "selected" : ""}>Extra · stronger at 16 nodes</option></select></label><details class="settings-technical"><summary>Technical details</summary><p>Automatic grows from 3+2 to 8+4 and then 10+6 as independent nodes join. Balanced uses 12+4 at 16 nodes; Extra uses 10+6.</p></details><button class="button" type="submit">Save protection</button><p class="form-status" role="status"></p></form></section>` : ""}
    <section class="panel settings-section"><div class="settings-section-head"><h2>This device</h2></div><form class="node-name-form" data-node-name-form><label><span>Device name</span><input name="nodeName" maxlength="80" autocomplete="off" placeholder="Browser node" value="${esc(state.node.label || "Browser node")}" required><small>Visible in Live Mesh.</small></label><button class="button button--ghost" type="submit">Save name</button><p class="form-status" role="status"></p></form>${nativeDeviceRows}<div class="setting-row"><div><strong>Stored pieces</strong><span>Encrypted data held for the mesh.</span></div><a class="button button--ghost" href="#/hosted-storage">View</a></div><div class="setting-row"><div><strong>Protect storage</strong><span>${state.node.persistence === "granted" ? "Protected from routine browser cleanup." : "Ask the browser to keep saved pieces."}</span></div><button class="button button--ghost" type="button" data-persist-storage ${state.node.persistence === "granted" ? "disabled" : ""}>${state.node.persistence === "granted" ? "Protected" : "Protect"}</button></div><div class="setting-row"><div><strong>Location</strong><span>${esc(nodeLocation.detail)}</span></div><strong class="node-location-value">${esc(nodeLocation.label)}</strong></div><div class="setting-row setting-row--danger"><div><strong>Remove stored pieces</strong><span>Files may need repair elsewhere.</span></div><button class="button button--danger" type="button" data-clear-storage>Remove</button></div></section>
    ${state.identity ? `<section class="panel settings-section vault-identity-panel"><div class="settings-section-head"><h2>Vault access</h2></div><div class="setting-row"><div><strong>Vault ID</strong><span class="mono-id">${state.identity.vaultId.slice(0, 24)}…</span></div></div><form class="vault-profile-form" data-vault-profile-form><div class="vault-profile-fields"><label><span>Private vault name (optional)</span><input name="profileName" maxlength="80" autocomplete="off" placeholder="My vault" value="${esc(profile.name)}"><small>${esc(privateNameStatus)}</small></label></div><div class="vault-profile-actions"><button class="button button--ghost" type="submit">Save private name</button></div><p class="form-status" role="status"></p></form><div class="setting-row"><div><strong>Mesh Key</strong><span>${state.identity.meshKeySaved ? "Saved" : "Not saved"}</span></div><a class="button button--ghost" href="#/recovery">Manage</a></div><div class="setting-row"><div><strong>Optional account</strong></div><a class="button button--ghost" href="#/account">Connect</a></div></section>` : `<section class="panel settings-section"><div class="settings-section-head"><h2>Storage-only device</h2></div><a class="button" href="#/onboarding">Create a vault</a></section>`}
    ${operatorSection}
    ${dangerZone}
    ${installSection}
  </div>`;
}

export function bindSettingsView(actions) {
  const installStatus = document.querySelector("[data-install-status]");
  const deviceResetDialog = document.querySelector("[data-device-reset-dialog]");
  const vaultDeleteDialog = document.querySelector("[data-vault-delete-dialog]");
  document.querySelector("[data-open-device-reset]")?.addEventListener("click", () => deviceResetDialog?.showModal());
  document.querySelectorAll("[data-close-device-reset]").forEach((button) => button.addEventListener("click", () => deviceResetDialog?.close()));
    document.querySelector("[data-device-reset-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (event.submitter) event.submitter.disabled = true;
      try { await actions.removeVaultFromDevice(); }
      catch (error) {
        if (event.submitter) event.submitter.disabled = false;
        const status = event.currentTarget.querySelector("[data-device-reset-status]");
        if (status) status.textContent = error.message;
      }
  });
  document.querySelector("[data-open-vault-delete]")?.addEventListener("click", () => vaultDeleteDialog?.showModal());
  document.querySelectorAll("[data-close-vault-delete]").forEach((button) => button.addEventListener("click", () => vaultDeleteDialog?.close()));
  document.querySelector("[data-vault-delete-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector("[data-vault-delete-status]");
    if (new FormData(form).get("confirmation") !== "DELETE") {
      status.textContent = "Type DELETE exactly to continue.";
      return;
    }
    Array.from(form.elements).forEach((control) => { control.disabled = true; });
    status.textContent = "Preparing signed deletion ordersâ€¦";
    try {
      await actions.deleteVaultContents(({ step, completed, total }) => {
        const current = document.querySelector("[data-vault-delete-status]");
        if (!current) return;
        current.textContent = step === "publishing"
          ? "Publishing signed deletion ordersâ€¦"
          : `Deleting files ${completed}/${total}â€¦`;
      });
    } catch (error) {
      Array.from(form.elements).forEach((control) => { control.disabled = false; });
      status.textContent = `Deletion stopped before this device forgot the vault. Some file deletions may already be complete. ${error.message}`;
    }
  });
  document.querySelector("[data-disable-patient-zero]")?.addEventListener("click", () => actions.disablePatientZeroOperator());
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
  document.querySelector("[data-native-node-toggle]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget; const status = document.querySelector("[data-native-node-status]");
    button.disabled = true;
    if (status) status.textContent = button.dataset.nativeNodeToggle === "on" ? "Starting Android node…" : "Stopping Android node…";
    try { await actions.nativeNode(button.dataset.nativeNodeToggle === "on"); }
    catch (error) { if (status) status.textContent = error.message; button.disabled = false; }
  });
  document.querySelector("[data-native-power]")?.addEventListener("click", () => actions.nativePowerSettings());
  document.querySelector("[data-native-clear]")?.addEventListener("click", async (event) => {
    if (!confirm("Remove all encrypted pieces stored by the Android app? Files may need repair on other nodes.")) return;
    const button = event.currentTarget; const status = document.querySelector("[data-native-node-status]"); button.disabled = true;
    try { await actions.clearNativeStorage(); if (status) status.textContent = "Android pieces removed."; }
    catch (error) { if (status) status.textContent = error.message; button.disabled = false; }
  });
  document.querySelector("[data-capacity-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status");
    const value = Number(new FormData(event.target).get("capacity"));
    const maximum = Number(event.target.elements.capacity.max);
    if (!Number.isFinite(value) || value < 0 || value > maximum) { status.textContent = `Enter a value from 0 to ${maximum} GB.`; return; }
    try { await actions.capacity(value * 1073741824); status.textContent = `${value} GB shared from this device.`; } catch (error) { status.textContent = error.message; }
  });
  document.querySelector("[data-node-name-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status"); const value = new FormData(event.target).get("nodeName");
    try {
      await actions.nodeName(value);
      (document.querySelector("[data-node-name-form] .form-status") || status).textContent = "Public node name saved.";
    }
    catch (error) { status.textContent = error.message; }
  });
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
