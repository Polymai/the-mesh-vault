let registrationPromise = null;
let updateListenersBound = false;
let controllerReloadScheduled = false;

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

export function appServiceWorkerSupported() {
  return typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && (typeof window === "undefined" || window.isSecureContext);
}

export function ensureAppServiceWorker() {
  if (!appServiceWorkerSupported()) return Promise.resolve(null);
  if (!registrationPromise) {
    const controlledAtRegistration = !!navigator.serviceWorker.controller;
    const workerUrl = new URL("../../sw.js", import.meta.url);
    registrationPromise = navigator.serviceWorker
      .register(workerUrl, { scope: "./" })
      .then((registration) => {
        registration.update().catch(() => {});
        if (!updateListenersBound && typeof window !== "undefined") {
          updateListenersBound = true;
          const checkForUpdate = () => registration.update().catch(() => {});
          window.addEventListener("online", checkForUpdate);
          document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
          if (controlledAtRegistration) navigator.serviceWorker.addEventListener("controllerchange", reloadAfterControllerChange);
        }
        return registration;
      })
      .catch((error) => {
        registrationPromise = null;
        throw error;
      });
  }
  return registrationPromise;
}
