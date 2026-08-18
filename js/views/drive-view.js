import { filterAndSortFiles } from "../services/metadata-service.js";
import { compressionLikelyUseful } from "../security/compression.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const bytes = (value = 0) => { const units = ["B", "KB", "MB", "GB", "TB"]; let n = Number(value), i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`; };
const pct = (value) => `${Math.max(0, Number(value) || 0).toFixed(1)}%`;
const uploadLimitMb = () => Math.round(Number(window.__DATA__?.limits?.maxUploadBytes || 100000000) / 1000000);
let filters = { search: "", sort: "created-desc" };
let currentFolderId = null;
let activeDeletionResult = null;
let cameraShortcutPending = /(?:^|[?&])camera=1(?:&|$)/.test(String(location.hash).split("?")[1] || "");
const BACKGROUND_DELETION_AGE_MS = 7 * 86400000;
const hiddenDeletionKey = (vaultId) => `${window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:"}hidden-deletions:${vaultId || "local"}`;
function hiddenDeletionIds(vaultId) {
  try { return new Set(JSON.parse(localStorage.getItem(hiddenDeletionKey(vaultId)) || "[]")); } catch { return new Set(); }
}
function hideDeletionIds(vaultId, ids) {
  const hidden = hiddenDeletionIds(vaultId);
  for (const id of ids || []) if (id) hidden.add(id);
  try { localStorage.setItem(hiddenDeletionKey(vaultId), JSON.stringify([...hidden])); } catch {}
}

const icon = (name) => {
  const paths = {
    folder: '<path d="M3 7.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9.5V6a2 2 0 0 1 2-2h5l2 3.5"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5.5 9.5V21h13V9.5M9.5 21v-7h5v7"/>',
    upload: '<path d="M12 16V3m0 0L7 8m5-5 5 5"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    camera: '<path d="M4 7.5h3l1.5-2h7l1.5 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="4"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    download: '<path d="M12 3v13m0 0 5-5m-5 5-5-5"/><path d="M4 20h16"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7M10 11v6m4-6v6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    move: '<path d="M4 6h7l2 2h7v11H4Z"/><path d="m9 13 3-3 3 3m-3-3v7"/>',
    file: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Z"/>',
    audio: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
    archive: '<path d="M5 3h14v18H5Z"/><path d="M5 8h14M10 3v5m4-5v5M9 12h6v5H9Z"/>',
    document: '<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5M9 12h6M9 16h6"/>',
    sheet: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h8M11 8v8"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || paths.file}</svg>`;
};
const formatDate = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit" }) : "—";
};
function fileIcon(file, statusTone, statusLabel) {
  const mime = String(file.mime || "");
  const name = String(file.name || "");
  const extension = name.includes(".") ? name.split(".").pop().slice(0, 4).toUpperCase() : "";
  const kind = mime.startsWith("image/") ? "image"
    : mime.startsWith("video/") ? "video"
      : mime.startsWith("audio/") ? "audio"
        : /\.(?:zip|gz|7z|rar|bz2|xz)$/i.test(name) ? "archive"
          : /spreadsheet|excel|csv/i.test(mime) || /\.(?:xls|xlsx|csv|ods)$/i.test(name) ? "sheet"
            : /^text\//i.test(mime) || /\.(?:pdf|doc|docx|txt|md|rtf|json)$/i.test(name) ? "document"
              : "file";
  return `<span class="explorer-icon explorer-icon--${kind}" aria-hidden="true">${icon(kind)}${extension ? `<small>${esc(extension)}</small>` : ""}<i class="status-dot status-dot--${esc(statusTone)} explorer-icon-state" title="${esc(statusLabel)}"></i></span>`;
}
function folderPath(folders, folderId) {
  const byId = new Map((folders || []).map((folder) => [folder.id, folder]));
  const path = []; const seen = new Set(); let current = byId.get(folderId);
  while (current && !seen.has(current.id)) { path.unshift(current); seen.add(current.id); current = byId.get(current.parent_id); }
  return path;
}
function folderOptions(folders) {
  return [...(folders || [])].sort((a, b) => folderPath(folders, a.id).map((item) => item.name).join("/").localeCompare(folderPath(folders, b.id).map((item) => item.name).join("/")))
    .map((folder) => `<option value="${folder.id}">${esc(folderPath(folders, folder.id).map((item) => item.name).join(" / "))}</option>`).join("");
}
function compressionValue(file, savings) {
  const saved = Number(file.version?.compression_saved_bytes || 0);
  if (saved > 0) return `${pct(savings)} · ${bytes(saved)} saved`;
  return compressionLikelyUseful(file.name, file.mime) ? "No useful reduction" : "Skipped · already compressed";
}

