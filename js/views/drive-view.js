import { filterAndSortFiles } from "../services/metadata-service.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const bytes = (value = 0) => { const units = ["B", "KB", "MB", "GB", "TB"]; let n = Number(value), i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`; };
const pct = (value) => `${Math.max(0, Number(value) || 0).toFixed(1)}%`;
const uploadLimitMb = () => Math.round(Number(window.__DATA__?.limits?.maxUploadBytes || 100000000) / 1000000);
let filters = { search: "", sort: "newest" };
let activeDeletionResult = null;
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
  return `<div class="file-record"><div class="file-row" role="row">
    <div class="file-name"><span class="file-type">${esc((file.name?.split(".").pop() || "file").slice(0, 4).toUpperCase())}</span><div><strong>${esc(file.name)}</strong><small>${esc(file.mime || "Encrypted file")}</small></div></div>
    <span><i class="status-dot status-dot--${esc(statusTone)}"></i>${esc(recoveryLabel(file, true))}</span><span>${bytes(file.size_bytes)}</span>
    <span>weakest segment ${version.active_shards || 0}/${version.total_shards || 0} &middot; ${version.independent_devices || 0} browser ${Number(version.independent_devices || 0) === 1 ? "node" : "nodes"}</span>
    <div class="file-actions"><button type="button" class="text-button" data-download-file="${file.id}" ${downloadable ? "" : "disabled"}>Download</button><button type="button" class="text-button" data-share-file="${file.id}" ${downloadable ? "" : "disabled"}>Share</button><button type="button" class="text-button text-button--danger" data-delete-file="${file.id}">Delete</button></div>
  </div><details class="file-details"><summary>Storage details</summary><div class="storage-ledger">
    <span>Original<strong>${bytes(file.size_bytes)}</strong></span><span>Compressed representation<strong>${bytes(representation)}</strong></span><span>Compression savings<strong>${pct(savings)}</strong></span><span>Redundancy overhead<strong>${pct(overhead)}</strong></span>
    <span>Physical mesh storage<strong>${bytes(physical)}</strong></span><span>Segments<strong>${version.segment_count || 0}</strong></span><span>Shards per segment<strong>${version.total_shards || 0}</strong></span><span>Weakest segment verified<strong>${version.active_shards || 0}</strong></span>
    <span>Repair starts below<strong>${version.repair_threshold_shards || version.minimum_required_shards || 0}</strong></span><span>Physical shard copies<strong>${version.physical_shard_copies || 0}</strong></span><span>Cleanup pending<strong>${version.surplus_placements || 0}</strong></span><span>Independent browser nodes<strong>${version.independent_devices || 0}</strong></span>
    <span>Countries observed<strong>${version.country_count || 0}</strong></span><span>Regions observed<strong>${version.region_count || 0}</strong></span><span>Network domains observed<strong>${version.network_domain_count || 0}</strong></span><span>Minimum per segment<strong>${version.minimum_required_shards || 0}</strong></span>
    <span>Erasure profile<strong>${version.minimum_required_shards || 0} + ${Math.max(0, Number(version.total_shards || 0) - Number(version.minimum_required_shards || 0))}</strong></span><span>Resilience<strong>${esc(recoveryLabel(file))}</strong></span><span>Exact recovery<strong>${version.exact_recovery_verified_at ? "verified" : "not yet verified"}</strong></span><span>Format<strong>segment v${version.format_version || 1}</strong></span>
  </div><p class="storage-assurance">Browser profiles are cryptographically distinct. Surplus copies remain included in physical storage until their device acknowledges deletion.</p></details></div>`;
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
  const foreground = recent.length ? `<section class="panel deletion-queue"><div class="panel-head"><div><span class="eyebrow">Verified deletion</span><h2>Removed — finishing cleanup</h2></div><strong>${recent.length} ${recent.length === 1 ? "file" : "files"}</strong></div>
    <p>The files are gone from your vault and their known share links are revoked. Online nodes erase their copies now. An offline browser can only hold an unreadable encrypted shard; its signed erase order remains queued until that exact browser profile returns.</p>
    ${deletionRows(recent)}</section>` : "";
  const archived = background.length ? `<details class="panel deletion-queue deletion-queue--background"><summary><span><b>Background deletion orders</b><small>${background.length} ${background.length === 1 ? "file has" : "files have"} offline copies that have not returned</small></span><strong>${background.length}</strong></summary>
    <p>These orders are intentionally retained instead of pretending the physical copies vanished. If a device never reconnects, its encrypted shard may remain in that browser storage, but it is no longer part of your vault and cannot be reconstructed without your keys.</p>
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

export function renderDriveView(state) {
  const files = filterAndSortFiles(state.files, filters.search, filters.sort);
  return `<section class="view-head drive-head"><div><span class="eyebrow">Your encrypted files</span><h1>My Drive</h1><p>${state.files.length ? `${state.files.length} ${state.files.length === 1 ? "file" : "files"}, with measured storage and recovery state.` : "Upload a file to begin. TheMeshVault reports only storage it has actually verified."}</p></div><div class="drive-upload-actions"><div class="button-row"><button class="button button--ghost" type="button" data-new-folder>New folder</button><label class="button upload-button">Upload files<input type="file" data-file-input multiple aria-describedby="upload-file-limit"></label></div><small id="upload-file-limit">${uploadLimitMb()} MB maximum per file</small></div></section>
  <section class="panel drive-panel"><div class="drive-toolbar"><label class="search-field"><span>Search</span><input type="search" placeholder="Search file names" value="${esc(filters.search)}" data-file-search></label><label class="sort-field"><span>Sort</span><select data-file-sort><option value="newest" ${filters.sort === "newest" ? "selected" : ""}>Newest</option><option value="name" ${filters.sort === "name" ? "selected" : ""}>Name</option><option value="size" ${filters.sort === "size" ? "selected" : ""}>Size</option></select></label></div>
  ${state.folders.length ? `<div class="folder-strip">${state.folders.map((folder) => `<article class="folder-tile"><span>Folder</span><strong>${esc(folder.name)}</strong><button type="button" class="text-button text-button--danger" data-delete-folder="${folder.id}" data-folder-name="${esc(folder.name)}">Delete</button></article>`).join("")}</div>` : ""}
  <div class="file-table" role="table" aria-label="Encrypted files"><div class="file-row file-row--head" role="row"><span>Name</span><span>Recovery state</span><span>Original size</span><span>Placement</span><span>Actions</span></div>${files.length ? files.map(fileRow).join("") : `<div class="drive-empty"><h2>${filters.search ? "No matching files" : "Nothing stored yet"}</h2><p>${filters.search ? "Try another name." : "Files are processed in blocks of about 8 MB, compressed only when useful, encrypted, and then placed across available browser nodes."}</p></div>`}</div></section>
  ${deletionQueue(state.pendingDeletions, state.identity?.vaultId)}
  <dialog class="dialog" data-folder-dialog><form method="dialog" data-folder-form><div class="dialog-head"><h2>New folder</h2><button value="cancel" aria-label="Close dialog">Close</button></div><label>Folder name<input name="name" maxlength="100" required autofocus></label><div class="button-row"><button value="cancel" class="button button--ghost">Cancel</button><button value="default" class="button">Create folder</button></div><p class="form-status" role="status"></p></form></dialog>
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
      try { await actions.upload(file); } catch (error) { actions.error(error); }
    }
    input.value = "";
    await actions.refresh();
  }));
  document.querySelector("[data-file-search]")?.addEventListener("input", (event) => { filters.search = event.target.value; actions.rerender(); });
  document.querySelector("[data-file-sort]")?.addEventListener("change", (event) => { filters.sort = event.target.value; actions.rerender(); });
  document.querySelectorAll("[data-download-file]").forEach((button) => button.addEventListener("click", async () => { button.disabled = true; try { await actions.download(button.dataset.downloadFile); await actions.refresh(); } catch (error) { actions.error(error); } finally { button.disabled = false; } }));
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
  document.querySelector("[data-folder-form]")?.addEventListener("submit", async (event) => { if (event.submitter?.value === "cancel") return; event.preventDefault(); const status = event.target.querySelector(".form-status"); try { await actions.createFolder(new FormData(event.target).get("name")); dialog.close(); await actions.refresh(); } catch (error) { status.textContent = error.message; } });
}
