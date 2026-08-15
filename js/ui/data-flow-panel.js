import { dataFlowSnapshot, subscribeDataFlow } from "../observability/data-flow-log.js";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const ROUTE_LABELS = Object.freeze({ direct: "Peer", anchor: "Anchor", supabase: "Supabase" });

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function flowPath(entry) {
  const other = entry.route === "supabase" ? "Supabase" : entry.counterparty || ROUTE_LABELS[entry.route];
  return entry.direction === "out" ? `This device → ${other}` : `${other} → This device`;
}

function renderContent(snapshot) {
  const summaries = Object.entries(ROUTE_LABELS).map(([route, label]) => {
    const total = snapshot.recentTotals?.[route] || snapshot.totals[route] || {};
    const bytes = Number(total.inboundBytes || 0) + Number(total.outboundBytes || 0);
    return `<div class="data-flow-summary__item data-flow-summary__item--${route}"><i aria-hidden="true"></i><span>${label}</span><strong>${formatBytes(bytes)}</strong></div>`;
  }).join("");
  const events = snapshot.entries.slice(0, 5).map((entry) => `<li class="data-flow-event data-flow-event--${entry.route}">
    <time datetime="${new Date(entry.at).toISOString()}">${new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
    <i aria-hidden="true"></i>
    <span><strong>${esc(entry.kind)}${entry.count > 1 ? ` ×${entry.count}` : ""}</strong><small>${esc(flowPath(entry))}</small></span>
    <b>${formatBytes(entry.bytes)}</b>
  </li>`).join("");
  return `<div class="data-flow-summary">${summaries}</div>${events
    ? `<ol class="data-flow-events">${events}</ol>`
    : `<div class="data-flow-empty"><strong>Waiting for traffic</strong><span>Transfers and coordination will appear here.</span></div>`}`;
}

export function renderDataFlowPanel() {
  return `<section class="panel data-flow-panel" data-data-flow-panel>
    <header class="data-flow-panel__head"><div><h2>Data flow</h2><span class="data-flow-live"><i aria-hidden="true"></i> Live</span></div><small>Last 5 min · app payload</small></header>
    <div data-data-flow-content>${renderContent(dataFlowSnapshot())}</div>
    <p>Web session only; Android runs separately. WebRTC carries files. Supabase carries coordination only.</p>
  </section>`;
}

export function bindDataFlowPanel(root = document) {
  const content = root.querySelector("[data-data-flow-content]");
  if (!content) return () => {};
  const update = (snapshot = dataFlowSnapshot()) => {
    if (!content.isConnected) return;
    content.innerHTML = renderContent(snapshot);
  };
  const unsubscribe = subscribeDataFlow(update);
  const timer = window.setInterval(() => update(), 10000);
  return () => { unsubscribe(); window.clearInterval(timer); };
}