function recoveryLabel(file, compact = false) {
  const version = file.version || {}, active = Number(version.active_shards || 0), required = Number(version.minimum_required_shards || 0), total = Number(version.total_shards || 0), status = file.resilience?.summaryStatus;
  if (status === "recoverable_without_bootstrap") return compact ? "Recoverable through live mesh" : "Recoverable from verified browser nodes without the bootstrap service";
  if (status === "recoverable_now") return "Recoverable now";
  if (status === "file_at_risk") { const demand = file.resilience?.repairDemand; return compact ? "Recoverable - repair needed" : demand == null ? "Recoverable now; some segment placements need repair" : `Recoverable now; ${demand} shard placements need repair`; }
  if (status === "enough_shards_available") return "Enough shards; local manifest needed";
  if (status === "manifest_available") return "Manifest ready; more shards needed";
  if (status === "encrypted_data_stored") return "Encrypted shards stored; not recoverable yet";
  if (file.status === "local_pending") { const missing = Math.max(0, required - active); return compact ? `Local only - needs ${missing} ${missing === 1 ? "node" : "nodes"}` : `Encrypted locally - ${missing} more independent browser placements needed`; }
  if (file.status === "distributing") return `Distributing - ${Math.max(0, total - active)} placements queued`;
  return String(file.status || "file unavailable").replaceAll("_", " ");
}

function fileRow(file) {
  const version = file.version || {}; const representation = Number(version.representation_size_bytes || 0), physical = Number(version.physical_storage_bytes || 0);
  const savings = Number(file.size_bytes) ? Number(version.compression_saved_bytes || 0) / Number(file.size_bytes) * 100 : 0;
  const overhead = representation ? Math.max(0, (physical / representation - 1) * 100) : 0;
  const downloadable = !["failed", "deleting"].includes(file.status); const statusTone = file.resilience?.atRisk ? "repairing" : file.status;
  const detailsId = `file-details-${file.id}`;
  return `<div class="file-record"><div class="explorer-row explorer-file" role="row">
    <div class="file-name">${fileIcon(file, statusTone, recoveryLabel(file, true))}<div><strong title="${esc(file.name)}">${esc(file.name)}</strong><small>${bytes(file.size_bytes)} · ${formatDate(file.created_at)}</small></div></div>
    <span class="explorer-status" title="${esc(recoveryLabel(file))}"><i class="status-dot status-dot--${esc(statusTone)}"></i>${esc(recoveryLabel(file, true))}</span>
    <span class="explorer-size">${bytes(file.size_bytes)}</span><time datetime="${esc(file.created_at)}">${formatDate(file.created_at)}</time>
    <div class="file-actions">
      <button type="button" class="icon-button" data-file-details="${file.id}" aria-controls="${detailsId}" aria-expanded="false" title="Storage details">${icon("info")}<span class="visually-hidden">Storage details</span></button>
      <button type="button" class="icon-button" data-move-file="${file.id}" data-file-name="${esc(file.name)}" title="Move">${icon("move")}<span class="visually-hidden">Move</span></button>
      <button type="button" class="icon-button" data-download-file="${file.id}" ${downloadable ? "" : "disabled"} title="Download">${icon("download")}<span class="visually-hidden">Download</span></button>
      <button type="button" class="icon-button" data-share-file="${file.id}" ${downloadable ? "" : "disabled"} title="Share">${icon("share")}<span class="visually-hidden">Share</span></button>
      <button type="button" class="icon-button icon-button--danger" data-delete-file="${file.id}" title="Delete">${icon("trash")}<span class="visually-hidden">Delete</span></button>
    </div>
  </div><div class="file-details" id="${detailsId}" hidden><div class="storage-ledger">
    <span>Original<strong>${bytes(file.size_bytes)}</strong></span><span>Stored representation<strong>${bytes(representation)}</strong></span><span>Compression<strong>${compressionValue(file, savings)}</strong></span><span>Redundancy overhead<strong>${pct(overhead)}</strong></span>
    <span>Physical mesh storage<strong>${bytes(physical)}</strong></span><span>Segments<strong>${version.segment_count || 0}</strong></span><span>Shards per segment<strong>${version.total_shards || 0}</strong></span><span>Weakest segment verified<strong>${version.active_shards || 0}</strong></span>
    <span>Repair starts below<strong>${version.repair_threshold_shards || version.minimum_required_shards || 0}</strong></span><span>Physical shard copies<strong>${version.physical_shard_copies || 0}</strong></span><span>Cleanup pending<strong>${version.surplus_placements || 0}</strong></span><span>Independent browser nodes<strong>${version.independent_devices || 0}</strong></span>
    <span>Countries observed<strong>${version.country_count || 0}</strong></span><span>Regions observed<strong>${version.region_count || 0}</strong></span><span>Network domains observed<strong>${version.network_domain_count || 0}</strong></span><span>Minimum per segment<strong>${version.minimum_required_shards || 0}</strong></span>
    <span>Erasure profile<strong>${version.minimum_required_shards || 0} + ${Math.max(0, Number(version.total_shards || 0) - Number(version.minimum_required_shards || 0))}</strong></span><span>Resilience<strong>${esc(recoveryLabel(file))}</strong></span><span>Exact recovery<strong>${version.exact_recovery_verified_at ? "verified" : "not yet verified"}</strong></span><span>Format<strong>segment v${version.format_version || 1}</strong></span>
  </div></div></div>`;
}

