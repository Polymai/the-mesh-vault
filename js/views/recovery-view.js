export function renderRecoveryView(state) {
  const saved = !!state.identity?.meshKeySaved;
  return `<section class="view-head"><div><span class="eyebrow">Offline recovery</span><h1>Mesh Key</h1><p>Your Mesh Key is the only way back into your vault if this device is lost. No account can replace it.</p></div><span class="status-pill status-pill--${saved ? "safe" : "warning"}">${saved ? "Saved" : "Not saved yet"}</span></section>
  <div class="recovery-layout">
    <section class="panel"><h2>${saved ? "Your Mesh Key" : "Save your Mesh Key"}</h2><p>Download it, scan the QR code onto another device, or copy the recovery phrase. Keep it offline and private.</p><div class="recovery-output" data-recovery-output><span>Your recovery phrase</span><div class="recovery-output__preview"><code data-recovery-phrase></code><div data-recovery-qr role="img" aria-label="QR code containing the Mesh Key"></div></div><div class="button-row"><button type="button" class="button button--small" data-download-recovery>Download Mesh Key</button><button type="button" class="button button--ghost button--small" data-copy-recovery>Copy phrase</button><button type="button" class="button button--ghost button--small" data-print-recovery>Print</button></div></div><button class="button" type="button" data-save-recovery>${saved ? "Mesh Key saved" : "I've saved my Mesh Key"}</button><p class="form-status" role="status"></p></section>
    <aside class="panel recovery-checklist"><span class="eyebrow">Safe storage checklist</span><ol><li>Keep the phrase offline.</li><li>Store it separately from this device.</li><li>Never send it in chat or email.</li></ol><p class="honest-warning">If every trusted device is lost before this Mesh Key is saved elsewhere, the vault may become permanently inaccessible.</p><form data-verify-recovery><label>Verify a saved phrase<textarea name="phrase" rows="3" autocomplete="off" required aria-label="Verify a saved phrase"></textarea></label><button class="button button--ghost" type="submit">Verify locally</button><p class="form-status" role="status"></p></form></aside>
  </div>`;
}

export function bindRecoveryView({ phrase, qr, file, verify, save }) {
  const output = document.querySelector("[data-recovery-output]"); const status = document.querySelector("section.panel .form-status"); const currentPhrase = phrase();
  if (output) {
    output.querySelector("[data-recovery-phrase]").textContent = currentPhrase || "";
    const qrTarget = output.querySelector("[data-recovery-qr]");
    if (window.QRCode && currentPhrase && qrTarget) new window.QRCode(qrTarget, { text: qr(), width: 180, height: 180, colorDark: "#07111f", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
  }
  document.querySelector("[data-download-recovery]")?.addEventListener("click", () => {
    const blob = file(); if (!blob) return; const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "themeshvault-mesh-key.json"; link.click(); URL.revokeObjectURL(url);
  });
  document.querySelector("[data-copy-recovery]")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(currentPhrase || ""); status.textContent = "Phrase copied."; } catch { status.textContent = "Could not copy automatically - select the phrase manually."; }
  });
  document.querySelector("[data-save-recovery]")?.addEventListener("click", async () => { await save(); status.textContent = "Mesh Key marked as saved."; });
  document.querySelector("[data-print-recovery]")?.addEventListener("click", () => window.print());
  document.querySelector("[data-verify-recovery]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const result = event.target.querySelector(".form-status");
    try { result.textContent = (await verify(new FormData(event.target).get("phrase"))) ? "This phrase matches your vault." : "This phrase does not match your vault."; } catch (error) { result.textContent = error.message; }
  });
}
