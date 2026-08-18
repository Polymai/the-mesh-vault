const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
export function capacityChart(snapshots = [], options = {}) {
  const compact = options.compact === true;
  if (!snapshots.length) return `<div class="chart-empty${compact ? " chart-empty--compact" : ""}"><strong>No history yet</strong></div>`;
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
  const current = options.currentNode;
  const anchorIds = new Set(options.anchorNodeIds || []);
  const compact = options.compact === true;
  const scope = options.scope || "local";
  const width = compact ? 360 : 900, height = compact ? 600 : 560, cx = width / 2, cy = height / 2;
  const innerRadiusX = compact ? 95 : 230, innerRadiusY = compact ? 185 : 150;
  const outerRadiusX = compact ? 150 : 380, outerRadiusY = compact ? 270 : 240;
  const nodeLimit = scope === "overview" ? 240 : scope === "sample" ? 80 : 32;
  const visible = nodes.filter((node) => node.id !== current?.id).slice(0, nodeLimit);
  const dense = scope !== "local" || visible.length > 24;
  const nodeRadius = dense ? (compact ? 3 : 4) : compact ? 8 : 12;
  const nodeHitRadius = dense ? (compact ? 8 : 10) : compact ? 23 : 30;
  const anchorHalf = dense ? (compact ? 3 : 4) : compact ? 7 : 10;
  const fileRingRadius = dense ? (compact ? 6 : 7) : compact ? 13 : 18;
  const homeRadius = compact ? 17 : 24, homeHitRadius = compact ? 33 : 42;
  const homeFileRingRadius = compact ? 24 : 32, homeAnchorHalf = compact ? 14 : 19;
  const positions = visible.map((node, index) => {
    if (dense) {
      const radius = Math.sqrt((index + 1) / Math.max(1, visible.length));
      const angle = index * Math.PI * (3 - Math.sqrt(5)) - Math.PI / 2;
      return { ...node, x: cx + Math.cos(angle) * outerRadiusX * .94 * radius, y: cy + Math.sin(angle) * outerRadiusY * .94 * radius };
    }
    const outer = visible.length > 9 && index >= 7;
    const ringIndex = outer ? index - 7 : index;
    const ringCount = outer ? visible.length - 7 : Math.min(7, visible.length);
    const radiusX = outer ? outerRadiusX : innerRadiusX;
    const radiusY = outer ? outerRadiusY : innerRadiusY;
    const angle = -Math.PI / 2 + (ringIndex / Math.max(1, ringCount)) * Math.PI * 2;
    return { ...node, x: cx + Math.cos(angle) * radiusX, y: cy + Math.sin(angle) * radiusY };
  });
  const pointById = new Map(positions.map((node) => [node.id, node]));
  if (current?.id) pointById.set(current.id, { ...current, x: cx, y: cy });
  const edges = options.edges?.length
    ? options.edges
    : positions.map((node) => ({ source: current?.id, target: node.id, direct: connected.has(node.id) }));
  const lines = edges.map((edge) => {
    const from = pointById.get(edge.source), to = pointById.get(edge.target);
    if (!from || !to) return "";
    const classes = ["mesh-link"];
    if (edge.direct || connected.has(edge.source) || connected.has(edge.target)) classes.push("is-connected");
    if (edge.transferring || transferring.has(edge.source) || transferring.has(edge.target)) classes.push("is-active");
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="${classes.join(" ")}"/>`;
  }).join("");
  const dots = positions.map((node) => {
    const isConnected = connected.has(node.id);
    const selected = selectedNodeId === node.id;
    const label = esc(node.device_label || "Browser node").slice(0, 18);
    const isAnchor = anchorIds.has(node.id);
    const connectionLabel = isAnchor ? "Anchor" : isConnected ? "Direct" : node.status === "online" ? "Visible" : esc(node.status || "Unknown");
    const shape = isAnchor
      ? `<rect x="${node.x - anchorHalf}" y="${node.y - anchorHalf}" width="${anchorHalf * 2}" height="${anchorHalf * 2}" rx="${compact ? 3 : 5}" class="mesh-node mesh-node--anchor" transform="rotate(45 ${node.x} ${node.y})"/>`
      : `<circle cx="${node.x}" cy="${node.y}" r="${nodeRadius}" class="mesh-node mesh-node--${isConnected ? "connected" : esc(node.status || "unknown")}"/>`;
    const fileRing = node.has_my_files ? `<circle cx="${node.x}" cy="${node.y}" r="${fileRingRadius}" class="mesh-node-file-ring"/>` : "";
    const labelOffset = compact ? 20 : 28, stateOffset = compact ? 30 : 40;
    const labels = !dense || selected || isConnected
      ? `<text x="${node.x}" y="${node.y + labelOffset}" text-anchor="middle">${label}</text><text x="${node.x}" y="${node.y + stateOffset}" text-anchor="middle" class="mesh-node-state">${connectionLabel}</text>`
      : "";
    return `<g class="mesh-node-target${selected ? " is-selected" : ""}${isAnchor ? " is-anchor" : ""}${dense ? " is-dense" : ""}" role="button" tabindex="${dense && !selected ? "-1" : "0"}" data-mesh-node="${esc(node.id)}" aria-label="Inspect ${label}, ${connectionLabel}"><title>${label}: ${connectionLabel}</title><circle cx="${node.x}" cy="${node.y}" r="${nodeHitRadius}" class="mesh-node-hit"/>${fileRing}${shape}${labels}</g>`;
  }).join("");
  const currentIsAnchor = anchorIds.has(current?.id);
  const currentTarget = current?.id
    ? `<g class="mesh-node-target mesh-node-target--home${selectedNodeId === current.id ? " is-selected" : ""}${currentIsAnchor ? " is-anchor" : ""}" role="button" tabindex="0" data-mesh-node="${esc(current.id)}" aria-label="Inspect this browser"><title>This browser</title><circle cx="${cx}" cy="${cy}" r="${homeHitRadius}" class="mesh-node-hit"/>${current?.has_my_files ? `<circle cx="${cx}" cy="${cy}" r="${homeFileRingRadius}" class="mesh-node-file-ring"/>` : ""}<circle cx="${cx}" cy="${cy}" r="${homeRadius}" class="mesh-home"/>${currentIsAnchor ? `<rect x="${cx - homeAnchorHalf}" y="${cy - homeAnchorHalf}" width="${homeAnchorHalf * 2}" height="${homeAnchorHalf * 2}" rx="${compact ? 5 : 7}" class="mesh-home-anchor" transform="rotate(45 ${cx} ${cy})"/>` : ""}<text x="${cx}" y="${cy+4}" text-anchor="middle" class="mesh-home-label">You</text>${currentIsAnchor ? `<text x="${cx}" y="${cy + (compact ? 34 : 43)}" text-anchor="middle" class="mesh-node-state mesh-node-state--anchor">Anchor</text>` : ""}</g>`
    : `<circle cx="${cx}" cy="${cy}" r="${compact ? 17 : 24}" class="mesh-home"/><text x="${cx}" y="${cy+4}" text-anchor="middle" class="mesh-home-label">You</text>`;
  const empty = positions.length ? "" : `<text x="${cx}" y="${cy + 70}" text-anchor="middle" class="mesh-chart-empty">No peers yet</text>`;
  return `<div class="mesh-map"><svg class="mesh-chart mesh-chart--map" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="mesh-title mesh-desc"><title id="mesh-title">Live browser storage mesh</title><desc id="mesh-desc">${positions.length} other nodes are visible; ${positions.filter((node) => connected.has(node.id)).length} have an open WebRTC data channel.</desc><defs><radialGradient id="mesh-map-bg"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#e8f3f5"/></radialGradient></defs><rect width="${width}" height="${height}" fill="url(#mesh-map-bg)"/><g class="mesh-map-grid"><ellipse cx="${cx}" cy="${cy}" rx="${innerRadiusX}" ry="${innerRadiusY}"/><ellipse cx="${cx}" cy="${cy}" rx="${outerRadiusX}" ry="${outerRadiusY}"/></g>${lines}${currentTarget}${dots}${empty}</svg><div class="mesh-map__legend"><span><i class="is-anchor"></i>Anchor</span><span><i class="has-files"></i>Your files</span></div></div>`;
}
