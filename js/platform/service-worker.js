let registrationPromise = null;
let updateListenersBound = false;

export function appServiceWorkerSupported() {
  return typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && (typeof window === "undefined" || window.isSecureContext);
}

export function ensureAppServiceWorker() {
  if (!appServiceWorkerSupported()) return Promise.resolve(null);
  if (!registrationPromise) {
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