function deletionRows(files) {
  return `<div class="deletion-list">${files.map((file) => {
    const total = Number(file.deletion_total_placements || 0), acknowledged = Number(file.deletion_acknowledged_placements || 0), pending = Math.max(0, total - acknowledged);
    return `<div class="deletion-row"><div><strong>${esc(file.name)}</strong><span>Removed ${new Date(file.deleted_at).toLocaleString()}</span></div><div><strong>${acknowledged}/${total}</strong><span>${pending} offline encrypted ${pending === 1 ? "copy" : "copies"}</span></div><div class="deletion-row__progress"><progress max="${Math.max(1, total)}" value="${acknowledged}"></progress><button type="button" class="text-button" data-hide-deletion-status="${file.id}">Hide status</button></div></div>`;
  }).join("")}</div>`;
}

function deletionQueue(files, vaultId) {
  const hidden = hiddenDeletionIds(vaultId);
  files = (files || []).filter((file) => !hidden.has(file.id));
  if (!files.length) return "";
  const now = Date.now();
  const recent = files.filter((file) => now - new Date(file.deleted_at).getTime() < BACKGROUND_DELETION_AGE_MS);
  const background = files.filter((file) => !recent.includes(file));
  const foreground = recent.length ? `<section class="panel deletion-queue"><div class="panel-head"><h2>Deletion cleanup</h2><strong>${recent.length} ${recent.length === 1 ? "file" : "files"}</strong></div>
    <p>Removed from your vault. Offline encrypted copies are erased when those nodes return.</p>
    ${deletionRows(recent)}</section>` : "";
  const archived = background.length ? `<details class="panel deletion-queue deletion-queue--background"><summary><span><b>Background deletion orders</b><small>${background.length} ${background.length === 1 ? "file has" : "files have"} offline copies that have not returned</small></span><strong>${background.length}</strong></summary>
    <p>Hidden copies remain unreadable and outside your vault until their browser returns.</p>
    ${deletionRows(background)}</details>` : "";
  return `${foreground}${archived}`;
}

