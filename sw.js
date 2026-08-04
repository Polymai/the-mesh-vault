const CACHE_NAME = "themeshvault-shell-v17";
const SHARE_CACHE_NAME = "themeshvault-share-inbox-v3";
const SHARE_TARGET_PATH = new URL("./share-target", self.registration.scope).pathname;
const SHARE_ENTRY_ROOT = ".meshvault-share";
const MAX_SHARED_FILE_BYTES = 100000000;
const MAX_SHARED_BATCH_BYTES = 250000000;
const MAX_SHARED_FILES = 20;
const SHARE_INBOX_TTL_MS = 24 * 60 * 60 * 1000;
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./assets/pwa-icon-192.png", "./assets/pwa-icon-512.png", "./assets/apple-touch-icon.png", "./data/runtime-config.js", "./css/tokens.css", "./css/base.css", "./css/shell.css", "./css/components.css", "./css/views.css", "./css/mesh-view.css", "./css/mesh-connections.css", "./css/landing-refinement.css", "./css/public-documents.css", "./css/security-architecture.css", "./css/night-node.css", "./js/vendor/nacl-fast.min.js", "./js/vendor/cytoscape.esm.min.js", "./js/ui/mesh-connections.js", "./js/main.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => ![CACHE_NAME, SHARE_CACHE_NAME].includes(key)).map((key) => caches.delete(key)))),
    caches.open(SHARE_CACHE_NAME).then((cache) => cleanupShareInbox(cache)),
  ]).then(() => self.clients.claim()));
});
function shareEntryUrl(batchId, entryId) {
  return new URL(`./${SHARE_ENTRY_ROOT}/${batchId}/${entryId}`, self.registration.scope).href;
}
function safeSharedName(value, index) {
  return String(value || `shared-file-${index + 1}`).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180) || `shared-file-${index + 1}`;
}
async function cleanupShareInbox(cache) {
  const now = Date.now();
  const requests = await cache.keys();
  const manifests = requests.filter((request) => new URL(request.url).pathname.endsWith("/manifest"));
  await Promise.all(manifests.map(async (request) => {
    const response = await cache.match(request);
    if (!response) return;
    try {
      const manifest = await response.json();
      const receivedAt = Date.parse(manifest.receivedAt || "");
      if (Number.isFinite(receivedAt) && now - receivedAt <= SHARE_INBOX_TTL_MS) return;
      await Promise.all((manifest.entries || []).map((entry) => typeof entry.cacheUrl === "string" ? cache.delete(entry.cacheUrl) : null));
    } catch {}
    await cache.delete(request);
  }));
}
async function handleShareTarget(request) {
  const batchId = crypto.randomUUID();
  const cache = await caches.open(SHARE_CACHE_NAME);
  await cleanupShareInbox(cache);
  const formData = await request.formData();
  const incoming = formData.getAll("files").filter((value) => value instanceof File);
  const entries = [];
  let acceptedBytes = 0;
  let rejectedCount = 0;
  for (const file of incoming) {
    if (entries.length >= MAX_SHARED_FILES || file.size > MAX_SHARED_FILE_BYTES || acceptedBytes + file.size > MAX_SHARED_BATCH_BYTES) {
      rejectedCount += 1;
      continue;
    }
    const id = String(entries.length);
    const cacheUrl = shareEntryUrl(batchId, id);
    await cache.put(cacheUrl, new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream" } }));
    entries.push({
      id,
      cacheUrl,
      name: safeSharedName(file.name, entries.length),
      type: file.type || "application/octet-stream",
      size: file.size,
      lastModified: file.lastModified || Date.now(),
    });
    acceptedBytes += file.size;
  }
  const manifest = {
    batchId,
    receivedAt: new Date().toISOString(),
    receivedCount: incoming.length,
    rejectedCount,
    entries,
  };
  await cache.put(shareEntryUrl(batchId, "manifest"), new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }));
  return Response.redirect(new URL(`./#/drive?share-target=${encodeURIComponent(batchId)}`, self.registration.scope).href, 303);
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.origin === self.location.origin && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith(handleShareTarget(event.request).catch(() => Response.redirect(new URL("./#/drive?share-error=receive", self.registration.scope).href, 303)));
    return;
  }
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
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
