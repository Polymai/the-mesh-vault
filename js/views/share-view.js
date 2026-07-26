import { downloadSharedFile } from "../flows/share-download-flow.js";

export function renderShareView() {
  return `<section class="auth-layout"><div class="auth-story"><span class="eyebrow">Shared file</span><h1>Download securely.</h1><p>Decrypted and verified in this browser.</p></div><div class="auth-card"><form data-share-download-form><label>Password (if required)<input type="password" name="password" autocomplete="off" aria-label="Share password"></label><button class="button" type="submit">Download file</button><p class="form-status" role="status"></p></form></div></section>`;
}

export function bindShareView(capabilityId, fragmentPayload) {
  document.querySelector("[data-share-download-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = event.target.querySelector(".form-status"); const button = event.target.querySelector("button[type='submit']");
    const password = new FormData(event.target).get("password"); status.textContent = "Recovering the shared file…"; button.disabled = true;
    try { await downloadSharedFile(capabilityId, fragmentPayload, { password }); status.textContent = "File downloaded and verified byte for byte."; }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
