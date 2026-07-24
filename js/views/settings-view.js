const gb = (bytes) => Math.round(Number(bytes || 0) / 107374182.4) / 10;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
function countryLabel(code) {
  if (!code) return "";
  try { return `${new Intl.DisplayNames(["en"], { type: "region" }).of(String(code).toUpperCase())} (${String(code).toUpperCase()})`; }
  catch { return String(code).toUpperCase(); }
}
function automaticLocation(node = {}) {
  const label = [node.regionCode, countryLabel(node.countryCode)].filter(Boolean).join(", ") || "Unknown";
  if (node.locationSource === "browser_coarse") return { label, detail: "Detected automatically. Only the country is kept, helping the mesh spread copies across different places." };
  if (node.locationSource === "edge_hint") return { label, detail: "Estimated automatically from the connection. Only a broad area is used, never an exact address." };
  return { label, detail: "Location is not available. TheMeshVault leaves it unknown instead of guessing." };
}

export function renderSettingsView(state) {
  const profile = state.vaultProfile || { name: "" };
  const nodeLocation = automaticLocation(state.node);
  return `<section class="view-head"><div><span class="eyebrow">This device</span><h1>Storage settings</h1><p>Choose how this browser helps the mesh and how strongly your files should be protected.</p></div><span class="status-pill status-pill--${state.node.status === "online" ? "safe" : "neutral"}">${state.node.status}</span></section>
  <div class="settings-grid">
    <section class="panel settings-section"><div class="settings-section-head"><span class="eyebrow">Shared space</span><h2>Storage you share</h2><p>Set the maximum space this browser may lend to other people’s encrypted file pieces.</p></div><form data-capacity-form><label class="range-label"><span><strong>Maximum space on this browser</strong><output>${gb(state.node.capacityBytes)} GB</output></span><input type="range" name="capacity" min="0" max="10" step="0.25" value="${gb(state.node.capacityBytes)}"></label><p class="settings-help">This limit applies only to TheMeshVault. It does not include your own files or data from other websites.</p><button class="button" type="submit">Save storage limit</button><p class="form-status" role="status"></p></form></section>
    ${state.identity ? `<section class="panel settings-section"><div class="settings-section-head"><span class="eyebrow">Your files</span><h2>Protection level</h2><p>Choose how many devices may go offline while your files can still be recovered.</p></div><form data-resilience-form><label><span>When 16 separate devices are available</span><select name="resilienceClass"><option value="standard" ${state.erasureClass !== "high" ? "selected" : ""}>Balanced · 4 devices may go offline</option><option value="high" ${state.erasureClass === "high" ? "selected" : ""}>Extra · 6 devices may go offline</option></select></label><p class="settings-help">TheMeshVault adjusts automatically when fewer devices are online. A file is only shown as protected after enough separate devices confirm that they hold its pieces.</p><details class="settings-technical"><summary>Technical details</summary><p>Balanced uses a 12+4 profile with 33% extra storage. Extra protection uses 10+6 with 60% extra storage. Smaller meshes use the safest available profile from 3+2 through 7+3.</p></details><button class="button" type="submit">Save protection level</button><p class="form-status" role="status"></p></form></section>` : ""}
    <section class="panel settings-section"><div class="settings-section-head"><span class="eyebrow">Availability</span><h2>This device</h2><p>Control when this browser helps the mesh and how its saved pieces are protected.</p></div><div class="setting-row"><div><strong>Help the mesh</strong><span>Allow this browser to store and send encrypted pieces while TheMeshVault is open.</span></div><button class="button button--ghost" type="button" data-toggle-node>${state.node.status === "online" ? "Pause" : "Resume"}</button></div><div class="setting-row"><div><strong>Protect stored pieces</strong><span>${state.node.persistence === "granted" ? "The browser has agreed not to remove them during routine cleanup." : "Ask the browser not to remove TheMeshVault storage automatically."}</span></div><button class="button button--ghost" type="button" data-persist-storage ${state.node.persistence === "granted" ? "disabled" : ""}>${state.node.persistence === "granted" ? "Protected" : "Protect"}</button></div><div class="setting-row"><div><strong>Country or broad area</strong><span>${esc(nodeLocation.detail)}</span></div><strong class="node-location-value">${esc(nodeLocation.label)}</strong></div><div class="setting-row setting-row--danger"><div><strong>Remove stored pieces</strong><span>Other devices may need to rebuild protection for affected files.</span></div><button class="button button--danger" type="button" data-clear-storage>Remove from this browser</button></div></section>
    ${state.identity ? `<section class="panel settings-section vault-identity-panel"><div class="settings-section-head"><span class="eyebrow">Your access</span><h2>Vault and recovery</h2><p>Manage the name, recovery key and devices that can open this vault.</p></div><div class="setting-row"><div><strong>Vault ID</strong><span class="mono-id">${state.identity.vaultId.slice(0, 24)}…</span><small>A unique technical ID for this vault.</small></div></div><form class="vault-profile-form" data-vault-profile-form><div class="vault-profile-fields"><label><span>Name (optional)</span><input name="profileName" maxlength="80" autocomplete="name" placeholder="What should this vault call you?" value="${esc(profile.name)}"></label></div><div class="vault-profile-actions"><p>Saved privately for this vault. It does not affect where files are stored.</p><button class="button button--ghost" type="submit">Save name</button></div><p class="form-status" role="status"></p></form><div class="setting-row"><div><strong>Mesh Key</strong><span>${state.identity.meshKeySaved ? "Saved safely" : "Not saved yet"}</span><small>Your Mesh Key can restore the vault on another device.</small></div><a class="button button--ghost" href="#/recovery">Manage</a></div><div class="setting-row"><div><strong>Trusted devices</strong><span>Choose which devices may open and manage this vault.</span></div><a class="button button--ghost" href="#/trusted-devices">Manage</a></div><div class="setting-row"><div><strong>Optional account</strong><span>Add an account for convenience. Your Mesh Key still controls the vault.</span></div><a class="button button--ghost" href="#/account">Connect</a></div></section>` : `<section class="panel settings-section"><div class="settings-section-head"><span class="eyebrow">Current mode</span><h2>Storage-only device</h2><p>This browser helps store encrypted pieces without having its own vault.</p></div><a class="button" href="#/onboarding">Create a vault</a></section>`}
  </div>`;
}

export function bindSettingsView(actions) {
  const range = document.querySelector("[name='capacity']");
  range?.addEventListener("input", () => { range.closest("label").querySelector("output").textContent = `${range.value} GB`; });
  document.querySelector("[data-capacity-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status");
    try { await actions.capacity(Number(new FormData(event.target).get("capacity")) * 1073741824); status.textContent = "Storage limit saved."; } catch (error) { status.textContent = error.message; }
  });
  document.querySelector("[data-toggle-node]")?.addEventListener("click", actions.toggleNode);
  document.querySelector("[data-resilience-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status"); const value = new FormData(event.target).get("resilienceClass");
    try { const saved = await actions.resilienceClass(value); status.textContent = saved === "high" ? "Extra protection saved." : "Balanced protection saved."; }
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
    try { await actions.profile({ name: values.get("profileName") }); status.textContent = "Name saved."; }
    catch (error) { status.textContent = error.message; }
  });
}
