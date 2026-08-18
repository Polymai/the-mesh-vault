const fitIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg>';
const organiseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 12h4M11 12c3 0 3-6 6-6M11 12c3 0 3 6 6 6"/></svg>';
const SHARD_PULSE_MS = 920;
const recentShardPulses = new Map();
const pulseSubscribers = new Set();

function shardPulseKey(fromNodeId, toNodeId) {
  return [fromNodeId, toNodeId].sort().join(":");
}

if (typeof window !== "undefined") {
  window.addEventListener("meshvault:shard-pulse", (event) => {
    const { fromNodeId, toNodeId } = event.detail || {};
    if (!fromNodeId || !toNodeId) return;
    const now = performance.now();
    for (const [key, previous] of recentShardPulses) {
      if (now - previous.at > SHARD_PULSE_MS) recentShardPulses.delete(key);
    }
    const pulse = { fromNodeId, toNodeId, at: now };
    recentShardPulses.set(shardPulseKey(fromNodeId, toNodeId), pulse);
    pulseSubscribers.forEach((subscriber) => subscriber(pulse));
  });
}

const MODES = {
  radial: { label: "Radial", description: "Nodes arranged around one shared ring." },
  routes: { label: "Routes", description: "Observed connections arranged outward from this browser." },
  clusters: { label: "Clusters", description: "Nodes grouped by their role in this mesh." },
};

const GROUPS = {
  current: { label: "This browser", center: [500, 350] },
  anchor: { label: "Anchors", center: [260, 195] },
  files: { label: "Your file holders", center: [740, 195] },
  direct: { label: "Direct peers", center: [260, 510] },
  visible: { label: "Visible mesh", center: [740, 510] },
};

function neighborIds(edges, nodeId) {
  return new Set(edges.flatMap((edge) => edge.source === nodeId ? [edge.target] : edge.target === nodeId ? [edge.source] : []));
}

function roleFor(node, currentNodeId, directIds) {
  if (node.id === currentNodeId) return "current";
  if (node.is_anchor) return "anchor";
  if (node.has_my_files) return "files";
  if (directIds.has(node.id)) return "direct";
  return "visible";
}

