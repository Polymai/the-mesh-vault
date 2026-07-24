export function renderAccountLinkView(state) {
  const linked = state.accountLink;
  return `<section class="view-head"><div><span class="eyebrow">Optional convenience</span><h1>Connect an account</h1><p>An account never becomes the real owner of your vault - it only helps with discovery, notifications, trusted-device management, and easier onboarding on a new device.</p></div></section>
  <div class="panel">${linked
    ? `<p>This vault is connected to <strong>${linked.email || linked.authUserId}</strong>.</p><button class="button button--ghost" type="button" data-disconnect-account>Disconnect account</button><p class="form-status" role="status" data-disconnect-status></p>`
    : `<form data-account-form="signin"><h2>Sign in to connect</h2><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="button" type="submit">Sign in and connect</button><p class="form-status" role="status"></p></form><form data-account-form="signup"><h2>Or create an account</h2><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" minlength="8" autocomplete="new-password" required></label><button class="button" type="submit">Create account and connect</button><p class="form-status" role="status"></p></form>`}
  <p class="trust-note">Your cryptographic vault identity never changes when you connect or disconnect an account.</p></div>`;
}
export function bindAccountLinkView(actions) {
  document.querySelectorAll("[data-account-form]").forEach((form) => form.addEventListener("submit", async (event) => {
    event.preventDefault(); const status = form.querySelector(".form-status"); const data = Object.fromEntries(new FormData(form));
    status.textContent = "Connecting…";
    try { await actions[form.dataset.accountForm](data); status.textContent = "Account connected."; } catch (error) { status.textContent = error.message; }
  }));
  document.querySelector("[data-disconnect-account]")?.addEventListener("click", async (event) => {
    if (!confirm("Disconnect this account from your vault?")) return;
    const button = event.currentTarget;
    const status = document.querySelector("[data-disconnect-status]");
    button.disabled = true;
    if (status) status.textContent = "Disconnecting...";
    try { await actions.disconnect(); }
    catch (error) { button.disabled = false; if (status) status.textContent = error.message; }
  });
}
