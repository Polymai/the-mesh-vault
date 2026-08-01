import { hasCurrentLegalAcceptance, recordLegalAcceptance } from "../legal/acceptance.js";

export function renderOnboardingView() {
  return `<section class="auth-layout onboarding-layout">
    <div class="auth-story">
      <span class="eyebrow">No account required</span>
      <h1>Open your vault.</h1>
      <p>Your Mesh Key is created on this device.</p>
    </div>
    <div class="auth-card onboarding-card">
      <div class="onboarding-menu" data-onboard-menu>
        <h2>Get started</h2>
        <button class="onboarding-primary" type="button" data-onboard="anonymous">
          <span>Open a new vault</span><small>Creates your Mesh Key on this device</small>
        </button>
        <div class="onboarding-divider"><span>Other options</span></div>
        <button class="onboarding-option" type="button" data-onboard-toggle="restore">
          <span><strong>Restore an existing vault</strong><small>Use your recovery phrase or complete Mesh Key file</small></span><i aria-hidden="true">→</i>
        </button>
        <button class="onboarding-option" type="button" data-onboard-toggle="node">
          <span><strong>Contribute storage only</strong><small>Join the mesh without creating a personal vault</small></span><i aria-hidden="true">→</i>
        </button>
        <button class="onboarding-account-link" type="button" data-onboard-toggle="account">Optional account <span aria-hidden="true">→</span></button>
        <p class="form-status" role="status" data-onboard-status></p>
      </div>

      <form class="onboarding-panel" data-onboard-panel="restore" hidden>
        <button class="onboarding-back" type="button" data-onboard-back>← All options</button>
        <h2>Restore your vault</h2>
        <div class="recovery-switch" role="tablist" aria-label="Recovery method">
          <button type="button" role="tab" aria-selected="true" data-recovery-mode="file">Mesh Key file</button>
          <button type="button" role="tab" aria-selected="false" data-recovery-mode="phrase">Recovery phrase</button>
        </div>
        <section class="recovery-method-panel" data-recovery-method="file">
          <label class="key-file-picker">
            <input type="file" name="file" accept=".json,application/json" aria-label="Mesh Key file">
            <span><strong>Choose Mesh Key file</strong><small data-key-file-name>Select your saved key file</small></span>
            <i aria-hidden="true">Browse</i>
          </label>
          <div class="recovery-legacy-warning" data-legacy-key-warning role="alert" hidden><strong>Older key file</strong><span>This file also needs its matching recovery phrase.</span></div>
          <label class="onboarding-field" data-legacy-phrase hidden><span>Recovery phrase</span><textarea name="legacyPhrase" rows="2" autocomplete="off" spellcheck="false" placeholder="word-word-word-word-word-word" aria-label="Older key file recovery phrase"></textarea></label>
        </section>
        <section class="recovery-method-panel" data-recovery-method="phrase" hidden>
          <label class="onboarding-field"><span>Recovery phrase</span><textarea name="phrase" rows="2" autocomplete="off" spellcheck="false" placeholder="word-word-word-word-word-word" aria-label="Recovery phrase"></textarea></label>
        </section>
        <button class="button onboarding-submit" type="submit">Restore vault</button>
        <p class="form-status" role="status"></p>
      </form>

      <div class="onboarding-panel" data-onboard-panel="node" hidden>
        <button class="onboarding-back" type="button" data-onboard-back>← All options</button>
        <h2>Contribute storage</h2>
        <p>Join without creating a vault.</p>
        <button class="button onboarding-submit" type="button" data-onboard="node">Join the mesh</button>
        <p class="form-status" role="status" data-node-status></p>
      </div>

      <div class="onboarding-panel" data-onboard-panel="account" hidden>
        <button class="onboarding-back" type="button" data-onboard-back>← All options</button>
        <h2>Optional account</h2>
        <p>Create the vault first, then connect an account in Settings.</p>
        <button class="button onboarding-submit" type="button" data-onboard="anonymous">Create my vault</button>
      </div>
    </div>
  </section>
  <dialog class="legal-consent" data-legal-consent aria-labelledby="legal-consent-title">
    <form data-legal-consent-form>
      <div class="legal-consent__head"><h2 id="legal-consent-title">Create your vault</h2><button class="legal-consent__close" type="button" data-close-legal aria-label="Close">×</button></div>
      <div class="legal-consent__key"><strong>Save your Mesh Key.</strong><span>It is the only way to restore your vault on a new device.</span></div>
      <label class="legal-consent__check"><input type="checkbox" name="termsAccepted" required><span>I agree to the <a href="#/terms" target="_blank" rel="noopener">Terms of Service</a> and acknowledge the <a href="#/privacy" target="_blank" rel="noopener">Privacy Notice</a>.</span></label>
      <div class="legal-consent__actions"><button class="button button--ghost" type="button" data-close-legal>Cancel</button><button class="button" type="submit" data-confirm-legal disabled>Create my vault</button></div>
      <p class="form-status" role="status" data-legal-status></p>
    </form>
  </dialog>`;
}

