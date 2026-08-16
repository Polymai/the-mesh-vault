import { loadCountryOutlines, countryCentroid } from "../geo/country-lookup.js";

const ACCENT = "#0c9eaa";
const HOLDS_COLOR = "#f5c451";
const CONTEXT_COLOR = "#76959d";
const PULSE_MS = 1400;
const GLOBE_MATERIAL_COLOR = 0xeaf5f6;
let savedView = null;
let session = null;

function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])); }
function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}
function hash(value) {
  let result = 2166136261;
  for (const character of String(value || "")) { result ^= character.charCodeAt(0); result = Math.imul(result, 16777619); }
  return result >>> 0;
}
function jitterFor(nodeId, spreadDeg) {
  const value = hash(nodeId);
  return { dLat: (((value % 1000) / 1000) - .5) * spreadDeg, dLng: ((((value >>> 10) % 1000) / 1000) - .5) * spreadDeg };
}

export function renderDataGlobe() {
  return `<div class="data-globe-wrap">
    <div class="data-globe" data-data-globe data-transfer-animation="real-shard-pulses-only" role="application" aria-label="3D globe of device-reported storage locations. Drag to orbit, scroll to zoom.">
      <div class="data-globe__hud"><span><i></i>Data locations</span><small data-data-globe-summary>Resolving device-reported locations…</small></div>
    </div>
  </div>`;
}

function createSession(container) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pulses = new Map();
  const pulseKey = (a, b) => [a, b].sort().join(":");
  const globe = window.Globe()(container)
    .backgroundColor("rgba(0,0,0,0)")
    .showAtmosphere(true).atmosphereColor(ACCENT).atmosphereAltitude(.2)
    .polygonAltitude(.004)
    .polygonCapColor(() => "rgba(255,255,255,0.12)")
    .polygonSideColor(() => "rgba(0,0,0,0)")
    .polygonStrokeColor(() => ACCENT)
    .polygonLabel((feature) => esc(feature?.properties?.name || ""))
    .pointAltitude((point) => point.kind === "current" ? .045 : point.kind === "holds" ? .028 : .012)
    .pointRadius((point) => point.radius)
    .pointColor((point) => point.color)
    .pointLabel((point) => `<div style="font:600 11px Manrope,sans-serif;color:#eaf8fb;background:rgba(4,16,26,.92);padding:.35rem .55rem;border-radius:8px;border:1px solid rgba(53,217,230,.35)">${esc(point.label)}</div>`)
    .onPointClick((point) => session?.onSelect?.(point.id))
    .arcColor((arc) => pulses.has(pulseKey(arc.source, arc.target))
      ? ["#07111f", "#07111f"]
      : arc.transferring
        ? ["rgba(8,127,141,1)", "rgba(8,127,141,.82)"]
        : arc.direct
          ? ["rgba(3,79,96,.96)", "rgba(3,79,96,.68)"]
          : ["rgba(25,100,88,.82)", "rgba(25,100,88,.54)"])
    .arcStroke((arc) => pulses.has(pulseKey(arc.source, arc.target)) ? 1.1 : arc.transferring ? .9 : arc.direct ? .76 : .48)
    .arcDashLength((arc) => pulses.has(pulseKey(arc.source, arc.target)) ? .12 : 1)
    .arcDashGap((arc) => pulses.has(pulseKey(arc.source, arc.target)) ? .88 : 0)
    .arcDashAnimateTime((arc) => pulses.has(pulseKey(arc.source, arc.target)) ? 650 : 0)
    .arcAltitude(.18);

  if (window.THREE) globe.globeMaterial(new window.THREE.MeshBasicMaterial({ color: GLOBE_MATERIAL_COLOR }));
  globe.pointOfView(savedView || { lat: 15, lng: 10, altitude: 2.5 }, 0);

  const controls = globe.controls?.();
  const onControlsStart = () => { controls.autoRotate = false; };
  const onControlsChange = () => { savedView = globe.pointOfView(); };
  if (controls) {
    controls.autoRotate = !reducedMotion;
    controls.autoRotateSpeed = .32;
    controls.enableDamping = true;
    controls.addEventListener("start", onControlsStart);
    controls.addEventListener("change", onControlsChange);
  }

  const resize = () => {
    const rect = container.getBoundingClientRect();
    globe.width(Math.max(1, rect.width)).height(Math.max(1, rect.height));
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const refreshArcs = () => {
    if (session?.globe !== globe) return;
    container.classList.toggle("has-live-transfer", pulses.size > 0);
    globe.arcsData([...(session.arcs || [])]);
  };
  const onPulse = (event) => {
    const { fromNodeId, toNodeId } = event.detail || {};
    if (!fromNodeId || !toNodeId) return;
    pulses.set(pulseKey(fromNodeId, toNodeId), performance.now());
    refreshArcs();
  };
  window.addEventListener("meshvault:shard-pulse", onPulse);
  const sweep = window.setInterval(() => {
    const now = performance.now();
    let changed = false;
    for (const [key, at] of pulses) {
      if (now - at <= PULSE_MS) continue;
      pulses.delete(key);
      changed = true;
    }
    if (changed) refreshArcs();
  }, 250);
  session = {
    container, globe, controls, observer, resize, onPulse, onControlsStart, onControlsChange,
    sweep, pulses, arcs: [], onSelect: () => {}, updateToken: 0,
  };
  resize();
  loadCountryOutlines().then((collection) => {
    if (session?.globe === globe) globe.polygonsData(collection.features);
  }).catch(() => {});
  return session;
}