function clusterPositions(nodes, currentNodeId, directIds) {
  const positions = new Map();
  const byRole = new Map(Object.keys(GROUPS).map((role) => [role, []]));
  nodes.forEach((node) => byRole.get(roleFor(node, currentNodeId, directIds)).push(node));
  for (const [role, groupNodes] of byRole) {
    const [cx, cy] = GROUPS[role].center;
    groupNodes.forEach((node, index) => {
      if (groupNodes.length === 1) {
        positions.set(node.id, { x: cx, y: cy });
        return;
      }
      const ring = Math.floor(index / 10);
      const ringStart = ring * 10;
      const ringCount = Math.min(10, groupNodes.length - ringStart);
      const angle = -Math.PI / 2 + ((index - ringStart) / Math.max(1, ringCount)) * Math.PI * 2;
      const radius = 52 + ring * 42;
      positions.set(node.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    });
  }
  return positions;
}

function routePositions(nodes, currentNodeId, edges, compact) {
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
  edges.forEach((edge) => {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  });
  const distance = new Map();
  const queue = currentNodeId ? [currentNodeId] : [];
  if (currentNodeId) distance.set(currentNodeId, 0);
  while (queue.length) {
    const nodeId = queue.shift();
    for (const neighbor of adjacency.get(nodeId) || []) {
      if (distance.has(neighbor)) continue;
      distance.set(neighbor, distance.get(nodeId) + 1);
      queue.push(neighbor);
    }
  }
  const connectedMax = Math.max(0, ...distance.values());
  nodes.forEach((node) => { if (!distance.has(node.id)) distance.set(node.id, connectedMax + 1); });
  const levels = new Map();
  nodes.forEach((node) => {
    const level = distance.get(node.id);
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(node);
  });
  const maxLevel = Math.max(1, ...levels.keys());
  const positions = new Map();
  for (const [level, levelNodes] of levels) {
    if (compact) {
      const center = { x: 180, y: 205 };
      if (level === 0) {
        levelNodes.forEach((node) => positions.set(node.id, center));
        continue;
      }
      const perArc = 8;
      const baseRadius = Math.min(225, 105 + (level - 1) * 68);
      levelNodes.forEach((node, index) => {
        const arc = Math.floor(index / perArc);
        const arcStart = arc * perArc;
        const arcCount = Math.min(perArc, levelNodes.length - arcStart);
        const offset = index - arcStart;
        const angle = arcCount === 1
          ? (level % 2 === 1 ? Math.PI * .34 : Math.PI * .66)
          : Math.PI * (.1 + (offset / Math.max(1, arcCount - 1)) * .8);
        const radius = baseRadius + arc * 42;
        positions.set(node.id, {
          x: center.x + Math.cos(angle) * radius,
          y: center.y + Math.sin(angle) * radius,
        });
      });
    } else {
      const x = 110 + (level / maxLevel) * 780;
      const rows = Math.min(14, levelNodes.length);
      levelNodes.forEach((node, index) => {
        const column = Math.floor(index / rows);
        const row = index % rows;
        const rowCount = Math.min(rows, levelNodes.length - column * rows);
        positions.set(node.id, {
          x: x + column * 42,
          y: 45 + ((row + 1) / (rowCount + 1)) * 610,
        });
      });
    }
  }
  return positions;
}

function graphElements(nodes, edges, selectedNodeId, currentNodeId, mode, compact) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const selectedNeighbors = neighborIds(edges, selectedNodeId);
  const directIds = neighborIds(edges, currentNodeId);
  const graphNodes = nodes.map((node, nodeIndex) => {
    const role = roleFor(node, currentNodeId, directIds);
    const classes = ["mesh-device", `role-${role}`];
    const labelThreshold = compact ? (mode === "routes" ? 3 : 9) : (mode === "routes" ? 14 : mode === "radial" ? 42 : 28);
    if (node.id === currentNodeId) classes.push("current", "labelled", "presence-phase-a");
    if (node.id === selectedNodeId) classes.push("selected", "labelled");
    if (selectedNeighbors.has(node.id)) classes.push("neighbor");
    if (directIds.has(node.id)) classes.push("direct-peer", nodeIndex % 2 === 0 ? "presence-phase-a" : "presence-phase-b");
    if (node.is_anchor) classes.push("anchor");
    if (node.has_my_files) classes.push("has-files");
    if (node.is_ambient) classes.push("ambient");
    if (node.status !== "online") classes.push("offline");
    if (nodes.length <= labelThreshold) classes.push("labelled");
    return {
      group: "nodes",
      data: {
        id: node.id,
        label: node.id === currentNodeId ? "You" : String(node.device_label || "Browser node").slice(0, 24),
        role,
        ...(mode === "clusters" ? { parent: `mesh-group-${role}` } : {}),
      },
      classes: classes.join(" "),
    };
  });
  const parentNodes = mode === "clusters"
    ? Object.entries(GROUPS).filter(([role]) => graphNodes.some((node) => node.data.role === role)).map(([role, group]) => ({
      group: "nodes",
      data: { id: `mesh-group-${role}`, label: group.label, role },
      classes: `cluster-parent cluster-${role}`,
    }))
    : [];
  const seen = new Set();
  const graphEdges = edges.flatMap((edge, index) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) return [];
    const key = [edge.source, edge.target].sort().join(":");
    if (seen.has(key)) return [];
    seen.add(key);
    const classes = [];
    if (edge.direct) classes.push("direct");
    if (edge.transferring) classes.push("transferring");
    if (edge.source === selectedNodeId || edge.target === selectedNodeId) classes.push("focused");
    return [{
      group: "edges",
      data: {
        id: `connection-${index}-${key}`,
        source: edge.source,
        target: edge.target,
        curveOffset: (index % 2 === 0 ? 1 : -1) * ((compact ? 24 : 40) + (index % 4) * (compact ? 6 : 9)),
      },
      classes: classes.join(" "),
    }];
  });
  return [...parentNodes, ...graphNodes, ...graphEdges];
}

