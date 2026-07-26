import { countryCodeForCoordinates } from "./country-lookup.js";

// Called once when a device becomes a storage node. Asks for the browser's
// own location permission (a real, visible prompt - never silent) and, if
// granted, resolves only a coarse country code from the coordinates via the
// local country-outline lookup. The precise coordinates themselves are used
// in-memory for that one lookup and are never stored or transmitted; only the
// resulting ISO country code is kept. Any denial, timeout, or unsupported
// browser silently falls back to whatever coarser hint is already available -
// this must never block a device from joining the mesh.
export async function requestBrowserLocationHint(timeoutMs = 8000) {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 3600000 });
    });
    const countryCode = await countryCodeForCoordinates(position.coords.latitude, position.coords.longitude);
    if (!countryCode) return null;
    return { countryCode, regionCode: null, networkDomainHash: null, source: "browser_coarse", observedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}
