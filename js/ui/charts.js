const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
export function capacityChart(snapshots = [], options = {}) {
  const compact = options.compact === true;
  if (!snapshots.length) return `<div class="chart-empty${compact ? " chart-empty--compact" : ""}"><strong>History starts here</strong><span>The 24-hour view appears after live capacity snapshots are recorded.</span></div>`;
  const width = 680, height = compact ? 110 : 210, pad = compact ? 14 : 26;
  const values = snapshots.map((snapshot) => Math.max(0, Number(snapshot.verified_capacity_bytes || 0)));
  const max = Math.max(...values, 1);
  const coords = values.map((value, index) => ({
    x: pad + index * ((width - pad * 2) / Math.max(1, values.length - 1)),
    y: height - pad - value / max * (height - pad * 2),
  }));
  const points = coords.map(({ x, y }) => `${x},${y}`).join(" ");
  const singlePoint = coords.length === 1 ? `<circle cx="${coords[0].x}" cy="${coords[0].y}" r="4" fill="#35d9e6"/>` : "";
  return `<svg class="capacity-chart${compact ? " capacity-chart--compact" : ""}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="capacity-title capacity-desc"><title id="capacity-title">Reported live mesh capacity over 24 hours</title><desc id="capacity-desc">${values.length} real capacity snapshot${values.length === 1 ? "" : "s"} recorded.</desc><defs><linearGradient id="capacity-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#35d9e6" stop-opacity=".35"/><stop offset="1" stop-color="#35d9e6" stop-opacity="0"/></linearGradient></defs><polyline points="${points}" fill="none" stroke="#35d9e6" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><polygon points="${pad},${height-pad} ${points} ${width-pad},${height-pad}" fill="url(#capacity-fill)"/>${singlePoint}</svg>`;
}
export function meshChart(nodes = [], options = {}) {
  const connected = new Set(options.connectedNodeIds || []);
  const transferring = new Set(options.transferringNodeIds || []);
  const selectedNodeId = options.selectedNodeId || options.currentNode?.id;
  const width = 720, height = 390, cx = width / 2, cy = height / 2;
  const positions = nodes.slice(0, 12).map((node, i, arr) => ({ ...node, x: cx + Math.cos((i / arr.length) * Math.PI * 2) * 145, y: cy + Math.sin((i / arr.length) * Math.PI * 2) * 125 }));
  const lines = positions.map((node) => {
    const classes = ["mesh-link"];
    if (connected.has(node.id)) classes.push("is-connected");
    if (transferring.has(node.id)) classes.push("is-active");
    return `<line x1="${cx}" y1="${cy}" x2="${node.x}" y2="${node.y}" class="${classes.join(" ")}"/>`;
  }).join("");
  const dots = positions.map((node) => {
    const isConnected = connected.has(node.id);
    const selected = selectedNodeId === node.id;
    const label = esc(node.device_label || "Browser node").slice(0, 18);
    const connectionLabel = isConnected ? "Direct" : node.status === "online" ? "Visible" : esc(node.status || "Unknown");
    return `<g class="mesh-node-target${selected ? " is-selected" : ""}" role="button" tabindex="0" data-mesh-node="${esc(node.id)}" aria-label="Inspect ${label}, ${connectionLabel}"><title>${label}: ${connectionLabel}</title><circle cx="${node.x}" cy="${node.y}" r="27" class="mesh-node-hit"/><circle cx="${node.x}" cy="${node.y}" r="20" class="mesh-node mesh-node--${isConnected ? "connected" : esc(node.status || "unknown")}"/><text x="${node.x}" y="${node.y + 39}" text-anchor="middle">${label}</text><text x="${node.x}" y="${node.y + 53}" text-anchor="middle" class="mesh-node-state">${connectionLabel}</text></g>`;
  }).join("");
  const current = options.currentNode;
  const currentTarget = current?.id
    ? `<g class="mesh-node-target mesh-node-target--home${selectedNodeId === current.id ? " is-selected" : ""}" role="button" tabindex="0" data-mesh-node="${esc(current.id)}" aria-label="Inspect this browser"><title>This browser</title><circle cx="${cx}" cy="${cy}" r="42" class="mesh-node-hit"/><circle cx="${cx}" cy="${cy}" r="34" class="mesh-home"/><text x="${cx}" y="${cy+5}" text-anchor="middle" class="mesh-home-label">You</text></g>`
    : `<circle cx="${cx}" cy="${cy}" r="34" class="mesh-home"/><text x="${cx}" y="${cy+5}" text-anchor="middle" class="mesh-home-label">You</text>`;
  const empty = positions.length ? "" : `<text x="${cx}" y="${cy + 76}" text-anchor="middle" class="mesh-chart-empty">No other browser nodes reported recently</text>`;
  return `<svg class="mesh-chart" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="mesh-title mesh-desc"><title id="mesh-title">Live browser storage mesh</title><desc id="mesh-desc">${positions.length} other nodes are visible; ${positions.filter((node) => connected.has(node.id)).length} have an open WebRTC data channel.</desc>${lines}${currentTarget}${dots}${empty}</svg>`;
}
