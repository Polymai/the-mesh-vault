import { renderMeshConnections, bindMeshConnections } from "../ui/mesh-connections.js";
import { renderMeshUniverse, bindMeshUniverse } from "../ui/mesh-universe.js";
import { renderDataGlobe, bindDataGlobe, destroyDataGlobe } from "../ui/data-globe.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { currentNode } from "../network/node-service.js";
import { listTopologyObservations } from "../network/topology-registry.js";
import { listKnownPeers } from "../network/peer-registry.js";
import { listShardPlacementsForVersion } from "../services/segment-service.js";
import { getState } from "../state/store.js";

const AMBIENT_NODE_CAP = 12;
const SAMPLE_PAGE_SIZE = 60;
const OVERVIEW_NODE_CAP = 240;
const TOPOLOGY_SCOPES = ["local", "sample", "overview"];
let selectedNodeId = null;
let universeModel = null;
let unbindConnections = null;
let unbindUniverse = null;
let unbindGlobe = null;
let activeVisual = "topology"; // "topology" | "globe" - which visualization panel is shown
let topologyMode = "radial"; // "radial" | "routes" | "clusters" | "universe"
let topologyScope = "local"; // "local" | "sample" | "overview"
let topologySamplePage = 0;
let fullscreenActive = false;
let globeFileId = null;
let globePlacements = new Map(); // nodeId -> {shardCount, bytes} for globeFileId only, refreshed on selection
const openTechnicalNodeIds = new Set();
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const icon = (name) => {
  const paths = {
    network: '<circle cx="12" cy="12" r="2.4"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 7.3 3.2 3M17 7.3l-3.2 3M7 16.7l3.2-3M17 16.7l-3.2-3"/>',
    location: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    radial: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="4" r="1.5"/><circle cx="5.1" cy="16" r="1.5"/><circle cx="18.9" cy="16" r="1.5"/><path d="m12 5.5-5.6 9.2m1.5 1.3h8.2m1.5-1.3L12 5.5"/>',
    routes: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 12h4M11 12c3 0 3-6 6-6M11 12c3 0 3 6 6 6"/>',
    clusters: '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="7" cy="17" r="3"/><circle cx="17" cy="17" r="3"/><path d="M9.5 8.5l5 0M8.5 9.5l0 5M15.5 9.5l0 5M9.5 15.5l5 0"/>',
    universe: '<path d="m12 3 7 4v9l-7 5-7-5V7l7-4Z"/><path d="m5 7 7 4 7-4M12 11v10"/><circle cx="12" cy="11" r="1.4"/>',
    fullscreen: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
    collapse: '<path d="M8 8H3V3M16 8h5V3M8 16H3v5M16 16h5v5"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ""}</svg>`;
};

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}
function formatRate(value) { return value ? `${formatBytes(value)}/s` : "Not measured"; }

function relativeTime(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "Unknown";
  if (elapsed < 15_000) return "Just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)} sec ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  return `${Math.floor(elapsed / 3_600_000)} hr ago`;
}

function shortId(value) {
  const id = String(value || "");
  return id.length > 17 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id || "Not reported";
}

function signatureNode(node = {}) {
  return [
    node.id || node.peerId || null,
    node.vault_id || null,
    node.device_public_key || node.devicePublicKey || null,
    node.failure_domain_id || node.failureDomainId || null,
    node.device_label || node.nodeName || null,
    node.status || null,
    [...(node.capabilities || [])].sort(),
    Number(node.capacity_bytes ?? node.capacityBytes) || 0,
    Number(node.used_bytes ?? node.usedBytes) || 0,
    node.country_code || node.countryCode || null,
    node.region_code || node.regionCode || null,
    node.network_domain_hash || node.networkDomainHash || null,
    node.reliability_score == null && node.reliabilityScore == null
      ? null
      : Math.round(Number(node.reliability_score ?? node.reliabilityScore) * 100),
    !!(node.survival_mode ?? node.survivalMode),
  ];
}

