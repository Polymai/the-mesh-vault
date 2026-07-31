let registrationPromise = null;

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
      .catch((error) => {
        registrationPromise = null;
        throw error;
      });
  }
  return registrationPromise;
}
