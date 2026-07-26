// Resolves a {lat, lng} pair to an ISO 3166-1 alpha-2 country code entirely
// client-side, using the same local Natural Earth 1:110m country outlines the
// "Data locations" globe renders. Nothing is sent to a third-party geocoding
// service and no coordinate ever leaves the browser.
let loadPromise = null;

async function loadCountries() {
  if (!loadPromise) {
    loadPromise = fetch("data/ne-110m-countries.geojson").then((response) => {
      if (!response.ok) throw new Error("Could not load local country boundary data.");
      return response.json();
    });
  }
  return loadPromise;
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    const intersects = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
function pointInPolygon(lng, lat, polygonRings) {
  if (!polygonRings.length || !pointInRing(lng, lat, polygonRings[0])) return false;
  for (let i = 1; i < polygonRings.length; i += 1) if (pointInRing(lng, lat, polygonRings[i])) return false;
  return true;
}
function pointInFeature(lng, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygon(lng, lat, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((polygon) => pointInPolygon(lng, lat, polygon));
  return false;
}

export async function countryCodeForCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const collection = await loadCountries();
  const hit = collection.features.find((feature) => pointInFeature(lng, lat, feature.geometry));
  return hit?.properties?.iso_a2 || null;
}

export async function loadCountryOutlines() {
  return loadCountries();
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) { const [x1, y1] = ring[i]; const [x2, y2] = ring[(i + 1) % ring.length]; sum += x1 * y2 - x2 * y1; }
  return Math.abs(sum) / 2;
}
function ringCentroid(ring) {
  let cx = 0, cy = 0, area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i]; const [x2, y2] = ring[(i + 1) % ring.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-9) { const n = ring.length || 1; const sum = ring.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]); return [sum[0] / n, sum[1] / n]; }
  return [cx / (6 * area), cy / (6 * area)];
}
function polygonCentroidAndArea(polygonRings) {
  const outer = polygonRings[0] || [];
  return { centroid: ringCentroid(outer), area: ringArea(outer) };
}

const centroidCache = new Map();
// A country's representative point for coarse marker placement - the
// centroid of its largest landmass, computed from the same local outline
// data the globe renders (not a separate geocoding lookup, and no network
// call). This is only ever as precise as "somewhere in this country."
export async function countryCentroid(iso2) {
  if (!iso2) return null;
  if (centroidCache.has(iso2)) return centroidCache.get(iso2);
  const collection = await loadCountries();
  const feature = collection.features.find((f) => f.properties.iso_a2 === iso2);
  let result = null;
  if (feature) {
    const geometry = feature.geometry;
    if (geometry.type === "Polygon") { const { centroid } = polygonCentroidAndArea(geometry.coordinates); result = { lat: centroid[1], lng: centroid[0] }; }
    else if (geometry.type === "MultiPolygon") {
      let best = null;
      for (const polygon of geometry.coordinates) { const { centroid, area } = polygonCentroidAndArea(polygon); if (!best || area > best.area) best = { centroid, area }; }
      if (best) result = { lat: best.centroid[1], lng: best.centroid[0] };
    }
  }
  centroidCache.set(iso2, result);
  return result;
}