function deletionDialogs() {
  return `<dialog class="dialog delete-dialog" data-delete-dialog>
    <form method="dialog"><div class="delete-dialog__mark" aria-hidden="true">×</div><div class="dialog-head"><div><span class="eyebrow">Verified mesh deletion</span><h2 data-delete-title>Delete this file?</h2></div><button value="cancel" aria-label="Close dialog">Close</button></div>
    <p data-delete-copy></p><div class="delete-dialog__note" data-delete-note></div>
    <div class="button-row delete-dialog__actions"><button value="cancel" class="button button--ghost">Keep it</button><button value="confirm" class="button button--danger" data-delete-confirm>Delete</button></div></form>
  </dialog>
  <dialog class="dialog delete-result-dialog" data-delete-result-dialog>
    <form method="dialog"><div class="delete-dialog__mark delete-dialog__mark--done" aria-hidden="true">✓</div><span class="eyebrow">Deletion started</span><h2 data-delete-result-title>Removed from your vault</h2><p data-delete-result-copy></p><div class="delete-result__status" data-delete-result-status></div><button value="hide" class="button button--ghost" data-hide-result-status>Hide cleanup status</button><button value="close" class="button">Got it</button></form>
  </dialog>`;
}

function folderRow(folder, state) {
  const items = state.files.filter((file) => file.folder_id === folder.id).length + state.folders.filter((entry) => entry.parent_id === folder.id).length;
  return `<div class="explorer-row explorer-folder" role="row">
    <button type="button" class="folder-name" data-open-folder="${folder.id}" title="Open ${esc(folder.name)}">${icon("folder")}<span><strong>${esc(folder.name)}</strong><small>${items} ${items === 1 ? "item" : "items"}</small></span></button>
    <span class="explorer-status">Folder</span><span class="explorer-size">—</span><time datetime="${esc(folder.created_at)}">${formatDate(folder.created_at)}</time>
    <div class="file-actions"><button type="button" class="icon-button icon-button--danger" data-delete-folder="${folder.id}" data-folder-name="${esc(folder.name)}" title="Delete folder">${icon("trash")}<span class="visually-hidden">Delete folder</span></button></div>
  </div>`;
}

