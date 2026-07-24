export function renderTrustedDevicesView(state) {
  const devices = state.trustedDevices || [];
  return `<section class="view-head"><div><span class="eyebrow">Vault access</span><h1>Trusted devices</h1><p>These devices can act on your vault. Revoke any device you no longer recognize or no longer own.</p></div></section>
  <div class="panel"><table class="device-table"><thead><tr><th>Device</th><th>Type</th><th>Added</th><th>Last active</th><th>Status</th><th></th></tr></thead><tbody>
  ${devices.map((device) => `<tr><td>${device.label}</td><td>${device.deviceType}</td><td>${device.registeredAt ? new Date(device.registeredAt).toLocaleDateString() : "—"}</td><td>${device.lastActiveAt ? new Date(device.lastActiveAt).toLocaleString() : "—"}</td><td><span class="status-pill status-pill--${device.status === "trusted" ? "safe" : "danger"}">${device.status}</span></td><td>${device.deviceType !== "owner" && device.status === "trusted" ? `<button class="text-button text-button--danger" type="button" data-revoke-device="${device.deviceId}">Revoke</button>` : ""}</td></tr>`).join("")}
  </tbody></table>${!devices.length ? "<p>No devices yet.</p>" : ""}</div>`;
}

export function bindTrustedDevicesView(actions) {
  document.querySelectorAll("[data-revoke-device]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Revoke this device? It will no longer be able to act on this vault.")) return;
    button.disabled = true;
    try { await actions.revoke(button.dataset.revokeDevice); } catch (error) { alert(error.message); button.disabled = false; }
  }));
}
