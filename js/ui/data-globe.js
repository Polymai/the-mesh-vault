import { loadCountryOutlines, countryCentroid } from "../geo/country-lookup.js";

const ACCENT = "#35d9e6";
const HOLDS_COLOR = "#f5c451";
const CONTEXT_COLOR = "#5b7480";
const PULSE_MS = 1400;
const GLOBE_MATERIAL_COLOR = 0x04101a;

// Camera angle is kept at module scope, not component state, because the
// whole view is torn down and rebuilt (innerHTML) on every app rerender -
// without this the globe would snap back to its default angle every time a
// gossip/topology event triggers a rerender while this tab is open.
let savedView = null;

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
  let h = 2166136261;
  for (const character of String(value || "")) { h ^= character.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Deterministic (not random) offset so nodes sharing a country each get a
// stable, distinct position instead of stacking on the exact same centroid.
function jitterFor(nodeId, spreadDeg) {
  const h = hash(nodeId);
  return { dLat: (((h % 1000) / 1000) - .5) * spreadDeg, dLng: ((((h >>> 10) % 1000) / 1000) - .5) * spreadDeg };
}

export function renderDataGlobe() {
  return `<div class="data-globe-wrap">
    <div class="data-globe" data-data-globe role="application" aria-label="3D globe of device-reported storage locations. Drag to orbit, scroll to zoom.">
      <div class="data-globe__hud"><span><i></i>Data locations</span><small data-data-globe-summary>Resolving device-reported locations…</small></div>
    </div>
    <p class="data-globe__caption">Markers show <strong>device-reported storage locations</strong> - a coarse country, from this browser's own location permission or a network hint - never an exact physical position. Lines are drawn only for real, currently observed peer connections.</p>
    <div class="data-globe__unavailable" data-data-globe-unavailable hidden><h3>Location unavailable</h3><p>These nodes are known to the mesh but have not reported a resolvable location, so they are intentionally left off the globe rather than placed anywhere.</p><ul data-data-globe-unavailable-list></ul></div>
  </div>`;
}

export function bindDataGlobe({ nodes = [], currentNodeId = null, edges = [], placementsByNode = new Map(), onSelect = () => {} } = {}) {
  const container = document.querySelector("[data-data-globe]");
  const summaryEl = document.querySelector("[data-data-globe-summary]");
  const unavailableWrap = document.querySelector("[data-data-globe-unavailable]");
  const unavailableList = document.querySelector("[data-data-globe-unavailable-list]");
  if (!container || typeof window.Globe !== "function") {
    if (summaryEl) summaryEl.textContent = "This browser could not load the 3D globe renderer.";
    return () => {};
  }
  let disposed = false;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pulses = new Map();
  const pulseKey = (a, b) => [a, b].sort().join(":");
  const onPulse = (event) => {
    const { fromNodeId, toNodeId } = event.detail || {};
    if (!fromNodeId || !toNodeId) return;
    pulses.set(pulseKey(fromNodeId, toNodeId), performance.now());
  };
  window.addEventListener("meshvault:shard-pulse", onPulse);
  const sweep = window.setInterval(() => { const now = performance.now(); for (const [key, at] of pulses) if (now - at > PULSE_MS) pulses.delete(key); }, 1000);

  const globe = window.Globe()(container)
    .backgroundColor("rgba(0,0,0,0)")
    .showAtmosphere(true).atmosphereColor(ACCENT).atmosphereAltitude(.2)
    .polygonAltitude(.004)
    .polygonCapColor(() => "rgba(4,16,26,0.001)")
    .polygonSideColor(() => "rgba(0,0,0,0)")
    .polygonStrokeColor(() => ACCENT)
    .polygonLabel((feature) => esc(feature?.properties?.name || ""))
    .pointAltitude((point) => point.kind === "current" ? .045 : point.kind === "holds" ? .028 : .012)
    .pointRadius((point) => point.radius)
    .pointColor((point) => point.color)
    .pointLabel((point) => `<div style="font:600 11px Manrope,sans-serif;color:#eaf8fb;background:rgba(4,16,26,.92);padding:.35rem .55rem;border-radius:8px;border:1px solid rgba(53,217,230,.35)">${esc(point.label)}</div>`)
    .onPointClick((point) => onSelect(point.id))
    .arcColor((arc) => pulses.has(pulseKey(arc.source, arc.target)) ? ["#ffffff", "#ffffff"] : arc.direct ? ["rgba(53,217,230,.75)", "rgba(53,217,230,.15)"] : ["rgba(67,217,189,.5)", "rgba(67,217,189,.1)"])
    .arcStroke((arc) => pulses.has(pulseKey(arc.source, arc.target)) ? 1.1 : arc.direct ? .6 : .35)
    .arcDashLength(.4).arcDashGap(.22)
    .arcDashAnimateTime((arc) => pulses.has(pulseKey(arc.source, arc.target)) ? 650 : arc.direct ? 2600 : 4200)
    .arcAltitude(.18);

  if (window.THREE) globe.globeMaterial(new window.THREE.MeshBasicMaterial({ color: GLOBE_MATERIAL_COLOR }));
  globe.pointOfView(savedView || { lat: 15, lng: 10, altitude: 2.5 }, 0);

  const controls = globe.controls?.();
  if (controls) {
    controls.autoRotate = !reducedMotion; controls.autoRotateSpeed = .32; controls.enableDamping = true;
    controls.addEventListener("start", () => { controls.autoRotate = false; });
    controls.addEventListener("change", () => { savedView = globe.pointOfView(); });
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    globe.width(Math.max(1, rect.width)).height(Math.max(1, rect.height));
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  loadCountryOutlines().then((collection) => { if (!disposed) globe.polygonsData(collection.features); }).catch(() => {});

  const locatable = []; const unavailable = [];
  (async () => {
    for (const node of nodes) {
      const centroid = node.country_code ? await countryCentroid(node.country_code) : null;
      if (centroid) locatable.push({ node, centroid }); else unavailable.push(node);
    }
    if (disposed) return;
    const points = locatable.map(({ node, centroid }) => {
      const isCurrent = node.id === currentNodeId;
      const placement = placementsByNode.get(node.id);
      const kind = isCurrent ? "current" : placement ? "holds" : "context";
      const spread = kind === "context" ? 2.6 : 1.4;
      const { dLat, dLng } = jitterFor(node.id, spread);
      const magnitude = placement ? Math.log10(1 + (placement.bytes || placement.shardCount || 1)) : 0;
      const radius = kind === "current" ? .62 : kind === "holds" ? Math.min(1.1, .38 + magnitude * .16) : .22;
      const color = kind === "current" ? "#d8fdff" : kind === "holds" ? HOLDS_COLOR : CONTEXT_COLOR;
      const detail = placement ? `${placement.shardCount} verified shard${placement.shardCount === 1 ? "" : "s"} · ${formatBytes(placement.bytes)}` : isCurrent ? "This browser" : "Reported storage location";
      const place = [node.region_code, node.country_code].filter(Boolean).join(", ") || node.country_code || "Unknown";
      return { id: node.id, lat: centroid.lat + dLat, lng: centroid.lng + dLng, kind, radius, color, label: `${node.device_label || "Browser node"} — ${place}<br>${detail}` };
    });
    const pointById = new Map(points.map((point) => [point.id, point]));
    const arcs = [];
    const seen = new Set();
    edges.forEach((edge) => {
      const key = [edge.source, edge.target].sort().join(":");
      if (seen.has(key)) return; seen.add(key);
      const from = pointById.get(edge.source), to = pointById.get(edge.target);
      if (!from || !to) return;
      arcs.push({ source: edge.source, target: edge.target, startLat: from.lat, startLng: from.lng, endLat: to.lat, endLng: to.lng, direct: edge.direct });
    });
    globe.pointsData(points).arcsData(arcs);
    if (summaryEl) summaryEl.textContent = `${points.length} node${points.length === 1 ? "" : "s"} placed by reported country · ${arcs.length} live connection${arcs.length === 1 ? "" : "s"} drawn`;
    if (unavailableWrap) unavailableWrap.hidden = unavailable.length === 0;
    if (unavailableList) unavailableList.innerHTML = unavailable.map((node) => `<li>${esc(node.device_label || "Browser node")}${node.id === currentNodeId ? " (this browser)" : ""}</li>`).join("");
  })().catch(() => { if (summaryEl) summaryEl.textContent = "Could not resolve device-reported locations."; });

  return () => {
    disposed = true;
    window.removeEventListener("meshvault:shard-pulse", onPulse);
    window.clearInterval(sweep);
    observer.disconnect();
    controls?.removeEventListener?.("change", () => {});
    globe._destructor?.();
  };
}
