const CACHE_NAME = "themeshvault-share-inbox-v3";
const ENTRY_ROOT = ".meshvault-share";
const SAFE_BATCH_ID = /^[a-zA-Z0-9-]{1,80}$/;

function parseBatchId(hash = typeof location === "undefined" ? "" : location.hash) {
  const query = String(hash).split("?")[1] || "";
  const value = new URLSearchParams(query).get("share-target") || "";
  return SAFE_BATCH_ID.test(value) ? value : null;
}

let launchBatchId = parseBatchId();

function entryUrl(batchId, entryId) {
  return new URL(`./${ENTRY_ROOT}/${batchId}/${entryId}`, document.baseURI).href;
}
function manifestUrl(batchId) {
  return entryUrl(batchId, "manifest");
}
function validEntryUrl(batchId, value) {
  try {
    const expected = new URL(`./${ENTRY_ROOT}/${batchId}/`, document.baseURI);
    const actual = new URL(value);
    return actual.origin === expected.origin && actual.pathname.startsWith(expected.pathname);
  } catch { return false; }
}

export function sharedLaunchBatchId() {
  return launchBatchId || parseBatchId();
}

export async function loadSharedBatch(batchId = sharedLaunchBatchId()) {
  if (!batchId || !SAFE_BATCH_ID.test(batchId) || !("caches" in window)) return null;
  const cache = await caches.open(CACHE_NAME);
  const manifestResponse = await cache.match(manifestUrl(batchId));
  if (!manifestResponse) return null;
  const manifest = await manifestResponse.json().catch(() => null);
  if (!manifest || manifest.batchId !== batchId || !Array.isArray(manifest.entries)) return null;
  const entries = [];
  for (const metadata of manifest.entries) {
    if (!metadata?.id || !validEntryUrl(batchId, metadata.cacheUrl)) continue;
    const response = await cache.match(metadata.cacheUrl);
    if (!response) continue;
    const blob = await response.blob();
    if (blob.size !== Number(metadata.size)) continue;
    entries.push({
      id: metadata.id,
      file: new File([blob], metadata.name || "shared-file", {
        type: metadata.type || blob.type || "application/octet-stream",
        lastModified: Number(metadata.lastModified) || Date.now(),
      }),
    });
  }
  return {
    batchId,
    entries,
    rejectedCount: Math.max(0, Number(manifest.rejectedCount || 0)),
    receivedCount: Math.max(0, Number(manifest.receivedCount || manifest.entries.length)),
  };
}

export async function markSharedEntryImported(batchId, entryId) {
  if (!batchId || !entryId || !SAFE_BATCH_ID.test(batchId)) return false;
  const cache = await caches.open(CACHE_NAME);
  const response = await cache.match(manifestUrl(batchId));
  if (!response) return false;
  const manifest = await response.json().catch(() => null);
  if (!manifest || !Array.isArray(manifest.entries)) return false;
  const imported = manifest.entries.find((entry) => entry.id === entryId);
  if (imported?.cacheUrl && validEntryUrl(batchId, imported.cacheUrl)) await cache.delete(imported.cacheUrl);
  manifest.entries = manifest.entries.filter((entry) => entry.id !== entryId);
  if (!manifest.entries.length) await cache.delete(manifestUrl(batchId));
  else await cache.put(manifestUrl(batchId), new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }));
  return true;
}

export function finishSharedLaunch(batchId = sharedLaunchBatchId()) {
  if (batchId && launchBatchId === batchId) launchBatchId = null;
  const baseHash = String(location.hash || "#/drive").split("?")[0] || "#/drive";
  const nextHash = baseHash === "#/onboarding" ? "#/drive" : baseHash;
  history.replaceState(history.state, "", `${location.pathname}${location.search}${nextHash}`);
}