function graphStyle(compact = false, mode = "radial") {
  const size = compact
    ? { node: 9.5, neighbor: 10.5, current: 14, selected: 15, font: 7.6, edge: .95, direct: 1.4, focused: 1.85 }
    : { node: 10, neighbor: 11, current: 15, selected: 16, font: 8.7, edge: .85, direct: 1.45, focused: 1.9 };
  return [
    {
      selector: "node.mesh-device",
      style: {
        width: size.node,
        height: size.node,
        "background-color": "#d8f6f0",
        "border-color": "#159fab",
        "border-width": compact ? 1 : 1.2,
        label: "data(label)",
        color: "#17313c",
        "font-family": "Manrope, sans-serif",
        "font-size": size.font,
        "font-weight": 650,
        "text-valign": "bottom",
        "text-margin-y": compact ? 5 : 6,
        "text-wrap": "ellipsis",
        "text-max-width": compact ? 62 : 92,
        "text-opacity": 0,
        "text-background-opacity": 0,
        "text-outline-color": compact ? "#e5f1f3" : "#eef6f7",
        "text-outline-width": compact ? .65 : .45,
        "min-zoomed-font-size": compact ? 7 : 8,
        "transition-property": "underlay-opacity, underlay-padding, border-width",
        "transition-duration": "1100ms",
        "transition-timing-function": "ease-in-out",
      },
    },
    { selector: "node.mesh-device.labelled, node.mesh-device.peek", style: { "text-opacity": 1 } },
    { selector: "node.mesh-device.neighbor", style: { width: size.neighbor, height: size.neighbor } },
    { selector: "node.mesh-device.role-direct", style: { "background-color": "#bff4e8", "border-color": "#159fab" } },
    { selector: "node.mesh-device.role-visible", style: { "background-color": "#dcebed", "border-color": "#6f959e" } },
    { selector: "node.mesh-device.role-files", style: { "background-color": "#fff3c9", "border-color": "#d19a0c" } },
    { selector: "node.mesh-device.current", style: { width: size.current, height: size.current, "background-color": "#07111f", "border-color": "#35d9e6", "border-width": compact ? 1.8 : 2.3, color: "#07111f", "underlay-color": "#35d9e6", "underlay-opacity": .07, "underlay-padding": compact ? 4 : 5 } },
    { selector: "node.mesh-device.direct-peer", style: { "underlay-color": "#43d9bd", "underlay-opacity": .025, "underlay-padding": compact ? 2 : 3 } },
    { selector: "node.mesh-device.direct-peer.anchor", style: { "underlay-color": "#9585ff" } },
    { selector: "node.mesh-device.anchor", style: { shape: "diamond", "background-color": "#9585ff", "border-color": "#6654c6", "border-width": compact ? 1.1 : 1.5 } },
    { selector: "node.mesh-device.current.anchor", style: { shape: "diamond", "background-color": "#07111f", "border-color": "#9585ff", "border-width": compact ? 2 : 2.4 } },
    { selector: "node.mesh-device.has-files", style: { "border-color": "#e1a91d", "border-width": compact ? 1.8 : 2.2 } },
    { selector: "node.mesh-device.selected", style: { width: size.selected, height: size.selected, "border-color": "#17313c", "border-width": compact ? 2 : 2.4 } },
    { selector: "node.mesh-device.current.presence-pulse", style: { "underlay-opacity": .22, "underlay-padding": compact ? 10 : 12, "border-width": compact ? 2.2 : 2.8 } },
    { selector: "node.mesh-device.direct-peer.presence-pulse", style: { "underlay-opacity": .11, "underlay-padding": compact ? 6 : 8 } },
    { selector: "node.mesh-device.ambient", style: { opacity: compact ? .65 : .5 } },
    { selector: "node.mesh-device.offline", style: { opacity: compact ? .42 : .32 } },
    {
      selector: "node.cluster-parent",
      style: {
        shape: "round-rectangle",
        label: "data(label)",
        "font-family": "Manrope, sans-serif",
        "font-size": compact ? 7 : 9,
        "font-weight": 750,
        color: "#55717b",
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": compact ? -5 : -7,
        "background-color": "#dfeff1",
        "background-opacity": .24,
        "border-color": "#b9d3d8",
        "border-width": 1,
        "border-style": "dashed",
        padding: compact ? 10 : 16,
        "compound-sizing-wrt-labels": "exclude",
        events: "no",
      },
    },
    { selector: "node.cluster-anchor", style: { "background-color": "#eeeaff", "border-color": "#b9afff", color: "#6554ba" } },
    { selector: "node.cluster-files", style: { "background-color": "#fff7df", "border-color": "#e3bf53", color: "#8b6810" } },
    { selector: "node.cluster-direct", style: { "background-color": "#ddf8f3", "border-color": "#81d9c9", color: "#087666" } },
    {
      selector: "edge",
      style: {
        width: size.edge,
        "line-color": compact ? "#82adb5" : "#aacbd1",
        opacity: mode === "radial" ? (compact ? .62 : .44) : (compact ? .68 : .56),
        "curve-style": mode === "routes" ? "unbundled-bezier" : mode === "radial" ? "straight" : "bezier",
        ...(mode === "routes" ? {
          "control-point-distances": "data(curveOffset)",
          "control-point-weights": .5,
        } : {}),
      },
    },
    { selector: "edge.direct", style: { width: size.direct, "line-color": "#159fab", opacity: .88 } },
    { selector: "edge.focused", style: { width: size.focused, "line-color": "#35d9e6", opacity: 1 } },
    {
      selector: "edge.transferring",
      style: {
        width: compact ? 2.1 : 2.6,
        "line-color": "#43d9bd",
        "target-arrow-color": "#43d9bd",
        "target-arrow-shape": "triangle",
        "arrow-scale": .65,
        opacity: 1,
      },
    },
    {
      selector: "edge.shard-pulse",
      style: {
        width: compact ? 2.5 : 3,
        "line-color": "#087f8d",
        "target-arrow-color": "#087f8d",
        "target-arrow-shape": "triangle",
        "arrow-scale": .72,
        opacity: 1,
      },
    },
  ];
}

