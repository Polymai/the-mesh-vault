const camera = { yaw: -.38, pitch: .22, zoom: 1.15, focus: { x: 0, y: 0, z: 0 } };
const FLOOR_Y = 150;
const LIGHT = { x: -.55, y: -.75 };
const PULSE_DURATION_MS = 900;

function hashNumber(value) {
  let hash = 2166136261;
  for (const character of String(value || "node")) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

const CAPACITY_MIN_BYTES = 256 * 1024 * 1024;
const CAPACITY_MAX_BYTES = 2 * 1024 ** 4;
function capacityWeight(capacityBytes) {
  const clamped = Math.max(CAPACITY_MIN_BYTES, Math.min(CAPACITY_MAX_BYTES, Number(capacityBytes) || CAPACITY_MIN_BYTES));
  return (Math.log10(clamped) - Math.log10(CAPACITY_MIN_BYTES)) / (Math.log10(CAPACITY_MAX_BYTES) - Math.log10(CAPACITY_MIN_BYTES));
}
function baseRadiusFor(node, isCurrent) { return (isCurrent ? 6.5 : 4.5) + capacityWeight(node?.capacity_bytes) * 5.5; }

// Nodes storing a larger share of their contributed capacity shift from the
// resting cyan/teal palette toward warm amber - a quick "how full is this
// node" read at a glance, layered on top of (not replacing) the existing
// role coloring (current/related/ambient/mine).
function fullnessOf(node) {
  const capacity = Number(node?.capacity_bytes) || 0;
  const used = Number(node?.used_bytes) || 0;
  return capacity > 0 ? Math.max(0, Math.min(1, used / capacity)) : 0;
}
function hexToHsl(hex) {
  const value = hex.replace("#", "");
  const bigint = parseInt(value.length === 3 ? value.split("").map((c) => c + c).join("") : value, 16);
  let r = ((bigint >> 16) & 255) / 255, g = ((bigint >> 8) & 255) / 255, b = (bigint & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > .5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}
function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360 / 360;
  const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else { const q = l < .5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = hue2rgb(p, q, hue + 1 / 3); g = hue2rgb(p, q, hue); b = hue2rgb(p, q, hue - 1 / 3); }
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function hueShiftForFullness(hex, fullness) {
  if (fullness <= 0.02) return hex;
  const { h, s, l } = hexToHsl(hex);
  const targetHue = 30;
  const diff = ((targetHue - h + 540) % 360) - 180;
  return hslToHex(h + diff * fullness * .85, Math.min(1, s + fullness * .3), l);
}

function positionsFor(nodes, currentNodeId) {
  const result = new Map();
  const remotes = nodes.filter((node) => node.id !== currentNodeId);
  if (currentNodeId) result.set(currentNodeId, { x: 0, y: 0, z: 0 });
  remotes.forEach((node, index) => {
    const seed = hashNumber(node.id);
    const angle = (index / Math.max(1, remotes.length)) * Math.PI * 2 + ((seed % 1000) / 1000) * .8;
    const layer = ((seed >>> 10) % 1000) / 1000;
    const radius = 125 + (seed % 55);
    result.set(node.id, { x: Math.cos(angle) * radius, y: (layer - .5) * 190, z: Math.sin(angle) * radius });
  });
  return result;
}
function phasesFor(nodes) {
  const result = new Map();
  nodes.forEach((node) => { const seed = hashNumber(node.id); result.set(node.id, (seed % 1000) / 1000 * Math.PI * 2); });
  return result;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

export function renderMeshUniverse(nodes, edges, { selectedNodeId, currentNodeId } = {}) {
  const selected = nodes.find((node) => node.id === selectedNodeId);
  const neighborCount = new Set(edges.flatMap((edge) => edge.source === selectedNodeId ? [edge.target] : edge.target === selectedNodeId ? [edge.source] : [])).size;
  return `<div class="mesh-universe" data-mesh-universe data-transfer-animation="real-shard-pulses-only" data-selected-node="${esc(selectedNodeId)}" data-current-node="${esc(currentNodeId)}">
    <canvas class="mesh-universe__canvas" tabindex="0" role="application" aria-label="3D mesh map. Drag to orbit, scroll to zoom, and click a node to fly to it."></canvas>
    <div class="mesh-universe__hud"><span><i class="${selected?.is_anchor ? "is-anchor" : ""}"></i>${selected ? esc(selected.device_label || "Browser node") : "Mesh overview"}${selected?.is_anchor ? `<b>Anchor</b>` : ""}</span><small>${selected ? `${neighborCount} observed connection${neighborCount === 1 ? "" : "s"}` : `${nodes.length} nodes`}</small></div>
    <div class="mesh-universe__controls" aria-label="3D map controls"><button type="button" data-universe-zoom="in" aria-label="Zoom in">+</button><button type="button" data-universe-zoom="out" aria-label="Zoom out">&minus;</button><button type="button" data-universe-reset>Reset</button></div>
    <div class="mesh-universe__legend" aria-label="Node role legend"><span><i class="is-anchor"></i>Anchor</span><span><i class="has-files"></i>Stores your files</span></div>
    <div class="mesh-universe__hint">Drag to orbit <span>&bull;</span> Scroll to zoom <span>&bull;</span> Click a node to fly</div>
  </div>`;
}

export function bindMeshUniverse({ nodes, edges, selectedNodeId, currentNodeId, onSelect }) {
  const root = document.querySelector("[data-mesh-universe]");
  const canvas = root?.querySelector("canvas");
  if (!root || !canvas) return;
  const context = canvas.getContext("2d");
  if (!context) return;
  const positions = positionsFor(nodes, currentNodeId);
  const phases = phasesFor(nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  let selected = selectedNodeId;
  let targetFocus = positions.get(selected) || { x: 0, y: 0, z: 0 };
  let pointer = null;
  let moved = false;
  let hitTargets = [];
  let frame = 0;
  let lastTime = performance.now();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pulses = new Map();
  const pulseKey = (a, b) => [a, b].sort().join(":");
  const onPulse = (event) => {
    const { fromNodeId, toNodeId } = event.detail || {};
    if (!fromNodeId || !toNodeId) return;
    pulses.set(pulseKey(fromNodeId, toNodeId), { at: performance.now(), fromNodeId, toNodeId });
  };
  window.addEventListener("meshvault:shard-pulse", onPulse);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return rect;
  }

  function project(point, width, height) {
    const translated = { x: point.x - camera.focus.x, y: point.y - camera.focus.y, z: point.z - camera.focus.z };
    const cosY = Math.cos(camera.yaw), sinY = Math.sin(camera.yaw);
    const x1 = translated.x * cosY - translated.z * sinY;
    const z1 = translated.x * sinY + translated.z * cosY;
    const cosX = Math.cos(camera.pitch), sinX = Math.sin(camera.pitch);
    const y2 = translated.y * cosX - z1 * sinX;
    const z2 = translated.y * sinX + z1 * cosX;
    const perspective = 520;
    const scale = camera.zoom * perspective / Math.max(260, perspective + z2);
    return { x: width / 2 + x1 * scale, y: height / 2 + y2 * scale, z: z2, scale };
  }

  function drawFloor(width, height) {
    const center = project({ x: 0, y: FLOOR_Y, z: 0 }, width, height);
    const glow = context.createRadialGradient(center.x, center.y, 0, center.x, center.y, 150 * center.scale);
    glow.addColorStop(0, "rgba(53,217,230,.12)"); glow.addColorStop(1, "rgba(53,217,230,0)");
    context.globalAlpha = 1; context.fillStyle = glow;
    context.beginPath(); context.arc(center.x, center.y, 150 * center.scale, 0, Math.PI * 2); context.fill();

    [50, 95, 140, 185, 230].forEach((radius, ringIndex) => {
      context.beginPath();
      for (let i = 0; i <= 48; i += 1) {
        const angle = (i / 48) * Math.PI * 2;
        const point = project({ x: Math.cos(angle) * radius, y: FLOOR_Y, z: Math.sin(angle) * radius }, width, height);
        if (i === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
      }
      context.strokeStyle = `rgba(67,217,189,${Math.max(.02, .17 - ringIndex * .028)})`;
      context.lineWidth = 1;
      context.stroke();
    });
    const spokes = 16;
    for (let s = 0; s < spokes; s += 1) {
      const angle = (s / spokes) * Math.PI * 2;
      const inner = project({ x: Math.cos(angle) * 28, y: FLOOR_Y, z: Math.sin(angle) * 28 }, width, height);
      const outer = project({ x: Math.cos(angle) * 230, y: FLOOR_Y, z: Math.sin(angle) * 230 }, width, height);
      context.beginPath(); context.moveTo(inner.x, inner.y); context.lineTo(outer.x, outer.y);
      context.strokeStyle = "rgba(67,217,189,.06)"; context.lineWidth = 1; context.stroke();
    }
  }

  function draw(time) {
    if (!canvas.isConnected) return;
    const rect = resize();
    const width = rect.width, height = rect.height;
    const elapsed = Math.min(32, time - lastTime); lastTime = time;
    if (!pointer && !reducedMotion) camera.yaw += elapsed * .000025;
    camera.focus.x += (targetFocus.x - camera.focus.x) * .075;
    camera.focus.y += (targetFocus.y - camera.focus.y) * .075;
    camera.focus.z += (targetFocus.z - camera.focus.z) * .075;

    const gradient = context.createRadialGradient(width * .5, height * .45, 0, width * .5, height * .45, Math.max(width, height) * .7);
    gradient.addColorStop(0, "#10283b"); gradient.addColorStop(.55, "#071624"); gradient.addColorStop(1, "#040b13");
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
    for (let index = 0; index < 95; index += 1) {
      const seed = hashNumber(`star-${index}`);
      const baseX = (seed % 10000) / 10000 * width;
      const parallax = camera.yaw * (8 + (seed % 20));
      const x = ((baseX - parallax) % width + width) % width;
      const y = ((seed >>> 8) % 10000) / 10000 * height;
      const radius = .35 + ((seed >>> 16) % 10) / 14;
      const twinkle = .5 + Math.sin(time * .001 + seed) * .5;
      context.globalAlpha = (.16 + ((seed >>> 20) % 10) / 26) * (.5 + twinkle * .5);
      context.fillStyle = index % 9 === 0 ? "#35d9e6" : "#d9eef2";
      context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
    }
    context.globalAlpha = 1;

    drawFloor(width, height);

    const bobbed = reducedMotion ? positions : new Map(Array.from(positions, ([id, point]) => [id, { ...point, y: point.y + Math.sin(time * .0011 + (phases.get(id) || 0)) * 5 }]));
    const projected = new Map(Array.from(bobbed, ([id, point]) => [id, project(point, width, height)]));
    const neighbors = new Set(edges.flatMap((edge) => edge.source === selected ? [edge.target] : edge.target === selected ? [edge.source] : []));

    edges.forEach((edge) => {
      const from = projected.get(edge.source), to = projected.get(edge.target);
      if (!from || !to) return;
      const highlighted = !selected || edge.source === selected || edge.target === selected;
      const baseAlpha = highlighted ? .85 : .14;
      const color = edge.direct ? "53,217,230" : "67,217,189";
      context.strokeStyle = `rgb(${color})`;
      context.globalAlpha = baseAlpha * .3; context.lineWidth = highlighted ? 5.5 : 2.6;
      context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
      context.globalAlpha = baseAlpha; context.lineWidth = highlighted ? 1.6 : .8;
      context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
      if (edge.transferring) {
        const seedOffset = (hashNumber(`${edge.source}${edge.target}`) % 100) / 100;
        for (let trail = 0; trail < 5; trail += 1) {
          const progress = (((time * .00025 + seedOffset) - trail * .035) % 1 + 1) % 1;
          const x = from.x + (to.x - from.x) * progress, y = from.y + (to.y - from.y) * progress;
          context.globalAlpha = (1 - trail / 5) * .9;
          context.fillStyle = "#ffffff";
          context.beginPath(); context.arc(x, y, 2.8 - trail * .35, 0, Math.PI * 2); context.fill();
        }
      }
      const pulse = pulses.get(pulseKey(edge.source, edge.target));
      if (pulse) {
        const elapsed = time - pulse.at;
        const progress = elapsed / PULSE_DURATION_MS;
        if (progress <= 1) {
          const t = pulse.fromNodeId === edge.source ? progress : 1 - progress;
          const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t;
          const fade = Math.sin(Math.min(1, progress) * Math.PI);
          context.globalAlpha = fade;
          context.shadowBlur = 18; context.shadowColor = "#ffffff";
          context.fillStyle = "#ffffff";
          context.beginPath(); context.arc(x, y, 4.2, 0, Math.PI * 2); context.fill();
          context.shadowBlur = 0;
          context.globalAlpha = fade * .55; context.lineWidth = 3.4;
          context.strokeStyle = "#ffffff";
          context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y); context.stroke();
        } else {
          pulses.delete(pulseKey(edge.source, edge.target));
        }
      }
    });
    context.globalAlpha = 1;

    const ordered = Array.from(projected.entries()).sort((a, b) => b[1].z - a[1].z);

    ordered.forEach(([id, point]) => {
      const node = nodeById.get(id); if (!node) return;
      const related = !selected || id === selected || neighbors.has(id);
      const ambientDamp = node.is_ambient && id !== selected ? .6 : 1;
      const radius = Math.max(3, Math.min(15, baseRadiusFor(node, id === currentNodeId) * point.scale * ambientDamp));
      const floorPoint = project({ x: positions.get(id).x, y: FLOOR_Y, z: positions.get(id).z }, width, height);
      context.globalAlpha = (related ? .32 : .12) * ambientDamp;
      context.fillStyle = "#00030a";
      context.beginPath(); context.ellipse(floorPoint.x, floorPoint.y, radius * 1.3, radius * .42, 0, 0, Math.PI * 2); context.fill();
    });
    context.globalAlpha = 1;

    hitTargets = [];
    ordered.forEach(([id, point]) => {
      const node = nodeById.get(id); if (!node) return;
      const isSelected = id === selected;
      const isCurrent = id === currentNodeId;
      const related = !selected || isSelected || neighbors.has(id);
      const ambientDamp = node.is_ambient && !isSelected ? .6 : 1;
      const radius = Math.max(3, Math.min(15, baseRadiusFor(node, isCurrent) * point.scale * ambientDamp));
      const fullness = fullnessOf(node);
      const isAnchor = !!node.is_anchor;
      const baseColor = isAnchor ? "#9585ff" : hueShiftForFullness(isCurrent ? "#35d9e6" : node.is_ambient ? "#3d4d55" : related ? "#43d9bd" : "#5b7480", fullness);
      const highlightColor = isAnchor ? "#f1edff" : hueShiftForFullness(isCurrent ? "#d8fdff" : node.is_ambient ? "#7c8f97" : related ? "#d3fff5" : "#9fb2ba", fullness);
      const rimColor = isAnchor ? "#271b68" : hueShiftForFullness(isCurrent ? "#0a3846" : node.is_ambient ? "#0c1216" : related ? "#0c3f3a" : "#141d23", fullness * .6);
      const sphere = context.createRadialGradient(point.x + radius * LIGHT.x * .5, point.y + radius * LIGHT.y * .5, radius * .1, point.x, point.y, radius * 1.08);
      sphere.addColorStop(0, highlightColor); sphere.addColorStop(.5, baseColor); sphere.addColorStop(1, rimColor);
      const pulse = (isCurrent || isSelected) ? .82 + Math.sin(time * .0025 + (phases.get(id) || 0)) * .18 : 1;
      context.globalAlpha = (related ? 1 : .3) * (ambientDamp === 1 ? 1 : .7);
      context.shadowBlur = (isSelected ? 26 : related ? 13 : 0) * pulse * ambientDamp;
      context.shadowColor = isAnchor ? "#9585ff" : isSelected ? "#35d9e6" : "rgba(67,217,189,.55)";
      context.fillStyle = sphere;
      context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fill();
      context.shadowBlur = 0;
      context.lineWidth = isSelected ? 3 : 1.5;
      context.strokeStyle = isSelected ? "#ffffff" : "rgba(255,255,255,.62)";
      context.stroke();
      if (isAnchor) {
        context.save();
        context.translate(point.x, point.y);
        context.rotate(Math.PI / 4);
        context.globalAlpha = related ? .9 : .4;
        context.strokeStyle = "#b6aaff";
        context.lineWidth = 1.7;
        context.strokeRect(-(radius + 5), -(radius + 5), (radius + 5) * 2, (radius + 5) * 2);
        context.restore();
      }
      if (node.has_my_files) {
        context.globalAlpha = related ? .9 : .35;
        context.strokeStyle = "#f5c451"; context.lineWidth = 2;
        context.beginPath(); context.arc(point.x, point.y, radius + 5, 0, Math.PI * 2); context.stroke();
      }
      if (isSelected) {
        const ringPulse = (Math.sin(time * .003) + 1) / 2;
        [0, 1].forEach((ringIndex) => {
          context.globalAlpha = (.5 - ringIndex * .22) * (1 - ringPulse * .3);
          context.strokeStyle = isAnchor ? "#a99cff" : "#35d9e6"; context.lineWidth = 1.4;
          context.beginPath(); context.arc(point.x, point.y, radius + 10 + ringIndex * 9 + ringPulse * 4, 0, Math.PI * 2); context.stroke();
        });
      }
      if (isSelected || (related && !node.is_ambient) || (nodes.length < 8 && !node.is_ambient)) {
        context.globalAlpha = related ? .95 : .35;
        context.fillStyle = "#eaf8fb";
        context.font = `${isSelected ? "700" : "600"} ${isSelected ? 12 : 10}px Manrope, sans-serif`;
        context.textAlign = "center";
        context.fillText(`${node.device_label || "Browser node"}${isAnchor ? " · ANCHOR" : ""}${isCurrent ? " · YOU" : ""}`.slice(0, 34), point.x, point.y + radius + 17);
      }
      hitTargets.push({ id, x: point.x, y: point.y, radius: radius + 12, z: point.z });
    });
    context.globalAlpha = 1;

    const vignette = context.createRadialGradient(width / 2, height / 2, Math.min(width, height) * .28, width / 2, height / 2, Math.max(width, height) * .72);
    vignette.addColorStop(0, "rgba(0,0,0,0)"); vignette.addColorStop(1, "rgba(0,3,8,.5)");
    context.fillStyle = vignette; context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;

    frame = requestAnimationFrame(draw);
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener("pointerdown", (event) => { pointer = { ...pointerPosition(event), yaw: camera.yaw, pitch: camera.pitch }; moved = false; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointer) return;
    const next = pointerPosition(event), dx = next.x - pointer.x, dy = next.y - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    camera.yaw = pointer.yaw + dx * .008;
    camera.pitch = Math.max(-1.2, Math.min(1.2, pointer.pitch + dy * .008));
  });
  canvas.addEventListener("pointerup", (event) => {
    const point = pointerPosition(event); pointer = null;
    if (moved) return;
    const hit = hitTargets.filter((target) => Math.hypot(target.x - point.x, target.y - point.y) <= target.radius).sort((a, b) => a.z - b.z)[0];
    if (hit) onSelect(hit.id);
  });
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); camera.zoom = Math.max(.55, Math.min(2.6, camera.zoom * (event.deltaY > 0 ? .9 : 1.1))); }, { passive: false });
  canvas.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "a", "A"].includes(event.key)) camera.yaw -= .12;
    else if (["ArrowRight", "d", "D"].includes(event.key)) camera.yaw += .12;
    else if (["ArrowUp", "w", "W"].includes(event.key)) camera.pitch = Math.max(-1.2, camera.pitch - .12);
    else if (["ArrowDown", "s", "S"].includes(event.key)) camera.pitch = Math.min(1.2, camera.pitch + .12);
    else return;
    event.preventDefault();
  });
  root.querySelector("[data-universe-zoom='in']")?.addEventListener("click", () => { camera.zoom = Math.min(2.6, camera.zoom * 1.18); });
  root.querySelector("[data-universe-zoom='out']")?.addEventListener("click", () => { camera.zoom = Math.max(.55, camera.zoom / 1.18); });
  root.querySelector("[data-universe-reset]")?.addEventListener("click", () => { selected = currentNodeId; targetFocus = positions.get(currentNodeId) || { x: 0, y: 0, z: 0 }; camera.yaw = -.38; camera.pitch = .22; camera.zoom = 1.15; if (currentNodeId) onSelect(currentNodeId); });
  frame = requestAnimationFrame(draw);
  return () => { cancelAnimationFrame(frame); window.removeEventListener("meshvault:shard-pulse", onPulse); };
}
