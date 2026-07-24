import { renderMeshUniverse, bindMeshUniverse } from "../ui/mesh-universe.js";
import { renderDataGlobe, bindDataGlobe } from "../ui/data-globe.js";
import { connectedProtocols } from "../network/peer-manager.js";
import { currentNode } from "../network/node-service.js";
import { listTopologyObservations } from "../network/topology-registry.js";
import { listKnownPeers } from "../network/peer-registry.js";
import { listShardPlacementsForVersion } from "../services/segment-service.js";
import { getState } from "../state/store.js";

const AMBIENT_NODE_CAP = 12;
let selectedNodeId = null;
let universeModel = null;
let unbindUniverse = null;
let unbindGlobe = null;
let activeVisual = "topology"; // "topology" | "globe" - which visualization panel is shown
let fullscreenActive = false;
let globeFileId = null;
let globePlacements = new Map(); // nodeId -> {shardCount, bytes} for globeFileId only, refreshed on selection
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));

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

// Gossip-known peers (learned peer-to-peer, never queried per-node from
// Supabase) are converted into the same node shape so they render and
// inspect identically to nodes sampled from the coordination cache.
function gossipPeerAsNode(peer) {
  return {
    id: peer.peerId, vault_id: null, device_public_key: peer.devicePublicKey,
    failure_domain_id: peer.peerId, device_label: "Mesh peer", status: "online",
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
  const ambient = ambientPool.slice(0, AMBIENT_NODE_CAP).map((node) => ({ ...node, is_ambient: true }));
  return { rendered: [...core, ...ambient], coreCount: core.length, hiddenAmbientCount: Math.max(0, ambientPool.length - ambient.length) };
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
  if (!node) return `<section class="panel node-inspector" data-node-inspector><span class="eyebrow">Node details</span><h2>No node selected</h2><p>Nodes will appear here when this browser discovers the mesh.</p></section>`;
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
      <div class="node-inspector__head"><div><span class="eyebrow">Selected node</span><h2>${esc(node.device_label || "Browser node")}</h2></div><span class="node-connection node-connection--${connection.tone}"><i></i>${connection.label}</span></div>
      <p class="node-connection-detail">${connection.detail}</p>
      <div class="node-role-badges">${node.is_anchor ? `<span class="node-anchor-badge"><i></i>Anchor</span>` : ""}${node.has_my_files ? `<span class="node-mine-badge">Stores segments of your files</span>` : ""}</div>
      <div class="node-capacity"><div><span>Local contribution</span><strong>${formatBytes(capacity)}</strong></div><div class="node-capacity__track" role="progressbar" aria-label="Node storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div><div class="node-capacity__labels"><span>${formatBytes(used)} used</span><span>${formatBytes(available)} free</span></div></div>
    </div>
    <dl class="node-detail-grid">
      <div><dt>Role</dt><dd>${kind}</dd></div>
      <div><dt>Last report</dt><dd>${relativeTime(node.last_seen_at)}</dd></div>
      <div><dt>Node ID</dt><dd><code title="${esc(node.id)}">${esc(shortId(node.id))}</code></dd></div>
      <div><dt>Browser profile domain</dt><dd><code title="${esc(node.failure_domain_id)}">${esc(shortId(node.failure_domain_id))}</code></dd></div>
      <div><dt>Coarse location</dt><dd>${esc(location)}</dd></div>
      <div><dt>Observed RTT</dt><dd>${Number.isFinite(quality.rttEwmaMs) ? `${Math.round(quality.rttEwmaMs)} ms` : "Not measured"}</dd></div>
      <div><dt>Observed throughput</dt><dd>${formatRate(quality.throughputEwmaBps)}</dd></div>
      <div><dt>Network domain</dt><dd>${node.network_domain_hash ? `<code title="${esc(node.network_domain_hash)}">${esc(shortId(node.network_domain_hash))}</code>` : "Unknown"}</dd></div>
      <div><dt>Anchor lease</dt><dd>${anchorLease}</dd></div>
      <div><dt>Measured reliability</dt><dd>${node.reliability_score == null ? "Not measured" : `${Math.round(Number(node.reliability_score) * 100)}%`}</dd></div>
      <div><dt>Continuous session</dt><dd>${node.uptime_seconds == null ? "Not reported" : `${Math.floor(Number(node.uptime_seconds) / 3600)}h ${Math.floor((Number(node.uptime_seconds) % 3600) / 60)}m`}</dd></div>
      <div><dt>Anchor buddies</dt><dd>${node.is_anchor ? `${Array.isArray(node.buddy_node_ids) ? node.buddy_node_ids.length : 0} reported` : "Not applicable"}</dd></div>
    </dl>
    <div class="node-neighbors"><div><h3>Observed connections</h3><span>${neighborIds.length} live ${neighborIds.length === 1 ? "link" : "links"}</span></div>${neighborIds.length ? neighborIds.map((id) => { const neighbor = nodeById.get(id); return neighbor ? `<button type="button" data-mesh-node="${esc(id)}"><i></i><span><strong>${esc(neighbor.device_label || "Browser node")}</strong><small>Fly to this node</small></span><b aria-hidden="true">&rarr;</b></button>` : ""; }).join("") : `<p>No WebRTC links from this node have been observed. It may only be visible through discovery.</p>`}</div>
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

function nodeDirectory(nodes, currentId, connectedIds) {
  if (!nodes.length) return "";
  return `<div class="mesh-node-directory" role="list" aria-label="Recently visible mesh nodes">${nodes.map((node) => {
    const connection = connectionFor(node, currentId, connectedIds);
    const capacity = Number(node.capacity_bytes) || 0;
    const used = Math.min(capacity, Number(node.used_bytes) || 0);
    const place = [node.region_code, node.country_code].filter(Boolean).join(" / ");
    return `<button class="mesh-node-card${selectedNodeId === node.id ? " is-selected" : ""}${node.is_anchor ? " is-anchor" : ""}" type="button" role="listitem" data-mesh-node="${esc(node.id)}"><i class="node-status-dot node-status-dot--${node.is_anchor ? "anchor" : connection.tone}"></i><span><strong>${esc(node.device_label || "Browser node")}${node.id === currentId ? " (you)" : ""}</strong><small>${esc(place || (node.has_my_files ? "Stores your files" : connection.label))}</small>${node.is_anchor ? `<em class="mesh-node-card__role">Anchor</em>` : ""}</span><span class="mesh-node-card__capacity"><strong>${formatBytes(Math.max(0, capacity - used))}</strong><small>free</small></span></button>`;
  }).join("")}</div>`;
}

function fileSelectorMarkup(files, selectedFileId) {
  const options = (files || []).map((file) => `<option value="${esc(file.id)}"${file.id === selectedFileId ? " selected" : ""}>${esc(file.name || "Untitled file")}</option>`).join("");
  return `<div class="data-globe-file-picker"><label for="data-globe-file-select">Highlight a file's storage locations</label><select id="data-globe-file-select" data-globe-file-select><option value="">All nodes (no file selected)</option>${options}</select></div>`;
}

export function renderMeshView(state) {
  const liveNode = currentNode();
  const connectedPeers = connectedProtocols(); const connectedIds = new Set(connectedPeers.map((peer) => peer.nodeId)); const qualityById = new Map(connectedPeers.map((peer) => [peer.nodeId, peer.quality || peer.protocol?.metrics?.() || null]));
  const stateNodes = state.nodes || [];
  const currentRecord = liveNode ? { ...(stateNodes.find((node) => node.id === liveNode.id) || {}), ...liveNode } : null;
  const merged = mergeAndCapNodes(stateNodes, currentRecord, connectedIds, state.myStorageNodeIds || []);
  const allNodes = merged.rendered.map((node) => ({
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
  const knownCountries = new Set(allNodes.map((node) => node.country_code).filter(Boolean)).size;

  const isGlobe = activeVisual === "globe";
  const panelHead = isGlobe
    ? `<div><h2>Data locations</h2></div>${globeFileId ? `<span>${globePlacements.size} node${globePlacements.size === 1 ? "" : "s"} holding this file</span>` : ""}`
    : `<div><h2>Mesh universe</h2></div><span>${state.transfers.length} transfers</span>`;
  const panelBody = isGlobe
    ? `${fileSelectorMarkup(state.files, globeFileId)}${renderDataGlobe()}`
    : `${renderMeshUniverse(allNodes, edges, { selectedNodeId, currentNodeId: currentRecord?.id })}${nodeDirectory(allNodes.filter((node) => !node.is_ambient), currentRecord?.id, connectedIds)}`;

  return `<h1 class="mesh-view-title">Live Mesh</h1>
  <div class="mesh-layout${fullscreenActive ? " is-fullscreen" : ""}" data-mesh-layout>
    <div class="mesh-visual-toggle" role="tablist" aria-label="Mesh visualization mode">
      <button type="button" role="tab" aria-selected="${!isGlobe}" class="${!isGlobe ? "is-active" : ""}" data-mesh-visual="topology">Network topology</button>
      <button type="button" role="tab" aria-selected="${isGlobe}" class="${isGlobe ? "is-active" : ""}" data-mesh-visual="globe">Data locations</button>
      <button type="button" class="mesh-fullscreen-toggle" data-mesh-fullscreen-toggle aria-pressed="${fullscreenActive}">${fullscreenActive ? "Exit fullscreen" : "Fullscreen"}</button>
    </div>
    <section class="panel mesh-panel"><div class="panel-head">${panelHead}</div>${panelBody}</section>
    <aside class="mesh-rail">${nodeInspector(selectedNode, currentRecord?.id, connectedIds, edges, nodeById)}<section class="panel mesh-stats"><span class="eyebrow">Measured resilience</span><div><strong>${state.network.activeNodes}</strong><span>active browser-profile domains</span></div><div><strong>${knownCountries || "—"}</strong><span>coarse countries visible here</span></div><div><strong>${formatBytes(state.network.verifiedCapacity)}</strong><span>reported capacity</span></div><div><strong>${recoverableFiles}</strong><span>currently recoverable files</span></div><p>RTT and throughput are measured by this browser. Country and region are coarse Edge hints, not proof of physical separation; unknown values remain unknown.</p></section></aside>
  </div>`;
}

let removeFullscreenKeydown = null;

export function bindMeshView(actions) {
  const select = (nodeId) => {
    if (!nodeId || nodeId === selectedNodeId) return;
    selectedNodeId = nodeId;
    actions.rerender();
  };
  unbindUniverse?.(); unbindUniverse = null;
  unbindGlobe?.(); unbindGlobe = null;
  if (activeVisual === "globe") {
    unbindGlobe = universeModel ? bindDataGlobe({ nodes: universeModel.nodes, currentNodeId: universeModel.currentNodeId, edges: universeModel.edges, placementsByNode: globePlacements, onSelect: select }) : null;
  } else {
    unbindUniverse = universeModel ? bindMeshUniverse({ ...universeModel, onSelect: select }) : null;
  }
  document.querySelectorAll("[data-mesh-node]").forEach((element) => {
    element.addEventListener("click", () => select(element.dataset.meshNode));
    if (element.tagName.toLowerCase() === "g") element.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      select(element.dataset.meshNode);
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