export function renderDriveView(state) {
  const folderById = new Map(state.folders.map((folder) => [folder.id, folder]));
  if (currentFolderId && !folderById.has(currentFolderId)) currentFolderId = null;
  const path = folderPath(state.folders, currentFolderId);
  const q = filters.search.trim().toLocaleLowerCase();
  const childFolders = state.folders.filter((folder) => (folder.parent_id || null) === currentFolderId && (!q || folder.name.toLocaleLowerCase().includes(q)));
  const folderComparators = {
    "created-asc": (a, b) => new Date(a.created_at) - new Date(b.created_at),
    "created-desc": (a, b) => new Date(b.created_at) - new Date(a.created_at),
    "name-asc": (a, b) => a.name.localeCompare(b.name),
    "name-desc": (a, b) => b.name.localeCompare(a.name),
  };
  childFolders.sort(folderComparators[filters.sort] || folderComparators["created-desc"]);
  const files = filterAndSortFiles(state.files.filter((file) => (file.folder_id || null) === currentFolderId), filters.search, filters.sort);
  const itemCount = childFolders.length + files.length;
  const breadcrumb = `<nav class="drive-breadcrumb" aria-label="Current folder"><button type="button" data-open-folder="" title="My Drive">${icon("home")}<span>My Drive</span></button>${path.map((folder) => `<i aria-hidden="true">/</i><button type="button" data-open-folder="${folder.id}">${esc(folder.name)}</button>`).join("")}</nav>`;
  const emptyLabel = filters.search ? "No matches" : currentFolderId ? "This folder is empty" : "No files yet";
  return `<section class="view-head view-head--compact drive-head"><div><h1>My Drive</h1></div><div class="drive-upload-actions"><div class="button-row"><button class="button button--ghost" type="button" data-new-folder>${icon("folder")}<span>New folder</span></button><label class="button button--ghost camera-button file-picker-button">${icon("camera")}<span>Take photo</span><input type="file" accept="image/*" capture="environment" data-file-input data-camera-input aria-describedby="upload-file-limit"></label><label class="button upload-button file-picker-button">${icon("upload")}<span>Upload</span><input type="file" data-file-input multiple aria-describedby="upload-file-limit"></label></div><small id="upload-file-limit">Up to ${uploadLimitMb()} MB per file</small></div></section>
  <section class="panel drive-panel"><div class="drive-location">${breadcrumb}<span>${itemCount} ${itemCount === 1 ? "item" : "items"}</span></div><div class="drive-toolbar"><label class="search-field">${icon("search")}<span class="visually-hidden">Search this folder</span><input type="search" aria-label="Search this folder" placeholder="Search this folder" value="${esc(filters.search)}" data-file-search></label><label class="sort-field"><span class="visually-hidden">Sort files</span><select aria-label="Sort files" data-file-sort><option value="created-desc" ${filters.sort === "created-desc" ? "selected" : ""}>Created: newest</option><option value="created-asc" ${filters.sort === "created-asc" ? "selected" : ""}>Created: oldest</option><option value="name-asc" ${filters.sort === "name-asc" ? "selected" : ""}>Name: A–Z</option><option value="name-desc" ${filters.sort === "name-desc" ? "selected" : ""}>Name: Z–A</option><option value="size-desc" ${filters.sort === "size-desc" ? "selected" : ""}>Size: largest</option><option value="size-asc" ${filters.sort === "size-asc" ? "selected" : ""}>Size: smallest</option></select></label></div>
  <div class="explorer-table" role="table" aria-label="Files and folders"><div class="explorer-row explorer-head" role="row"><span>Name</span><span>Status</span><span>Size</span><span>Created</span><span>Actions</span></div>${childFolders.map((folder) => folderRow(folder, state)).join("")}${files.map(fileRow).join("")}${itemCount ? "" : `<div class="drive-empty"><h2>${emptyLabel}</h2></div>`}</div></section>
  ${deletionQueue(state.pendingDeletions, state.identity?.vaultId)}
  <dialog class="dialog" data-folder-dialog><form method="dialog" data-folder-form><div class="dialog-head"><h2>New folder</h2><button value="cancel" formnovalidate aria-label="Close dialog">Close</button></div><label>Folder name<input name="name" maxlength="100" required autofocus></label><div class="button-row"><button value="cancel" formnovalidate class="button button--ghost">Cancel</button><button value="default" class="button">Create folder</button></div><p class="form-status" role="status"></p></form></dialog>
  <dialog class="dialog" data-move-dialog><form method="dialog" data-move-form><div class="dialog-head"><h2>Move file</h2><button value="cancel" aria-label="Close dialog">Close</button></div><p data-move-file-name></p><input type="hidden" name="fileId"><label>Destination<select name="folderId"><option value="">My Drive</option>${folderOptions(state.folders)}</select></label><div class="button-row"><button value="cancel" class="button button--ghost">Cancel</button><button value="default" class="button">Move</button></div><p class="form-status" role="status"></p></form></dialog>
  <dialog class="dialog camera-launch-dialog" data-camera-launch-dialog><form method="dialog"><div class="dialog-head"><div><span class="eyebrow">TheMeshVault camera</span><h2>Take a photo into your vault</h2></div><button value="cancel" aria-label="Close camera prompt">Close</button></div><p>Your browser will open the camera. The photo then follows the same encrypted upload as any other file.</p><div class="button-row"><button value="cancel" class="button button--ghost">Not now</button><button type="button" class="button" data-open-camera>${icon("camera")}<span>Open camera</span></button></div></form></dialog>
  ${deletionDialogs()}`;
}

function confirmDeletion({ title, copy, note, confirmLabel }) {
  const dialog = document.querySelector("[data-delete-dialog]");
  dialog.querySelector("[data-delete-title]").textContent = title;
  dialog.querySelector("[data-delete-copy]").textContent = copy;
  dialog.querySelector("[data-delete-note]").textContent = note;
  dialog.querySelector("[data-delete-confirm]").textContent = confirmLabel;
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}

