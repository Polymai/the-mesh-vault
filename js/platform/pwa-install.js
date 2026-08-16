let deferredPrompt = null;
const listeners = new Set();

export function publicAppUrl() {
  const configured = window.__POLYMAI_SUPABASE_CONFIG__?.siteUrl;
  const url = new URL(configured || "./", document.baseURI);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("The public app link is not configured.");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "/home";
  return url.href;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    return copied;
  }
}

export async function copyPublicAppLink() {
  const url = publicAppUrl();
  return { outcome: await copyText(url) ? "copied" : "manual", url };
}

export async function sharePublicAppLink() {
  const url = publicAppUrl();
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({
        title: "TheMeshVault",
        text: "Open TheMeshVault - private storage built from participating devices.",
        url,
      });
      return { outcome: "shared", url };
    } catch (error) {
      if (error?.name === "AbortError") return { outcome: "cancelled", url };
    }
  }
  return copyPublicAppLink();
}

function displayMode() {
  if (typeof window === "undefined") return "browser";
  if (window.navigator?.standalone === true) return "standalone";
  return ["window-controls-overlay", "fullscreen", "standalone", "minimal-ui"]
    .find((mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches) || "browser";
}

function platform() {
  if (typeof navigator === "undefined") return "other";
  const agent = String(navigator.userAgent || "");
  if (/iPad|iPhone|iPod/i.test(agent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(agent)) return "android";
  return "desktop";
}

function browserFamily() {
  if (typeof navigator === "undefined") return "other";
  const agent = String(navigator.userAgent || "");
  if (/EdgA|EdgiOS|Edg\//i.test(agent)) return "edge";
  if (/FxiOS|Firefox\//i.test(agent)) return "firefox";
  if (/CriOS|Chrome\//i.test(agent)) return "chrome";
  if (/Safari\//i.test(agent)) return "safari";
  return "other";
}

function operatingSystem() {
  if (typeof navigator === "undefined") return "other";
  const agent = String(navigator.userAgent || "");
  if (/Windows/i.test(agent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(agent)) return "macos";
  if (/Android/i.test(agent)) return "android";
  if (/Linux/i.test(agent)) return "linux";
  return "other";
}

let state = {
  installed: displayMode() !== "browser",
  available: false,
  prompting: false,
  platform: platform(),
  browser: browserFamily(),
  os: operatingSystem(),
  displayMode: displayMode(),
  publicUrl: publicAppUrl(),
  lastOutcome: null,
};

function emit(patch = {}) {
  state = { ...state, ...patch };
  const snapshot = { ...state };
  listeners.forEach((listener) => {
    try { listener(snapshot); } catch {}
  });
  return snapshot;
}

function syncDisplayMode() {
  const mode = displayMode();
  emit({ displayMode: mode, installed: state.installed || mode !== "browser" });
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    emit({ available: true, prompting: false, lastOutcome: null });
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    emit({ installed: true, available: false, prompting: false, lastOutcome: "accepted" });
  });
  ["window-controls-overlay", "fullscreen", "standalone", "minimal-ui"].forEach((mode) => {
    window.matchMedia?.(`(display-mode: ${mode})`).addEventListener?.("change", syncDisplayMode);
  });
}

export function pwaInstallState() {
  return { ...state };
}

export function configurePwaInstall(listener) {
  listeners.add(listener);
  listener({ ...state });
  return () => listeners.delete(listener);
}

export async function requestPwaInstall() {
  if (state.installed) return { outcome: "already-installed" };
  if (!deferredPrompt) return { outcome: "unavailable" };
  const prompt = deferredPrompt;
  emit({ prompting: true, lastOutcome: null });
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    deferredPrompt = null;
    emit({
      available: false,
      prompting: false,
      lastOutcome: choice?.outcome || "dismissed",
    });
    return choice || { outcome: "dismissed" };
  } catch (error) {
    deferredPrompt = null;
    emit({ available: false, prompting: false, lastOutcome: "failed" });
    throw error;
  }
}