function viewLayout(graph, mode, currentNodeId, nodes, compact, animate) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shared = {
    fit: true,
    padding: compact ? 28 : 48,
    avoidOverlap: true,
    nodeDimensionsIncludeLabels: false,
    animate: animate && nodes.length <= 80 && !reducedMotion ? "end" : false,
    animationDuration: 320,
  };
  if (mode === "routes") {
    const edgeRows = graph.edges().map((edge) => ({ source: edge.source().id(), target: edge.target().id() }));
    const positions = routePositions(nodes, currentNodeId, edgeRows, compact);
    return graph.layout({
      ...shared,
      name: "preset",
      positions: (node) => positions.get(node.id()) || { x: 500, y: 350 },
    });
  }
  if (mode === "clusters") {
    const directIds = neighborIds(graph.edges().map((edge) => ({ source: edge.source().id(), target: edge.target().id() })), currentNodeId);
    const positions = clusterPositions(nodes, currentNodeId, directIds);
    return graph.layout({
      ...shared,
      name: "preset",
      positions: (node) => positions.get(node.id()) || { x: 500, y: 350 },
    });
  }
  return graph.layout({
    ...shared,
    name: "circle",
    startAngle: -Math.PI / 2,
    clockwise: true,
    spacingFactor: compact ? 1.08 : 1.2,
  });
}

export function renderMeshConnections(nodes = [], edges = [], { mode = "radial" } = {}) {
  const view = MODES[mode] || MODES.radial;
  if (!nodes.length) return `<div class="mesh-connections mesh-connections--empty"><strong>No nodes yet</strong></div>`;
  return `<div class="mesh-connections mesh-connections--${mode}" data-mesh-connections data-mesh-graph-mode="${mode}" data-route-layout="${mode === "routes" ? "adaptive-arcs" : "not-applicable"}" data-label-style="plain" data-link-geometry="${mode === "routes" ? "curved" : mode}" data-transfer-animation="real-shard-pulses-only" aria-busy="true">
    <div class="mesh-connections__canvas" data-mesh-connections-canvas role="application" aria-label="${view.label} Live Mesh view. Pan and zoom, then select a node."></div>
    <div class="mesh-connections__transfer-layer" data-mesh-transfer-layer aria-hidden="true"></div>
    <div class="mesh-connections__controls" aria-label="${view.label} view controls">
      <button type="button" data-connections-organise aria-label="Arrange ${view.label.toLowerCase()} view" title="Arrange nodes">${organiseIcon}<span>Arrange</span></button>
      <button type="button" data-connections-fit aria-label="Fit all nodes" title="Fit all nodes">${fitIcon}<span>Fit</span></button>
    </div>
    <div class="mesh-connections__mode"><strong>${view.label}</strong><span>${view.description}</span></div>
    <div class="mesh-connections__legend" aria-label="Node role legend"><span><i class="is-anchor"></i>Anchor</span><span><i class="has-files"></i>Your files</span><span><i class="is-direct"></i>Direct</span></div>
    <div class="mesh-connections__loading" role="status">Arranging ${nodes.length} node${nodes.length === 1 ? "" : "s"}&hellip;</div>
    <span class="visually-hidden" aria-live="polite" data-connections-status>${nodes.length} nodes and ${edges.length} observed connections.</span>
  </div>`;
}

