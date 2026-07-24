import { LEGAL_VERSIONS } from "../content/public-documents.js";
import { hasCurrentLegalAcceptance, recordLegalAcceptance } from "../legal/acceptance.js";

export function renderOnboardingView() {
  return `<section class="auth-layout onboarding-layout">
    <div class="auth-story">
      <span class="eyebrow">No named account required</span>
      <h1>Open TheMeshVault.</h1>
      <p>Your Mesh Key controls access to your files. TheMeshVault creates it locally — no email, password or named account. A pseudonymous Supabase session is created in the background for today’s mesh coordination.</p>
      <ul><li>Files stay end-to-end encrypted with a key only you hold</li><li>Recovery works from a Mesh Key, not a password</li><li>Every sensitive action is signed by your device</li></ul>
    </div>
    <div class="auth-card onboarding-card">
      <div class="onboarding-menu" data-onboard-menu>
        <span class="eyebrow">Start privately</span>
        <h2>Choose how to enter</h2>
        <p class="onboarding-intro">Create a new local vault now, or bring back one you already own.</p>
        <button class="onboarding-primary" type="button" data-onboard="anonymous">
          <span>Open a new vault</span><small>Creates your Mesh Key on this device</small>
        </button>
        <div class="onboarding-divider"><span>Already use TheMeshVault?</span></div>
        <button class="onboarding-option" type="button" data-onboard-toggle="restore">
          <span><strong>Restore an existing vault</strong><small>Use your recovery phrase or Mesh Key file</small></span><i aria-hidden="true">→</i>
        </button>
        <button class="onboarding-option" type="button" data-onboard-toggle="node">
          <span><strong>Contribute storage only</strong><small>Join the mesh without creating a personal vault</small></span><i aria-hidden="true">→</i>
        </button>
        <button class="onboarding-account-link" type="button" data-onboard-toggle="account">How optional accounts work <span aria-hidden="true">→</span></button>
        <p class="form-status" role="status" data-onboard-status></p>
      </div>

      <form class="onboarding-panel" data-onboard-panel="restore" hidden>
        <button class="onboarding-back" type="button" data-onboard-back>← All options</button>
        <span class="eyebrow">Existing vault</span>
        <h2>Restore with Mesh Key</h2>
        <p>Enter the recovery phrase and, if you saved one, choose its matching Mesh Key file.</p>
        <label class="onboarding-field"><span>Recovery phrase</span><textarea name="phrase" rows="2" autocomplete="off" spellcheck="false" placeholder="word-word-word-word-word-word" aria-label="Recovery phrase"></textarea><small>Paste all 42 letters and numbers. Hyphens, spaces and line breaks are accepted.</small></label>
        <div class="onboarding-divider"><span>Recovery file</span></div>
        <label class="key-file-picker">
          <input type="file" name="file" accept="application/json" aria-label="Mesh Key file">
          <span><strong>Choose Mesh Key file</strong><small data-key-file-name>JSON file from your saved recovery kit</small></span>
          <i aria-hidden="true">Browse</i>
        </label>
        <button class="button onboarding-submit" type="submit">Restore vault</button>
        <p class="form-status" role="status"></p>
      </form>

      <div class="onboarding-panel" data-onboard-panel="node" hidden>
        <button class="onboarding-back" type="button" data-onboard-back>← All options</button>
        <span class="eyebrow">Storage node</span>
        <h2>Contribute encrypted space</h2>
        <p>This browser can store verified encrypted shards without creating a personal vault. You can pause it or clear its local storage at any time.</p>
        <button class="button onboarding-submit" type="button" data-onboard="node">Join the mesh</button>
        <p class="form-status" role="status" data-node-status></p>
      </div>

      <div class="onboarding-panel" data-onboard-panel="account" hidden>
        <button class="onboarding-back" type="button" data-onboard-back>← All options</button>
        <span class="eyebrow">Optional account</span>
        <h2>The Mesh Key comes first</h2>
        <p>Create the vault locally, then connect an account from Settings for convenience. The account never becomes the owner and cannot replace your Mesh Key.</p>
        <button class="button onboarding-submit" type="button" data-onboard="anonymous">Create my vault</button>
      </div>
    </div>
  </section>
  <dialog class="legal-consent" data-legal-consent aria-labelledby="legal-consent-title">
    <form data-legal-consent-form>
      <div class="legal-consent__head"><div><span class="eyebrow">Before your vault is created</span><h2 id="legal-consent-title">One important agreement</h2></div><button class="legal-consent__close" type="button" data-close-legal aria-label="Close">×</button></div>
      <p>No name, email address, password or named account is required. TheMeshVault creates your cryptographic vault locally. Today it also creates a pseudonymous Supabase session and uses technical vault, device and network data for discovery, signaling, storage coordination, recovery and security.</p>
      <div class="legal-consent__key"><strong>Keep the Mesh Key somewhere safe.</strong> TheMeshVault cannot reset it or recreate it for you if every trusted copy is lost.</div>
      <label class="legal-consent__check"><input type="checkbox" name="termsAccepted" required><span>I agree to the <a href="#/terms" target="_blank" rel="noopener">Terms of Service</a> <small>(${LEGAL_VERSIONS.terms})</small>.</span></label>
      <p class="legal-consent__ack">By continuing, you acknowledge the <a href="#/privacy" target="_blank" rel="noopener">Privacy Notice</a>, including how IP addresses and pseudonymous device or vault identifiers are used. This is not consent to optional marketing or analytics.</p>
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
  fileInput?.addEventListener("change", () => {
    const label = document.querySelector("[data-key-file-name]");
    if (label) label.textContent = fileInput.files?.[0]?.name || "JSON file from your saved recovery kit";
  });
  document.querySelector("[data-onboard-panel='restore']")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status"); const formData = new FormData(event.target);
    const phrase = String(formData.get("phrase") || "").trim(); const file = formData.get("file");
    status.textContent = "Restoring your vault…";
    try {
      if (file && file.size) await actions.restoreWithFile({ fileJson: JSON.parse(await file.text()), phrase });
      else if (phrase) await actions.restoreWithPhrase({ phrase });
      else { status.textContent = "Enter your recovery phrase or choose a Mesh Key file."; return; }
    } catch (error) { status.textContent = error.message; }
  });
}
