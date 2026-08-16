let registrationPromise = null;
let updateListenersBound = false;
let controllerReloadScheduled = false;
let releaseCheckInFlight = null;
const RELEASE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function reloadAfterControllerChange() {
  if (controllerReloadScheduled || typeof window === "undefined") return;
  controllerReloadScheduled = true;
  const reloadWhenIdle = () => {
    if (document.querySelector(".upload-status--running")) {
      window.setTimeout(reloadWhenIdle, 1500);
      return;
    }
    window.location.reload();
  };
  reloadWhenIdle();
}

function activateWaitingWorker(registration) {
  registration?.waiting?.postMessage?.({ type: "meshvault:skip-waiting" });
}

function watchInstallingWorker(registration) {
  const worker = registration?.installing;
  if (!worker) return;
  worker.addEventListener("statechange", () => {
    if (worker.state === "installed") activateWaitingWorker(registration);
  });
}

async function checkPublishedRelease(registration) {
  if (releaseCheckInFlight || typeof window === "undefined" || !navigator.onLine) return releaseCheckInFlight;
  releaseCheckInFlight = (async () => {
    await registration.update();
    activateWaitingWorker(registration);
    const response = await fetch(new URL("../../data/runtime-config.js?release-check=1", import.meta.url), {
      cache: "no-store",
      headers: { "X-TheMeshVault-Update-Check": "1" },
    });
    if (!response.ok) return;
    const source = await response.text();
    const publishedBuild = Number(source.match(/\bbuild:\s*(\d+)/)?.[1] || 0);
    const runningBuild = Number(window.__DATA__?.release?.build || 0);
    if (publishedBuild > runningBuild) reloadAfterControllerChange();
  })().catch(() => {}).finally(() => {
    releaseCheckInFlight = null;
  });
  return releaseCheckInFlight;
}

export function appServiceWorkerSupported() {
  return typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && (typeof window === "undefined" || window.isSecureContext);
}

export function ensureAppServiceWorker() {
  if (!appServiceWorkerSupported()) return Promise.resolve(null);
  if (!registrationPromise) {
    const workerUrl = new URL("../../sw.js", import.meta.url);
    let controllerSeen = !!navigator.serviceWorker.controller;
    registrationPromise = navigator.serviceWorker
      .register(workerUrl, { scope: "./", updateViaCache: "none" })
      .then((registration) => {
        activateWaitingWorker(registration);
        watchInstallingWorker(registration);
        if (!updateListenersBound && typeof window !== "undefined") {
          updateListenersBound = true;
          const checkForUpdate = () => checkPublishedRelease(registration);
          window.addEventListener("online", checkForUpdate);
          document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
          navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (!controllerSeen) {
              controllerSeen = true;
              return;
            }
            reloadAfterControllerChange();
          });
          registration.addEventListener("updatefound", () => watchInstallingWorker(registration));
          window.setInterval(checkForUpdate, RELEASE_CHECK_INTERVAL_MS);
        }
        checkPublishedRelease(registration);
        return registration;
      })
      .catch((error) => {
        registrationPromise = null;
        throw error;
      });
  }
  return registrationPromise;
}
