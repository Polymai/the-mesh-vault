export function renderRecoveryView(state) {
  const saved = !!state.identity?.meshKeySaved;
  return `<section class="view-head view-head--compact"><div><h1>Mesh Key</h1></div><span class="status-pill status-pill--${saved ? "safe" : "warning"}">${saved ? "Saved" : "Not saved"}</span></section>
  <div class="recovery-layout">
    <section class="panel"><div class="recovery-output" data-recovery-output><span>24-word Mesh Key</span><div class="recovery-output__preview"><code data-recovery-phrase></code><div data-recovery-qr role="img" aria-label="QR code containing the Mesh Key"></div></div><div class="button-row"><button type="button" class="button button--small" data-download-recovery>Download Mesh Key file</button><button type="button" class="button button--ghost button--small" data-copy-recovery>Copy</button><button type="button" class="button button--ghost button--small" data-print-recovery>Print</button></div><small>The words and the file are two forms of the same secret. Either one restores this vault by itself.</small></div><p class="form-status" role="status">${saved ? "Your saved state was verified with a complete 24-word re-entry." : "Re-enter all 24 words to verify the backup and mark it as saved."}</p></section>
    <aside class="panel recovery-checklist"><h2>Keep it safe</h2><ol><li>Keep it offline.</li><li>Store it away from this device.</li><li>Never share it.</li></ol><p class="honest-warning">TheMeshVault cannot reset or recreate this key. No recovery copy is sent to Supabase, Anchors or storage nodes.</p><form data-verify-recovery><label>Verify your 24 words<textarea name="phrase" rows="5" autocomplete="off" spellcheck="false" required aria-label="Verify your 24-word Mesh Key"></textarea></label><button class="button button--ghost" type="submit">${saved ? "Verify again" : "Verify and mark as saved"}</button><p class="form-status" role="status"></p></form></aside>
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
  document.querySelector("[data-print-recovery]")?.addEventListener("click", () => window.print());
  document.querySelector("[data-verify-recovery]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = event.target.querySelector(".form-status");
    const button = event.target.querySelector("button[type='submit']");
    const phraseField = event.target.elements.phrase;
    button.disabled = true;
    try {
      const matches = await verify(new FormData(event.target).get("phrase"));
      if (!matches) {
        result.textContent = "This phrase does not match your vault.";
        return;
      }
      phraseField.value = "";
      result.textContent = "Phrase verified. Marking this Mesh Key as saved...";
      await save();
    } catch (error) {
      result.textContent = error.message;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
}
