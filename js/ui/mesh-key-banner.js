let dismissed = false;
export function shouldShowMeshKeyBanner(state) { return !!state.identity && !state.identity.meshKeySaved && (state.files?.length || 0) > 0 && !dismissed; }
export function renderMeshKeyBanner() {
  return `<div class="mesh-key-banner" role="status"><strong>Save your Mesh Key</strong><p>No account is required. Your Mesh Key is needed to access your files from another device if this device is lost. Losing every trusted device before saving it may make your vault permanently inaccessible.</p><div class="button-row"><a class="button button--small" href="#/recovery">Download Mesh Key</a><a class="button button--ghost button--small" href="#/recovery">Show recovery QR code</a><a class="button button--ghost button--small" href="#/recovery">Copy recovery phrase</a><a class="button button--ghost button--small" href="#/account">Add optional account</a><button type="button" class="text-button" data-mesh-key-dismiss>Remind me later</button></div></div>`;
}
export function bindMeshKeyBanner() {
  document.querySelector("[data-mesh-key-dismiss]")?.addEventListener("click", () => { dismissed = true; document.querySelector(".mesh-key-banner")?.remove(); });
}