function populateDeletionResult(dialog, result) {
  if (!dialog) return;
  const pending = Number(result?.pending || 0);
  const folder = result?.kind === "folder";
  const resultIds = folder ? result.fileIds || [] : [result?.fileId].filter(Boolean);
  dialog.querySelector("[data-delete-result-title]").textContent = folder ? "Folder removed from your vault" : "File removed from your vault";
  dialog.querySelector("[data-delete-result-copy]").textContent = pending
    ? `${folder ? `${result.fileCount} contained ${result.fileCount === 1 ? "file is" : "files are"}` : "The file is"} no longer visible or shareable. ${pending} encrypted shard ${pending === 1 ? "copy remains" : "copies remain"} only on offline browser nodes and will be erased if those profiles reconnect.`
    : `${folder ? "The folder and its contents have" : "The file has"} been removed, and every known online mesh copy acknowledged deletion.`;
  dialog.querySelector("[data-delete-result-status]").innerHTML = pending
    ? `<strong>${pending} offline ${pending === 1 ? "copy" : "copies"}</strong><span>Signed deletion orders safely queued</span>`
    : `<strong>All known copies deleted</strong><span>Mesh acknowledgements complete</span>`;
  const hideButton = dialog.querySelector("[data-hide-result-status]");
  hideButton.hidden = !pending || !resultIds.length;
  hideButton.dataset.deletionIds = resultIds.join(",");
}

function showDeletionResult(result) {
  activeDeletionResult = result;
  const dialog = document.querySelector("[data-delete-result-dialog]");
  populateDeletionResult(dialog, result);
  if (dialog && !dialog.open) dialog.showModal();
}