async function updateSession(activeSession, { nodes, currentNodeId, edges, placementsByNode }) {
  const updateToken = ++activeSession.updateToken;
  const locatable = [];
  for (const node of nodes) {
    const centroid = node.country_code ? await countryCentroid(node.country_code) : null;
    if (centroid) locatable.push({ node, centroid });
  }
  if (session !== activeSession || updateToken !== activeSession.updateToken) return;
  const points = locatable.map(({ node, centroid }) => {
    const isCurrent = node.id === currentNodeId;
    const placement = placementsByNode.get(node.id);
    const kind = isCurrent ? "current" : placement ? "holds" : "context";
    const spread = kind === "context" ? 2.6 : 1.4;
    const { dLat, dLng } = jitterFor(node.id, spread);
    const magnitude = placement ? Math.log10(1 + (placement.bytes || placement.shardCount || 1)) : 0;
    const radius = kind === "current" ? .62 : kind === "holds" ? Math.min(1.1, .38 + magnitude * .16) : .22;
    const color = kind === "current" ? "#07111f" : kind === "holds" ? HOLDS_COLOR : CONTEXT_COLOR;
    const detail = placement ? `${placement.shardCount} verified shard${placement.shardCount === 1 ? "" : "s"} · ${formatBytes(placement.bytes)}` : isCurrent ? "This browser" : "Reported storage location";
    const place = [node.region_code, node.country_code].filter(Boolean).join(", ") || node.country_code || "Unknown";
    return { id: node.id, lat: centroid.lat + dLat, lng: centroid.lng + dLng, kind, radius, color, label: `${node.device_label || "Browser node"} — ${place}<br>${detail}` };
  });
  const pointById = new Map(points.map((point) => [point.id, point]));
  const arcs = [];
  const seen = new Set();
  edges.forEach((edge) => {
    const key = [edge.source, edge.target].sort().join(":");
    if (seen.has(key)) return;
    seen.add(key);
    const from = pointById.get(edge.source);
    const to = pointById.get(edge.target);
    if (!from || !to) return;
    arcs.push({ source: edge.source, target: edge.target, startLat: from.lat, startLng: from.lng, endLat: to.lat, endLng: to.lng, direct: edge.direct, transferring: edge.transferring });
  });
  activeSession.arcs = arcs;
  activeSession.globe.pointsData(points).arcsData(arcs);
  const summary = activeSession.container.querySelector("[data-data-globe-summary]");
  if (summary) summary.textContent = `${points.length} node${points.length === 1 ? "" : "s"} · ${arcs.length} live connection${arcs.length === 1 ? "" : "s"}`;
}

export function bindDataGlobe({ nodes = [], currentNodeId = null, edges = [], placementsByNode = new Map(), onSelect = () => {} } = {}) {
  const placeholder = document.querySelector("[data-data-globe]");
  if (!placeholder || typeof window.Globe !== "function") {
    const summary = document.querySelector("[data-data-globe-summary]");
    if (summary) summary.textContent = "This browser could not load the 3D globe renderer.";
    return () => {};
  }
  const activeSession = session || createSession(placeholder);
  if (activeSession.container !== placeholder) {
    placeholder.replaceWith(activeSession.container);
    activeSession.observer.observe(activeSession.container);
    requestAnimationFrame(activeSession.resize);
  }
  activeSession.onSelect = onSelect;
  updateSession(activeSession, { nodes, currentNodeId, edges, placementsByNode }).catch(() => {
    const summary = activeSession.container.querySelector("[data-data-globe-summary]");
    if (summary) summary.textContent = "Could not resolve device-reported locations.";
  });

  // The router rebuilds its markup when live topology changes. The WebGL
  // element is deliberately kept alive and reattached on the next bind, so
  // new nodes update the data without flashing or resetting the globe.
  return () => {};
}

export function destroyDataGlobe() {
  if (!session) return;
  savedView = session.globe.pointOfView?.() || savedView;
  window.removeEventListener("meshvault:shard-pulse", session.onPulse);
  window.clearInterval(session.sweep);
  session.observer.disconnect();
  session.controls?.removeEventListener?.("start", session.onControlsStart);
  session.controls?.removeEventListener?.("change", session.onControlsChange);
  session.globe._destructor?.();
  session = null;
}