export function bindOnboardingView(actions) {
  const menu = document.querySelector("[data-onboard-menu]");
  const panels = [...document.querySelectorAll("[data-onboard-panel]")];
  const showMenu = () => {
    if (menu) menu.hidden = false;
    panels.forEach((panel) => { panel.hidden = true; });
  };
  document.querySelectorAll("[data-onboard-toggle]").forEach((button) => button.addEventListener("click", () => {
    const target = button.dataset.onboardToggle;
    if (menu) menu.hidden = true;
    panels.forEach((panel) => { panel.hidden = panel.dataset.onboardPanel !== target; });
    document.querySelector(`[data-onboard-panel='${target}'] h2`)?.focus?.();
  }));
  document.querySelectorAll("[data-onboard-back]").forEach((button) => button.addEventListener("click", showMenu));

  const topStatus = document.querySelector("[data-onboard-status]");
  const legalDialog = document.querySelector("[data-legal-consent]");
  const legalForm = document.querySelector("[data-legal-consent-form]");
  const legalCheckbox = legalForm?.elements?.termsAccepted;
  const legalConfirm = document.querySelector("[data-confirm-legal]");
  const legalStatus = document.querySelector("[data-legal-status]");
  document.querySelectorAll("[data-onboard='anonymous']").forEach((button) => button.addEventListener("click", () => {
    if (!legalDialog || !legalCheckbox || !legalConfirm) return;
    legalCheckbox.checked = hasCurrentLegalAcceptance();
    legalConfirm.disabled = !legalCheckbox.checked;
    if (legalStatus) legalStatus.textContent = "";
    legalDialog.showModal();
    legalCheckbox.focus();
  }));
  legalCheckbox?.addEventListener("change", () => { legalConfirm.disabled = !legalCheckbox.checked; });
  document.querySelectorAll("[data-close-legal]").forEach((button) => button.addEventListener("click", () => legalDialog?.close()));
  legalForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!legalCheckbox.checked) return;
    legalConfirm.disabled = true;
    if (legalStatus) legalStatus.textContent = "Creating your cryptographic vault…";
    if (topStatus) topStatus.textContent = "Creating your no-account vault…";
    try {
      recordLegalAcceptance();
      await actions.continueAnonymous();
    } catch (error) {
      if (legalStatus) legalStatus.textContent = error.message;
      if (topStatus) topStatus.textContent = error.message;
      legalConfirm.disabled = false;
    }
  });
  document.querySelector("[data-onboard='node']")?.addEventListener("click", async (event) => {
    const button = event.currentTarget; const status = document.querySelector("[data-node-status]"); button.disabled = true; if (status) status.textContent = "Activating this device as a storage node…";
    try { await actions.joinAsStorageNode(); } catch (error) { if (status) status.textContent = error.message; button.disabled = false; }
  });
  const fileInput = document.querySelector("[data-onboard-panel='restore'] input[type='file']");
  const restoreForm = document.querySelector("[data-onboard-panel='restore']");
  const recoveryModeButtons = [...document.querySelectorAll("[data-recovery-mode]")];
  const setRecoveryMode = (mode) => {
    if (!restoreForm) return;
    restoreForm.dataset.recoveryMode = mode;
    recoveryModeButtons.forEach((button) => button.setAttribute("aria-selected", String(button.dataset.recoveryMode === mode)));
    document.querySelectorAll("[data-recovery-method]").forEach((panel) => {
      panel.hidden = panel.dataset.recoveryMethod !== mode;
    });
  };
  recoveryModeButtons.forEach((button) => button.addEventListener("click", () => setRecoveryMode(button.dataset.recoveryMode)));
  setRecoveryMode("file");
  fileInput?.addEventListener("change", async () => {
    const label = document.querySelector("[data-key-file-name]");
    const legacyWarning = document.querySelector("[data-legacy-key-warning]");
    const legacyPhrase = document.querySelector("[data-legacy-phrase]");
    const file = fileInput.files?.[0];
    if (!label) return;
    if (!file) {
      label.textContent = "Select your saved key file";
      if (legacyWarning) legacyWarning.hidden = true;
      if (legacyPhrase) legacyPhrase.hidden = true;
      return;
    }
    try {
      const fileJson = JSON.parse(await file.text());
      const envelope = fileJson?.envelope || fileJson?.recoveryEnvelope || fileJson;
      const embeddedPhrase = String(fileJson?.recoveryPhrase || fileJson?.phrase || "").trim();
      label.textContent = envelope?.cipher && envelope?.salt
        ? `${file.name} - ${embeddedPhrase ? "ready" : "older file"}`
        : `${file.name} - not recognized`;
      const isLegacy = Boolean(envelope?.cipher && envelope?.salt && !embeddedPhrase);
      if (legacyWarning) legacyWarning.hidden = !isLegacy;
      if (legacyPhrase) legacyPhrase.hidden = !isLegacy;
    } catch {
      label.textContent = `${file.name} - not recognized`;
      if (legacyWarning) legacyWarning.hidden = true;
      if (legacyPhrase) legacyPhrase.hidden = true;
    }
  });
  restoreForm?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status"); const formData = new FormData(event.target);
    const mode = event.target.dataset.recoveryMode || "file";
    const phrase = String(formData.get(mode === "file" ? "legacyPhrase" : "phrase") || "").trim();
    const file = formData.get("file");
    status.textContent = "Restoring your vault…";
    try {
      if (mode === "file" && file && file.size) {
        let fileJson;
        try { fileJson = JSON.parse(await file.text()); }
        catch { throw new Error("This Mesh Key file is not valid JSON."); }
        const envelope = fileJson?.envelope || fileJson?.recoveryEnvelope || fileJson;
        const embeddedPhrase = String(fileJson?.recoveryPhrase || fileJson?.phrase || "").trim();
        if (envelope?.cipher && envelope?.salt && !embeddedPhrase && !phrase) {
          status.textContent = "This older key file also needs its matching recovery phrase.";
          return;
        }
        await actions.restoreWithFile({ fileJson, phrase });
      }
      else if (mode === "phrase" && phrase) await actions.restoreWithPhrase({ phrase });
      else {
        status.textContent = mode === "file" ? "Choose your Mesh Key file." : "Enter your recovery phrase.";
        return;
      }
    } catch (error) { status.textContent = error.message; }
  });
}