export function meshViewSignature(state = {}) {
  const liveNode = currentNode();
  const connectedNodeIds = connectedProtocols().map((peer) => peer.nodeId).filter(Boolean).sort();
  const knownPeers = listKnownPeers().map(signatureNode).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const knownIds = new Set([
    liveNode?.id,
    ...connectedNodeIds,
    ...(state.nodes || []).map((node) => node.id),
    ...knownPeers.map((peer) => peer[0]),
  ].filter(Boolean));
  const topology = listTopologyObservations()
    .filter((observation) => knownIds.has(observation.nodeId))
    .map((observation) => [
      observation.nodeId,
      observation.devicePublicKey,
      observation.connectedNodeIds.filter((nodeId) => knownIds.has(nodeId)).sort(),
    ])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const files = (state.files || []).map((file) => [
    file.id, file.name || null, file.status || null, file.version?.id || null,
    !!file.resilience?.recoverableNow,
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const transfers = (state.transfers || []).map((transfer) => [
    transfer.id, transfer.status, transfer.target_node_id || null,
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return JSON.stringify({
    visual: activeVisual,
    mode: topologyMode,
    scope: topologyScope,
    samplePage: topologySamplePage,
    fullscreen: fullscreenActive,
    selectedNodeId,
    globeFileId,
    globePlacements: Array.from(globePlacements.entries()).map(([nodeId, value]) => [nodeId, value?.shardCount || 0, value?.bytes || 0]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    liveNode: signatureNode(liveNode || {}),
    connectedNodeIds,
    knownPeers,
    topology,
    nodes: (state.nodes || []).map(signatureNode).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    files,
    transfers,
    myStorageNodeIds: [...(state.myStorageNodeIds || [])].sort(),
    network: [Number(state.network?.activeNodes) || 0, Number(state.network?.verifiedCapacity) || 0],
    anchorEnabled: !!state.anchor?.enabled,
  });
}

// Gossip-known peers (learned peer-to-peer, never queried per-node from
// Supabase) are converted into the same node shape so they render and
// inspect identically to nodes sampled from the coordination cache.
function gossipPeerAsNode(peer) {
  return {
    id: peer.peerId, vault_id: null, device_public_key: peer.devicePublicKey,
    failure_domain_id: peer.peerId, device_label: peer.nodeName || "Mesh peer", status: "online",
    capabilities: peer.capabilities || [],
    capacity_bytes: peer.capacityBytes || 0, used_bytes: peer.usedBytes || 0,
    country_code: peer.countryCode || null, region_code: peer.regionCode || null, network_domain_hash: peer.networkDomainHash || null,
    reliability_score: peer.reliabilityScore, survival_mode: peer.survivalMode, lease_expires_at: peer.leaseExpiresAt,
    uptime_seconds: peer.uptimeSeconds, buddy_node_ids: peer.buddyNodeIds || [],
    last_seen_at: new Date(peer.lastSeenAt).toISOString(), source: "gossip",
  };
}

// Never render the whole network. The "core" - the current node, directly
// connected peers, and nodes known to actually hold this vault's own files -
// is always shown in full: it is bounded by this vault's own data and peer
// connections, not by how many other users exist, so it never needs a cap.
// A small "ambient" layer of the largest known contributors (gossip-learned
// capacity, never an extra Supabase query) is added only for visual context
// and capped low, rendered with reduced prominence so it reads as background
// mesh activity and is never confused with this vault's real relationships.
function nodeRole(node, currentId, connectedIds) {
  if (node.id === currentId) return "current";
  if (connectedIds.has(node.id)) return "connected";
  if (node.has_my_files) return "mine";
  return "ambient";
}
function mergeAndCapNodes(stateNodes, currentRecord, connectedIds, myStorageNodeIds) {
  const byId = new Map(stateNodes.map((node) => [node.id, node]));
  listKnownPeers().forEach((peer) => {
    const existing = byId.get(peer.peerId);
    if (!existing) byId.set(peer.peerId, gossipPeerAsNode(peer));
    else byId.set(peer.peerId, {
      ...existing,
      device_label: peer.nodeName || existing.device_label || "Mesh peer",
      capabilities: peer.capabilities?.length ? peer.capabilities : (existing.capabilities || []),
      capacity_bytes: peer.capacityBytes || existing.capacity_bytes || 0,
      used_bytes: peer.capacityBytes ? peer.usedBytes : (existing.used_bytes || 0),
      survival_mode: peer.survivalMode ?? existing.survival_mode,
      lease_expires_at: peer.leaseExpiresAt || existing.lease_expires_at,
      uptime_seconds: peer.uptimeSeconds ?? existing.uptime_seconds,
      buddy_node_ids: peer.buddyNodeIds?.length ? peer.buddyNodeIds : (existing.buddy_node_ids || []),
    });
  });
  if (currentRecord) byId.set(currentRecord.id, currentRecord);
  const mine = new Set(myStorageNodeIds);
  const all = Array.from(byId.values()).map((node) => ({ ...node, has_my_files: mine.has(node.id) }));
  const core = all.filter((node) => nodeRole(node, currentRecord?.id, connectedIds) !== "ambient");
  const ambientPool = all.filter((node) => nodeRole(node, currentRecord?.id, connectedIds) === "ambient")
    .sort((a, b) => Number(b.capacity_bytes || 0) - Number(a.capacity_bytes || 0));
  const ambient = ambientPool.map((node) => ({ ...node, is_ambient: true }));
  return { core, ambient, all: [...core, ...ambient] };
}

function connectionFor(node, currentId, connectedIds) {
  if (node.id === currentId) return { label: "This browser", detail: "Local storage node", tone: "local" };
  if (connectedIds.has(node.id)) return { label: "WebRTC connected", detail: "Encrypted data channel open", tone: "connected" };
  if (node.status === "paused") return { label: "Paused", detail: "Visible, but not accepting storage", tone: "paused" };
  if (node.survival_mode && Date.parse(node.lease_expires_at || 0) <= Date.now()) return { label: "Lease expired", detail: "Anchor availability is no longer verified", tone: "offline" };
  if (node.status !== "online") return { label: "Not available", detail: "No direct data channel", tone: "offline" };
  return { label: "Discovered", detail: "Seen via coordination; no direct channel", tone: "visible" };
}

function nodeInspector(node, currentId, connectedIds, edges, nodeById) {
  if (!node) return `<section class="panel node-inspector node-inspector--empty" data-node-inspector><h2>No nodes yet</h2></section>`;
  const capacity = Number(node.capacity_bytes) || 0;
  const used = Math.min(capacity, Number(node.used_bytes) || 0);
  const available = Math.max(0, capacity - used);
  const percent = capacity ? Math.min(100, Math.round((used / capacity) * 100)) : 0;
  const connection = connectionFor(node, currentId, connectedIds);
  const baseKind = node.id === currentId ? "Current browser" : node.vault_id ? "Vault browser" : "Storage-only browser";
  const kind = node.is_anchor ? `Anchor · ${baseKind.toLowerCase()}` : `${baseKind} node`;
  const location = [node.region_code, node.country_code].filter(Boolean).join(", ") || "Unknown coarse location";
  const quality = node.peer_quality || {};
  const leaseRemaining = node.lease_expires_at ? Math.max(0, Date.parse(node.lease_expires_at) - Date.now()) : 0;
  const anchorLease = !node.is_anchor ? "Not an Anchor" : leaseRemaining ? `${Math.ceil(leaseRemaining / 1000)} sec remaining` : node.survival_mode ? "Lease expired" : "Active while browser is open";
  const neighborIds = Array.from(new Set(edges.flatMap((edge) => edge.source === node.id ? [edge.target] : edge.target === node.id ? [edge.source] : [])));
  return `<section class="panel node-inspector" data-node-inspector>
    <div class="node-inspector__summary">
      <div class="node-inspector__head"><h2>${esc(node.device_label || "Browser node")}</h2><span class="node-connection node-connection--${connection.tone}" title="${esc(connection.detail)}"><i></i>${connection.label}</span></div>
      <div class="node-role-badges">${node.is_anchor ? `<span class="node-anchor-badge"><i></i>Anchor</span>` : ""}${node.has_my_files ? `<span class="node-mine-badge">Stores segments of your files</span>` : ""}</div>
      <div class="node-capacity"><div><span>Local contribution</span><strong>${formatBytes(capacity)}</strong></div><div class="node-capacity__track" role="progressbar" aria-label="Node storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div><div class="node-capacity__labels"><span>${formatBytes(used)} used</span><span>${formatBytes(available)} free</span></div></div>
    </div>
    <div class="node-inspector__main">
      <dl class="node-quick-facts">
        <div><dt>Location</dt><dd>${esc(location)}</dd></div>
        <div><dt>Last seen</dt><dd>${relativeTime(node.last_seen_at)}</dd></div>
        <div><dt>Reliability</dt><dd>${node.reliability_score == null ? "—" : `${Math.round(Number(node.reliability_score) * 100)}%`}</dd></div>
      </dl>
      <div class="node-neighbors"><div><h3>Connections</h3><span>${neighborIds.length} live</span></div>${neighborIds.length ? neighborIds.map((id) => { const neighbor = nodeById.get(id); return neighbor ? `<button type="button" data-mesh-node="${esc(id)}"><i></i><span><strong>${esc(neighbor.device_label || "Browser node")}</strong></span><b aria-hidden="true">&rarr;</b></button>` : ""; }).join("") : `<p>No direct links.</p>`}</div>
      <details class="node-technical" data-node-technical="${esc(node.id)}"${openTechnicalNodeIds.has(node.id) ? " open" : ""}>
        <summary>Technical details</summary>
        <dl class="node-detail-grid">
          <div><dt>Role</dt><dd>${kind}</dd></div>
          <div><dt>Node ID</dt><dd><code title="${esc(node.id)}">${esc(shortId(node.id))}</code></dd></div>
          <div><dt>Browser profile domain</dt><dd><code title="${esc(node.failure_domain_id)}">${esc(shortId(node.failure_domain_id))}</code></dd></div>
          <div><dt>Observed RTT</dt><dd>${Number.isFinite(quality.rttEwmaMs) ? `${Math.round(quality.rttEwmaMs)} ms` : "Not measured"}</dd></div>
          <div><dt>Observed throughput</dt><dd>${formatRate(quality.throughputEwmaBps)}</dd></div>
          <div><dt>Network domain</dt><dd>${node.network_domain_hash ? `<code title="${esc(node.network_domain_hash)}">${esc(shortId(node.network_domain_hash))}</code>` : "Unknown"}</dd></div>
          <div><dt>Anchor lease</dt><dd>${anchorLease}</dd></div>
          <div><dt>Continuous session</dt><dd>${node.uptime_seconds == null ? "Not reported" : `${Math.floor(Number(node.uptime_seconds) / 3600)}h ${Math.floor((Number(node.uptime_seconds) % 3600) / 60)}m`}</dd></div>
          <div><dt>Anchor buddies</dt><dd>${node.is_anchor ? `${Array.isArray(node.buddy_node_ids) ? node.buddy_node_ids.length : 0} reported` : "Not applicable"}</dd></div>
        </dl>
      </details>
    </div>
  </section>`;
}

function topologyEdges(nodes, currentId, connectedIds, transferringIds) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeMap = new Map();
  const add = (source, target, direct = false) => {
    if (!nodeById.has(source) || !nodeById.has(target) || source === target) return;
    const key = [source, target].sort().join(":");
    const existing = edgeMap.get(key);
    edgeMap.set(key, { source, target, direct: direct || existing?.direct || false, transferring: existing?.transferring || transferringIds.has(source) || transferringIds.has(target) });
  };
  connectedIds.forEach((nodeId) => add(currentId, nodeId, true));
  listTopologyObservations().forEach((observation) => {
    const reporter = nodeById.get(observation.nodeId);
    if (!reporter || reporter.device_public_key !== observation.devicePublicKey) return;
    observation.connectedNodeIds.forEach((nodeId) => add(observation.nodeId, nodeId, observation.nodeId === currentId || nodeId === currentId));
  });
  return Array.from(edgeMap.values());
}

function fileSelectorMarkup(files, selectedFileId) {
  const options = (files || []).map((file) => `<option value="${esc(file.id)}"${file.id === selectedFileId ? " selected" : ""}>${esc(file.name || "Untitled file")}</option>`).join("");
  return `<div class="data-globe-file-picker"><label class="visually-hidden" for="data-globe-file-select">File locations</label><select id="data-globe-file-select" aria-label="Choose a file to show its locations" data-globe-file-select><option value="">All nodes</option>${options}</select></div>`;
}

function topologyScopeMarkup({ renderedCount, activeCount, samplePage, samplePages }) {
  const index = TOPOLOGY_SCOPES.indexOf(topologyScope);
  const label = topologyScope === "local" ? "Local" : topologyScope === "sample" ? "Sample" : "Network";
  const paging = topologyScope === "sample" && samplePages > 1
    ? `<div class="mesh-sample-pages"><button type="button" data-mesh-sample-step="-1" ${samplePage === 0 ? "disabled" : ""} aria-label="Previous recent-node sample" title="Previous sample">&lsaquo;</button><span>${samplePage + 1}/${samplePages}</span><button type="button" data-mesh-sample-step="1" ${samplePage >= samplePages - 1 ? "disabled" : ""} aria-label="Next recent-node sample" title="Next sample">&rsaquo;</button></div>`
    : "";
  return `<div class="mesh-scope-toolbar">
    <button type="button" data-mesh-scope-step="1" ${index >= TOPOLOGY_SCOPES.length - 1 ? "disabled" : ""} aria-label="Show more nodes" title="Show more nodes">More</button>
    <span><strong>${label}</strong><small>${renderedCount}/${activeCount} nodes</small></span>
    <button type="button" data-mesh-scope-step="-1" ${index <= 0 ? "disabled" : ""} aria-label="Show fewer nodes" title="Show fewer nodes">Less</button>
    ${paging}
  </div>`;
}

export function renderMeshView(state) {
  const liveNode = currentNode();
  const connectedPeers = connectedProtocols(); const connectedIds = new Set(connectedPeers.map((peer) => peer.nodeId)); const qualityById = new Map(connectedPeers.map((peer) => [peer.nodeId, peer.quality || peer.protocol?.metrics?.() || null]));
  const stateNodes = state.nodes || [];
  const currentRecord = liveNode ? { ...(stateNodes.find((node) => node.id === liveNode.id) || {}), ...liveNode } : null;
  const merged = mergeAndCapNodes(stateNodes, currentRecord, connectedIds, state.myStorageNodeIds || []);
  const samplePages = Math.max(1, Math.ceil(merged.ambient.length / SAMPLE_PAGE_SIZE));
  if (topologySamplePage >= samplePages) topologySamplePage = samplePages - 1;
  const visibleAmbient = topologyScope === "overview"
    ? merged.ambient.slice(0, OVERVIEW_NODE_CAP)
    : topologyScope === "sample"
      ? merged.ambient.slice(topologySamplePage * SAMPLE_PAGE_SIZE, (topologySamplePage + 1) * SAMPLE_PAGE_SIZE)
      : merged.ambient.slice(0, AMBIENT_NODE_CAP);
  const scopedNodes = [...merged.core, ...visibleAmbient];
  const allNodes = scopedNodes.map((node) => ({
    ...node,
    peer_quality: qualityById.get(node.id) || null,
    is_anchor: node.id === currentRecord?.id
      ? !!state.anchor?.enabled
      : !!node.survival_mode || !!node.capabilities?.includes("anchor-control-v1"),
  }));
  if (!allNodes.some((node) => node.id === selectedNodeId)) selectedNodeId = currentRecord?.id || allNodes[0]?.id || null;
  const selectedNode = allNodes.find((node) => node.id === selectedNodeId) || null;
  const transferringIds = new Set((state.transfers || []).map((transfer) => transfer.target_node_id).filter(Boolean));
  const edges = topologyEdges(allNodes, currentRecord?.id, connectedIds, transferringIds);
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  universeModel = { nodes: allNodes, edges, selectedNodeId, currentNodeId: currentRecord?.id };
  const recoverableFiles = state.files.filter((file) => file.resilience?.recoverableNow ?? ["recoverable", "resilient"].includes(file.status)).length;
  const knownCountries = new Set(merged.all.map((node) => node.country_code).filter(Boolean)).size;
  const activeNodeCount = Math.max(Number(state.network.activeNodes || 0), merged.all.length);

  const isGlobe = activeVisual === "globe";
  const panelHead = isGlobe
    ? `<h2>File locations</h2>${globeFileId ? `<span>${globePlacements.size} node${globePlacements.size === 1 ? "" : "s"}</span>` : ""}`
    : `<h2>Live mesh</h2><div class="mesh-panel-tools"><span>${state.transfers.length} active</span><div class="mesh-display-toggle" role="group" aria-label="Live Mesh view"><button type="button" class="${topologyMode === "radial" ? "is-active" : ""}" data-mesh-display="radial" aria-pressed="${topologyMode === "radial"}" aria-label="Radial view" title="Radial">${icon("radial")}</button><button type="button" class="${topologyMode === "routes" ? "is-active" : ""}" data-mesh-display="routes" aria-pressed="${topologyMode === "routes"}" aria-label="Route view" title="Routes">${icon("routes")}</button><button type="button" class="${topologyMode === "clusters" ? "is-active" : ""}" data-mesh-display="clusters" aria-pressed="${topologyMode === "clusters"}" aria-label="Cluster view" title="Clusters">${icon("clusters")}</button><button type="button" class="${topologyMode === "universe" ? "is-active" : ""}" data-mesh-display="universe" aria-pressed="${topologyMode === "universe"}" aria-label="3D universe view" title="3D universe">${icon("universe")}</button></div></div>`;
  const panelBody = isGlobe
    ? `${fileSelectorMarkup(state.files, globeFileId)}${renderDataGlobe()}`
    : `<div class="mesh-connections-stage">${topologyMode === "universe"
      ? renderMeshUniverse(allNodes, edges, { selectedNodeId, currentNodeId: currentRecord?.id })
      : renderMeshConnections(allNodes, edges, { mode: topologyMode })}${topologyScopeMarkup({ renderedCount: allNodes.length, activeCount: activeNodeCount, samplePage: topologySamplePage, samplePages })}</div>`;

  return `<h1 class="mesh-view-title">Live Mesh</h1>
  <div class="mesh-layout${fullscreenActive ? " is-fullscreen" : ""}" data-mesh-layout>
    <div class="mesh-visual-toggle" role="tablist" aria-label="Mesh visualization mode">
      <button type="button" role="tab" aria-selected="${!isGlobe}" class="${!isGlobe ? "is-active" : ""}" data-mesh-visual="topology" aria-label="Network" title="Network">${icon("network")}<span class="visually-hidden">Network</span></button>
      <button type="button" role="tab" aria-selected="${isGlobe}" class="${isGlobe ? "is-active" : ""}" data-mesh-visual="globe" aria-label="File locations" title="File locations">${icon("location")}<span class="visually-hidden">File locations</span></button>
      <button type="button" class="mesh-fullscreen-toggle" data-mesh-fullscreen-toggle aria-pressed="${fullscreenActive}" aria-label="${fullscreenActive ? "Exit fullscreen" : "Fullscreen"}" title="${fullscreenActive ? "Exit fullscreen" : "Fullscreen"}">${icon(fullscreenActive ? "collapse" : "fullscreen")}<span class="visually-hidden">${fullscreenActive ? "Exit fullscreen" : "Fullscreen"}</span></button>
    </div>
    <section class="mesh-panel"><div class="panel-head">${panelHead}</div>${panelBody}</section>
    <aside class="mesh-rail">${nodeInspector(selectedNode, currentRecord?.id, connectedIds, edges, nodeById)}<section class="panel mesh-stats"><div><strong>${state.network.activeNodes}</strong><span>live nodes</span></div><div><strong>${knownCountries || "—"}</strong><span>countries</span></div><div><strong>${formatBytes(state.network.verifiedCapacity)}</strong><span>capacity</span></div><div><strong>${recoverableFiles}</strong><span>recoverable files</span></div></section></aside>
  </div>`;
}

let removeFullscreenKeydown = null;

export function bindMeshView(actions) {
  const select = (nodeId) => {
    if (!nodeId || nodeId === selectedNodeId) return;
    selectedNodeId = nodeId;
    actions.rerender();
  };
  unbindConnections?.(); unbindConnections = null;
  unbindUniverse?.(); unbindUniverse = null;
  unbindGlobe?.(); unbindGlobe = null;
  if (activeVisual === "globe") {
    unbindGlobe = universeModel ? bindDataGlobe({ nodes: universeModel.nodes, currentNodeId: universeModel.currentNodeId, edges: universeModel.edges, placementsByNode: globePlacements, onSelect: select }) : null;
  } else if (topologyMode === "universe") {
    destroyDataGlobe();
    unbindUniverse = universeModel ? bindMeshUniverse({ ...universeModel, onSelect: select }) : null;
  } else {
    destroyDataGlobe();
    unbindConnections = universeModel ? bindMeshConnections({ ...universeModel, mode: topologyMode, onSelect: select }) : null;
  }
  document.querySelectorAll("[data-mesh-node]").forEach((element) => {
    element.addEventListener("click", () => select(element.dataset.meshNode));
    if (element.tagName.toLowerCase() === "g") element.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      select(element.dataset.meshNode);
    });
  });
  document.querySelectorAll("[data-node-technical]").forEach((details) => {
    details.addEventListener("toggle", () => {
      const nodeId = details.dataset.nodeTechnical;
      if (!nodeId) return;
      if (details.open) openTechnicalNodeIds.add(nodeId);
      else openTechnicalNodeIds.delete(nodeId);
    });
  });
  document.querySelectorAll("[data-mesh-visual]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.meshVisual;
      if (next === activeVisual) return;
      activeVisual = next;
      actions.rerender();
    });
  });
  document.querySelectorAll("[data-mesh-display]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.meshDisplay;
      if (next === topologyMode) return;
      topologyMode = next;
      actions.rerender();
    });
  });
  document.querySelectorAll("[data-mesh-scope-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = TOPOLOGY_SCOPES.indexOf(topologyScope);
      const next = TOPOLOGY_SCOPES[Math.max(0, Math.min(TOPOLOGY_SCOPES.length - 1, index + Number(button.dataset.meshScopeStep || 0)))];
      if (!next || next === topologyScope) return;
      topologyScope = next;
      topologySamplePage = 0;
      actions.rerender();
    });
  });
  document.querySelectorAll("[data-mesh-sample-step]").forEach((button) => {
    button.addEventListener("click", () => {
      topologySamplePage = Math.max(0, topologySamplePage + Number(button.dataset.meshSampleStep || 0));
      actions.rerender();
    });
  });
  document.querySelector("[data-mesh-fullscreen-toggle]")?.addEventListener("click", () => {
    fullscreenActive = !fullscreenActive;
    actions.rerender();
  });
  document.querySelector("[data-globe-file-select]")?.addEventListener("change", async (event) => {
    const fileId = event.target.value || null;
    globeFileId = fileId;
    if (!fileId) { globePlacements = new Map(); actions.rerender(); return; }
    const file = getState().files.find((entry) => entry.id === fileId);
    if (!file?.version?.id) { globePlacements = new Map(); actions.rerender(); return; }
    try {
      const rows = await listShardPlacementsForVersion(file.vault_id, file.version.id);
      globePlacements = new Map(rows.map((row) => [row.nodeId, row]));
    } catch { globePlacements = new Map(); }
    actions.rerender();
  });
  removeFullscreenKeydown?.();
  const onFullscreenKeydown = (event) => {
    if (event.key !== "Escape" || !fullscreenActive) return;
    fullscreenActive = false;
    actions.rerender();
  };
  window.addEventListener("keydown", onFullscreenKeydown);
  removeFullscreenKeydown = () => window.removeEventListener("keydown", onFullscreenKeydown);
}

export function disposeMeshView() {
  unbindConnections?.(); unbindConnections = null;
  unbindUniverse?.(); unbindUniverse = null;
  unbindGlobe?.(); unbindGlobe = null;
  destroyDataGlobe();
  removeFullscreenKeydown?.(); removeFullscreenKeydown = null;
}