export function bindMeshConnections({ nodes = [], edges = [], selectedNodeId, currentNodeId, mode = "radial", onSelect } = {}) {
  const root = document.querySelector("[data-mesh-connections]");
  const container = root?.querySelector("[data-mesh-connections-canvas]");
  if (!root || !container) return () => {};

  let destroyed = false;
  let graph = null;
  let resizeObserver = null;
  let presenceTimer = null;
  const animationFrames = new Set();
  const pulseTimers = new Set();
  const edgePulseUntil = new Map();
  const compact = matchMedia("(max-width: 650px)").matches;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const focusId = selectedNodeId || currentNodeId || nodes[0]?.id;
  const fitPadding = compact ? 28 : 48;
  const initialZoomCap = compact ? 1.7 : 2;
  const transferLayer = root.querySelector("[data-mesh-transfer-layer]");

  const requestFrame = (callback) => {
    const id = requestAnimationFrame((time) => {
      animationFrames.delete(id);
      callback(time);
    });
    animationFrames.add(id);
  };
  const matchingEdge = (fromNodeId, toNodeId) => graph?.edges().filter((edge) => {
    const source = edge.source().id();
    const target = edge.target().id();
    return (source === fromNodeId && target === toNodeId) || (source === toNodeId && target === fromNodeId);
  }).first();
  const showShardPulse = (fromNodeId, toNodeId, pulseStartedAt = performance.now()) => {
    if (!graph || !transferLayer || destroyed) return;
    const from = graph.getElementById(fromNodeId);
    const to = graph.getElementById(toNodeId);
    if (!from.length || !to.length) return;

    const duration = reducedMotion ? 700 : 920;
    const startedAt = pulseStartedAt;
    const remaining = duration - (performance.now() - startedAt);
    if (remaining <= 0) return;
    const edge = matchingEdge(fromNodeId, toNodeId);
    if (edge?.length) {
      const pulseUntil = startedAt + duration;
      edgePulseUntil.set(edge.id(), pulseUntil);
      edge.addClass("shard-pulse");
      const timer = window.setTimeout(() => {
        pulseTimers.delete(timer);
        if ((edgePulseUntil.get(edge.id()) || 0) > performance.now()) return;
        edgePulseUntil.delete(edge.id());
        if (!destroyed) edge.removeClass("shard-pulse");
      }, remaining + 40);
      pulseTimers.add(timer);
    }

    const particle = document.createElement("i");
    particle.className = "mesh-transfer-particle";
    particle.dataset.progress = "0";
    transferLayer.append(particle);
    root.classList.add("has-live-transfer");

    const drawParticle = (now) => {
      if (destroyed || !particle.isConnected || !graph) {
        particle.remove();
        return;
      }
      const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
      const fromPoint = from.renderedPosition();
      const toPoint = to.renderedPosition();
      const rootRect = root.getBoundingClientRect();
      const canvasRect = container.getBoundingClientRect();
      const localX = canvasRect.left - rootRect.left;
      const localY = canvasRect.top - rootRect.top;
      const visualProgress = reducedMotion ? .5 : progress;
      const x = localX + fromPoint.x + (toPoint.x - fromPoint.x) * visualProgress;
      const y = localY + fromPoint.y + (toPoint.y - fromPoint.y) * visualProgress;
      particle.dataset.progress = progress.toFixed(3);
      particle.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      particle.style.opacity = String(Math.sin(Math.min(1, progress) * Math.PI));
      if (progress < 1) {
        requestFrame(drawParticle);
        return;
      }
      particle.remove();
      if (!transferLayer.childElementCount) root.classList.remove("has-live-transfer");
    };
    requestFrame(drawParticle);
  };
  const onShardPulse = ({ fromNodeId, toNodeId, at }) => {
    showShardPulse(fromNodeId, toNodeId, at);
  };
  pulseSubscribers.add(onShardPulse);

  const setReady = () => {
    if (!root.isConnected) return;
    root.setAttribute("aria-busy", "false");
    root.querySelector(".mesh-connections__loading")?.setAttribute("hidden", "");
  };
  const fitGraph = () => {
    if (!graph || destroyed) return;
    graph.fit(graph.elements(), fitPadding);
    if (graph.zoom() > initialZoomCap) {
      graph.zoom(initialZoomCap);
      graph.center(graph.elements());
    }
  };
  const runLayout = (animate = false) => {
    if (!graph || destroyed) return;
    const layout = viewLayout(graph, mode, currentNodeId || focusId, nodes, compact, animate);
    graph.one("layoutstop", () => {
      if (destroyed) return;
      fitGraph();
      setReady();
    });
    layout.run();
  };

  import("../vendor/cytoscape.esm.min.js").then(({ default: cytoscape }) => {
    if (destroyed || !root.isConnected) return;
    graph = cytoscape({
      container,
      elements: graphElements(nodes, edges, selectedNodeId, currentNodeId, mode, compact),
      style: graphStyle(compact, mode),
      layout: { name: "preset" },
      minZoom: 0.16,
      maxZoom: 4,
      boxSelectionEnabled: false,
      selectionType: "single",
      autoungrabify: true,
      wheelSensitivity: .85,
      hideEdgesOnViewport: nodes.length > 120,
      pixelRatio: nodes.length > 100 ? 1 : "auto",
    });
    graph.on("tap", "node.mesh-device", (event) => onSelect?.(event.target.id()));
    graph.on("mouseover", "node.mesh-device", (event) => event.target.addClass("peek"));
    graph.on("mouseout", "node.mesh-device", (event) => event.target.removeClass("peek"));
    root.querySelector("[data-connections-fit]")?.addEventListener("click", fitGraph);
    root.querySelector("[data-connections-organise]")?.addEventListener("click", () => runLayout(true));
    resizeObserver = new ResizeObserver(() => {
      graph?.resize();
      fitGraph();
    });
    resizeObserver.observe(container);
    runLayout(false);
    if (reducedMotion) {
      root.dataset.presenceAnimation = "static-halos";
    } else {
      root.dataset.presenceAnimation = "breathing-halos";
      let phase = false;
      const animatePresence = () => {
        if (!graph || destroyed) return;
        phase = !phase;
        graph.nodes(".current, .presence-phase-a").toggleClass("presence-pulse", phase);
        graph.nodes(".presence-phase-b").toggleClass("presence-pulse", !phase);
        root.dataset.presencePulseTargets = String(graph.nodes(".presence-pulse").length);
      };
      animatePresence();
      presenceTimer = window.setInterval(animatePresence, 1500);
    }
    requestAnimationFrame(() => {
      const now = performance.now();
      for (const pulse of recentShardPulses.values()) {
        if (now - pulse.at > SHARD_PULSE_MS) {
          recentShardPulses.delete(shardPulseKey(pulse.fromNodeId, pulse.toNodeId));
          continue;
        }
        onShardPulse(pulse);
      }
    });
  }).catch(() => {
    if (destroyed || !root.isConnected) return;
    root.setAttribute("aria-busy", "false");
    root.classList.add("is-error");
    const loading = root.querySelector(".mesh-connections__loading");
    if (loading) loading.textContent = "Graph view unavailable";
  });

  return () => {
    destroyed = true;
    pulseSubscribers.delete(onShardPulse);
    animationFrames.forEach((id) => cancelAnimationFrame(id));
    animationFrames.clear();
    pulseTimers.forEach((timer) => window.clearTimeout(timer));
    pulseTimers.clear();
    if (presenceTimer) window.clearInterval(presenceTimer);
    transferLayer?.replaceChildren();
    resizeObserver?.disconnect();
    graph?.destroy();
    graph = null;
  };
}
