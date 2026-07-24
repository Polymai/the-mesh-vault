const CACHE_NAME = "themeshvault-shell-v4";
const SHELL = ["./", "./index.html", "./data/runtime-config.js", "./css/tokens.css", "./css/base.css", "./css/shell.css", "./css/components.css", "./css/views.css", "./css/landing-refinement.css", "./css/public-documents.css", "./css/security-architecture.css", "./css/night-node.css", "./js/main.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))));
});
async function notifyClients(type) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type }));
}
self.addEventListener("sync", (event) => {
  if (event.tag === "meshvault-anchor-check") event.waitUntil(notifyClients("meshvault:background-check"));
});
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "meshvault-anchor-check") event.waitUntil(notifyClients("meshvault:background-check"));
});
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json?.() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title || "TheMeshVault node check", {
    body: payload.body || "Open Night Node to renew this device's mesh lease.",
    icon: "./assets/favicon.svg", badge: "./assets/favicon.svg", tag: "meshvault-node-wake",
    renotify: false, data: { url: payload.url || "./#/night-node" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => "focus" in client);
    return existing ? existing.focus().then((client) => client.navigate(event.notification.data.url)) : self.clients.openWindow(event.notification.data.url);
  }));
});
