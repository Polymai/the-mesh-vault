import { capacityChart } from "../ui/charts.js";

const bytes = (value = 0) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = Number(value); let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount < 10 && unit ? amount.toFixed(1) : Math.round(amount)} ${units[unit]}`;
};

export function renderDashboardView(state) {
  const healthy = state.files.filter((file) => file.resilience?.recoverableNow ?? ["recoverable", "resilient"].includes(file.status)).length;
  const totalFileBytes = state.files.reduce((sum, file) => sum + Number(file.size_bytes || file.version?.original_size || 0), 0);
  const storage = state.vaultStorage || {};
  const pendingDeletionCopies = (state.pendingDeletions || []).reduce((sum, file) => sum + Math.max(0, Number(file.deletion_total_placements || 0) - Number(file.deletion_acknowledged_placements || 0)), 0);
  const compressionPercent = storage.uniqueOriginalBytes ? (storage.compressionSavedBytes / storage.uniqueOriginalBytes) * 100 : 0;
  const profileLabel = storage.profiles?.length ? storage.profiles.map((row) => `${row.profile} (${row.segmentCount})`).join(", ") : "No segments yet";
  const networkAccess = state.network.connectedPeerCount ? `${state.network.connectedPeerCount} connected now` : state.network.bootstrapUp ? "Discovery available" : "Local access only";
  const meshCapacity = Math.max(0, Number(state.network.verifiedCapacity || 0));
  const meshUsed = Math.max(0, Number(state.network.usedBytes || 0));
  const meshFree = Math.max(0, meshCapacity - meshUsed);
  const meshUsagePercent = meshCapacity ? Math.min(100, meshUsed / meshCapacity * 100) : 0;
  const meshUsageLabel = meshCapacity ? `${meshUsagePercent < 10 ? meshUsagePercent.toFixed(1) : Math.round(meshUsagePercent)}%` : "0%";
  const liveNodeCount = Math.max(0, Number(state.network.activeNodes || 0));
  const activity = state.network.events.length
    ? `<ul class="activity-list">${state.network.events.slice(0, 6).map((event) => `<li><span class="event-dot"></span><div><strong>${String(event.event_type).replaceAll("_", " ")}</strong><time>${new Date(event.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div></li>`).join("")}</ul>`
    : `<div class="empty-compact"><strong>No recent movement</strong><span>Transfers and recoveries appear here.</span></div>`;
  const tasks = Object.values(state.activeTasks);
  return `<section class="view-head"><div><span class="eyebrow">Your storage</span><h1>${state.files.length ? `${healthy} of ${state.files.length} files are protected.` : "Your vault is ready."}</h1><p>${state.files.length ? `${bytes(totalFileBytes)} of original files currently use ${bytes(storage.physicalBytes || 0)} across the mesh.` : "Add your first file to see its real compression, shard placement and recovery state."}</p></div><a class="button" href="#/drive">Upload files</a></section>
  <div class="metric-grid">
    <article class="metric-card metric-card--accent"><span>Your files</span><strong>${bytes(totalFileBytes)}</strong><small>${healthy} of ${state.files.length} recoverable now</small></article>
    <article class="metric-card"><span>Mesh storage used</span><strong>${bytes(storage.physicalBytes || 0)}</strong><small>${storage.physicalShardCopies || 0} physical shard copies</small></article>
    <article class="metric-card"><span>Live nodes</span><strong>${liveNodeCount}</strong><small>currently reporting capacity</small></article>
    <article class="metric-card"><span>Direct peers</span><strong>${state.network.connectedPeerCount || 0}</strong><small>${networkAccess}</small></article>
  </div>
  <section class="panel mesh-capacity-panel">
    <div class="panel-head mesh-capacity-head"><div><span class="eyebrow">Currently reported live mesh</span><h2>Mesh capacity</h2><p>Space offered right now by devices that are online and still reporting.</p></div><span class="live-label"><i></i>${liveNodeCount} live ${liveNodeCount === 1 ? "node" : "nodes"}</span></div>
    <div class="mesh-capacity-total"><strong>${bytes(meshCapacity)}</strong><span>${meshCapacity ? "available across the live mesh" : "No live capacity reported right now"}</span></div>
    <div class="mesh-capacity-bar" role="progressbar" aria-label="Live mesh storage in use" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${meshUsagePercent.toFixed(1)}"><i style="--mesh-capacity-fill:${meshUsagePercent.toFixed(3)}%"></i></div>
    <div class="mesh-capacity-stats">
      <span>Used<strong>${bytes(meshUsed)}</strong></span>
      <span>Free<strong>${bytes(meshFree)}</strong></span>
      <span>In use<strong>${meshUsageLabel}</strong></span>
      <span>Live nodes<strong>${liveNodeCount}</strong></span>
    </div>
    <div class="mesh-capacity-timeline"><div><strong>Capacity during the past 24 hours</strong><span>Real network snapshots only</span></div>${capacityChart(state.network.snapshots || [], { compact: true })}</div>
  </section>
  <section class="panel overview-storage"><div class="panel-head"><div><h2>Measured storage</h2><p>Only values reported by this vault and currently live nodes.</p></div><a href="#/drive">Open details</a></div>
    <div class="overview-ledger">
      <span>Unique segments<strong>${storage.uniqueSegments || 0}</strong></span>
      <span>Compressed representation<strong>${bytes(storage.representationBytes || 0)}</strong></span>
      <span>Compression saved<strong>${compressionPercent.toFixed(1)}%</strong></span>
      <span>Active profiles<strong>${profileLabel}</strong></span>
      <span>Cleanup pending<strong>${Number(storage.surplusPlacements || 0) + pendingDeletionCopies}</strong><small>${pendingDeletionCopies} file-deletion copies</small></span>
      <span>This browser stores<strong>${bytes(state.node.usedBytes)}</strong><small>of ${bytes(state.node.capacityBytes)} offered</small></span>
    </div>
    <p class="measurement-note">Physical storage includes acknowledged shard copies, including temporary surplus copies until deletion is confirmed. Live mesh totals exclude nodes that have stopped reporting.</p>
  </section>
  <section class="panel"><div class="panel-head"><h2>Current activity</h2><a href="#/mesh">Open mesh</a></div>${activity}</section>
  ${tasks.length ? `<section class="panel tasks-panel"><h2>File operations</h2>${tasks.map((task) => `<div class="task-row"><div><strong>${task.label}</strong><span>${task.message || task.status}</span></div><progress max="1" value="${task.progress || 0}"></progress></div>`).join("")}</section>` : ""}`;
}
