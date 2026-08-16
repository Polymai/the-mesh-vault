const SESSION_KEY = "themeshvault:pwa-install-prompt-dismissed";
const PROMPT_ROUTES = new Set(["home", "dashboard"]);
const APP_ICON = new URL("../../assets/pwa-icon-192.png", import.meta.url).href;
let promptOpen = false;

function sessionDismissed() {
  try { return sessionStorage.getItem(SESSION_KEY) === "1"; }
  catch { return false; }
}

function dismissForSession() {
  promptOpen = false;
  try { sessionStorage.setItem(SESSION_KEY, "1"); } catch {}
}

function guidance(install = {}) {
  if (install.platform === "ios") return "Use Share, Add to Home Screen, then turn on Open as Web App.";
  if (install.platform === "desktop" && install.browser === "safari") return "In Safari, choose File or Share, then Add to Dock.";
  if (install.platform === "desktop" && install.browser === "firefox" && install.os === "windows") return "In Firefox 143 or later, use the web apps button in the address bar.";
  if (install.platform === "desktop" && install.browser === "firefox") return "Firefox does not install web apps on this operating system. Use Safari on macOS or a Chromium browser.";
  if (install.platform === "android" && install.browser === "firefox") return "Choose Install from the Firefox menu.";
  return "Choose Install TheMeshVault from your browser menu.";
}

function canOffer(state = {}) {
  const install = state.pwaInstall || {};
  if (state.suppressPwaInstallPrompt || !PROMPT_ROUTES.has(state.route)) return false;
  if (install.installed || install.displayMode !== "browser" || sessionDismissed()) return false;
  if (install.platform === "ios") return true;
  if (["chrome", "edge"].includes(install.browser)) return !!install.available;
  if (install.browser === "safari") return true;
  if (install.browser === "firefox") return install.platform === "android" || install.os === "windows";
  return !!install.available;
}

export function renderPwaInstallPrompt(state = {}) {
  const install = state.pwaInstall || {};
  if (state.suppressPwaInstallPrompt || !PROMPT_ROUTES.has(state.route)) return "";
  if (install.installed || install.displayMode !== "browser" || sessionDismissed()) return "";
  if (!canOffer(state) && !promptOpen) return "";
  const nativeInstall = !!install.available;
  return `<aside class="pwa-start-prompt" data-pwa-install-prompt role="dialog" aria-labelledby="pwa-start-title" aria-describedby="pwa-start-copy">
    <button class="pwa-start-prompt__close" type="button" data-pwa-prompt-dismiss aria-label="Close installation prompt">×</button>
    <span class="pwa-start-prompt__icon" aria-hidden="true"><img src="${APP_ICON}" alt=""></span>
    <div class="pwa-start-prompt__content"><span class="eyebrow">Install TheMeshVault</span><h2 id="pwa-start-title">Open it like an app.</h2><p id="pwa-start-copy">Keep your vault one tap away in its own app window.</p>${nativeInstall ? "" : `<small>${guidance(install)}</small>`}</div>
    <div class="pwa-start-prompt__actions"><button class="button button--ghost" type="button" data-pwa-prompt-dismiss>Not now</button>${nativeInstall ? `<button class="button" type="button" data-pwa-prompt-install>Install app</button>` : `<button class="button" type="button" data-pwa-prompt-dismiss>Got it</button>`}</div>
    <p class="form-status" data-pwa-prompt-status role="status"></p>
  </aside>`;
}

export function bindPwaInstallPrompt(onInstall) {
  const prompt = document.querySelector("[data-pwa-install-prompt]");
  if (!prompt) return;
  promptOpen = true;
  window.requestAnimationFrame(() => prompt.classList.add("is-visible"));
  const close = () => {
    dismissForSession();
    document.querySelectorAll("[data-pwa-install-prompt]").forEach((element) => element.classList.remove("is-visible"));
    window.setTimeout(() => document.querySelectorAll("[data-pwa-install-prompt]").forEach((element) => element.remove()), 180);
  };
  prompt.querySelectorAll("[data-pwa-prompt-dismiss]").forEach((button) => button.addEventListener("click", close));
  prompt.querySelector("[data-pwa-prompt-install]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const status = prompt.querySelector("[data-pwa-prompt-status]");
    button.disabled = true;
    status.textContent = "Opening the install dialog…";
    try {
      const result = await onInstall();
      if (["accepted", "already-installed", "dismissed"].includes(result.outcome)) close();
      else {
        status.textContent = guidance({});
        button.disabled = false;
      }
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}
