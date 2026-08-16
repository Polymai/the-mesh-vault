import { inspectLocalShards } from "../storage/fragment-store.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}
function shortHash(value) {
  const hash = String(value || "");
  return hash.length > 24 ? `${hash.slice(0, 12)}…${hash.slice(-10)}` : hash || "Unknown";
}

export function renderHostedStorageView() {
  return `<section class="view-head view-head--compact hosted-storage-head"><div><a class="back-link" href="#/settings">← Settings</a><h1>Hosted pieces</h1><p>Encrypted pieces this browser stores for the mesh.</p></div><button class="button button--ghost" type="button" data-refresh-hosted-storage>Refresh</button></section>
  <section class="panel hosted-storage" data-hosted-storage aria-live="polite" aria-busy="true">
    <div class="hosted-storage-loading">Reading browser storage…</div>
  </section>`;
}

function renderItems(report) {
  if (!report.items.length) return `<div class="hosted-storage-empty"><span aria-hidden="true">◇</span><h2>No hosted pieces yet</h2><p>This browser has not received encrypted storage pieces from the mesh.</p></div>`;
  return `<div class="hosted-piece-list" role="list">${report.items.map((item) => `<div class="hosted-piece" role="listitem">
    <span class="hosted-piece__icon" aria-hidden="true">◇</span>
    <div><strong title="${esc(item.id)}">${esc(shortHash(item.id))}</strong><small>Encrypted shard</small></div>
    <span>${formatBytes(item.size)}</span>
    <em>${esc(item.backend)}</em>
  </div>`).join("")}</div>${report.totalCount > report.items.length ? `<p class="hosted-storage-more">Showing ${report.items.length} of ${report.totalCount} pieces.</p>` : ""}`;
}

async function loadHostedStorage() {
  const root = document.querySelector("[data-hosted-storage]");
  if (!root) return;
  root.setAttribute("aria-busy", "true");
  try {
    const report = await inspectLocalShards({ limit: 100 });
    root.innerHTML = `<div class="hosted-storage-summary">
      <div><span>Pieces</span><strong>${report.totalCount}</strong></div>
      <div><span>Stored here</span><strong>${formatBytes(report.totalBytes)}</strong></div>
      <div><span>Storage</span><strong>${report.opfsCount ? "Browser files" : "Browser database"}</strong></div>
      <div><span>Protection</span><strong>${report.persistent ? "Persistent" : "Best effort"}</strong></div>
    </div>
    <div class="hosted-storage-note"><strong>Why there is no folder link</strong><p>The browser keeps these hash-addressed encrypted pieces in private site storage (OPFS, with IndexedDB fallback). It is not a normal folder and contains no readable filenames or documents. This view is the safe way to inspect what TheMeshVault stores here.</p></div>
    ${renderItems(report)}`;
  } catch (error) {
    root.innerHTML = `<div class="hosted-storage-empty"><h2>Storage could not be read</h2><p>${esc(error.message)}</p></div>`;
  } finally {
    root.setAttribute("aria-busy", "false");
  }
}

export function bindHostedStorageView() {
  document.querySelector("[data-refresh-hosted-storage]")?.addEventListener("click", loadHostedStorage);
  loadHostedStorage();
}