export function bindDriveView(actions, state = {}) {
  document.querySelectorAll("[data-file-input]").forEach((input) => input.addEventListener("change", async () => {
    const max = Number(window.__DATA__?.limits?.maxUploadBytes || 100000000);
    for (const file of input.files) {
      if (file.size > max) { actions.error(new Error(`“${file.name}” is larger than the ${Math.round(max / 1000000)} MB per-file limit.`)); continue; }
      try { await actions.upload(file, currentFolderId); } catch (error) { actions.error(error); }
    }
    input.value = "";
    await actions.refresh();
  }));
  document.querySelector("[data-file-search]")?.addEventListener("input", (event) => { filters.search = event.target.value; actions.rerender(); });
  document.querySelector("[data-file-sort]")?.addEventListener("change", (event) => { filters.sort = event.target.value; actions.rerender(); });
  document.querySelectorAll("[data-open-folder]").forEach((button) => button.addEventListener("click", () => {
    currentFolderId = button.dataset.openFolder || null;
    filters.search = "";
    actions.rerender();
  }));
  document.querySelectorAll("[data-file-details]").forEach((button) => button.addEventListener("click", () => {
    const panel = document.getElementById(`file-details-${button.dataset.fileDetails}`);
    if (!panel) return;
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
  }));
  document.querySelectorAll("[data-download-file]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try { await actions.download(button.dataset.downloadFile); await actions.refresh(); }
    catch (error) { if (error?.name !== "AbortError") actions.error(error); }
    finally { button.disabled = false; }
  }));
  document.querySelectorAll("[data-delete-file]").forEach((button) => button.addEventListener("click", async () => {
    const name = button.closest(".file-record")?.querySelector(".file-name strong")?.textContent || "this file";
    if (!await confirmDeletion({
      title: `Delete “${name}”?`,
      copy: "It will disappear from your vault immediately and its known share links will be revoked.",
      note: "Connected mesh nodes erase their shards now. Offline nodes keep only unreadable encrypted pieces and receive a signed erase order when they reconnect.",
      confirmLabel: "Delete file",
    })) return;
    button.disabled = true;
    try {
      const result = await actions.remove(button.dataset.deleteFile);
      await actions.refresh();
      showDeletionResult(result);
    } catch (error) { actions.error(error); }
  }));
  document.querySelectorAll("[data-delete-folder]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const preview = await actions.previewFolderRemoval(button.dataset.deleteFolder);
      button.disabled = false;
      const contents = preview.fileCount
        ? `${preview.fileCount} ${preview.fileCount === 1 ? "file" : "files"}${preview.folderCount > 1 ? ` in ${preview.folderCount} folders` : ""} will also be deleted.`
        : "The folder is empty.";
      if (!await confirmDeletion({
        title: `Delete folder “${preview.name}”?`,
        copy: contents,
        note: preview.fileCount ? "Every contained file uses the same verified mesh deletion process. This cannot be undone." : "The folder will be removed immediately.",
        confirmLabel: preview.fileCount ? "Delete folder and files" : "Delete folder",
      })) return;
      button.disabled = true;
      const result = await actions.removeFolder(button.dataset.deleteFolder);
      await actions.refresh();
      showDeletionResult(result);
    } catch (error) { actions.error(error); }
    finally { button.disabled = false; }
  }));
  document.querySelectorAll("[data-share-file]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; try { const { url } = await actions.share(button.dataset.shareFile); try { await navigator.clipboard.writeText(url); actions.notice("Share link copied to clipboard. It expires in 24 hours.", "success"); } catch { actions.notice(url, "info", 15000); } } catch (error) { actions.error(error); } finally { button.disabled = false; } }));
  const moveDialog = document.querySelector("[data-move-dialog]");
  document.querySelectorAll("[data-move-file]").forEach((button) => button.addEventListener("click", () => {
    const form = moveDialog?.querySelector("[data-move-form]");
    if (!form) return;
    form.elements.fileId.value = button.dataset.moveFile;
    form.elements.folderId.value = currentFolderId || "";
    form.querySelector("[data-move-file-name]").textContent = button.dataset.fileName;
    moveDialog.showModal();
  }));
  document.querySelector("[data-move-form]")?.addEventListener("submit", async (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const status = event.target.querySelector(".form-status"); const values = new FormData(event.target);
    try { await actions.move(values.get("fileId"), values.get("folderId") || null); moveDialog.close(); await actions.refresh(); }
    catch (error) { status.textContent = error.message; }
  });
  document.querySelectorAll("[data-hide-deletion-status]").forEach((button) => button.addEventListener("click", () => {
    hideDeletionIds(state.identity?.vaultId, [button.dataset.hideDeletionStatus]);
    actions.rerender();
  }));
  document.querySelector("[data-hide-result-status]")?.addEventListener("click", (event) => {
    hideDeletionIds(state.identity?.vaultId, (event.currentTarget.dataset.deletionIds || "").split(",").filter(Boolean));
    window.setTimeout(() => actions.rerender(), 0);
  });
  const resultDialog = document.querySelector("[data-delete-result-dialog]");
  if (activeDeletionResult && resultDialog) {
    populateDeletionResult(resultDialog, activeDeletionResult);
    if (!resultDialog.open) resultDialog.showModal();
  }
  resultDialog?.addEventListener("close", () => {
    activeDeletionResult = null;
    window.setTimeout(() => actions.rerender(), 0);
  }, { once: true });
  const dialog = document.querySelector("[data-folder-dialog]");
  document.querySelector("[data-new-folder]")?.addEventListener("click", () => dialog.showModal());
  document.querySelector("[data-folder-form]")?.addEventListener("submit", async (event) => { if (event.submitter?.value === "cancel") return; event.preventDefault(); const status = event.target.querySelector(".form-status"); try { await actions.createFolder(new FormData(event.target).get("name"), currentFolderId); dialog.close(); await actions.refresh(); } catch (error) { status.textContent = error.message; } });
  const cameraDialog = document.querySelector("[data-camera-launch-dialog]");
  document.querySelector("[data-open-camera]")?.addEventListener("click", () => {
    cameraDialog?.close();
    document.querySelector("[data-camera-input]")?.click();
  });
  const cameraRequested = cameraShortcutPending || new URLSearchParams(String(location.hash).split("?")[1] || "").get("camera") === "1";
  if (cameraRequested && cameraDialog) {
    cameraShortcutPending = false;
    cameraDialog.showModal();
    history.replaceState(history.state, "", `${location.pathname}${location.search}#/drive`);
  }
}
