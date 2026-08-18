/**
 * Supabase Realtime passes the value supplied to realtime.send() as the
 * broadcast callback payload. Some client/runtime versions wrap that value in
 * another `payload` property. A mesh signal itself also has a `payload`
 * property containing SDP or ICE, so blindly unwrapping `payload` destroys the
 * addressed signal envelope.
 */
export function normalizeSignalEnvelope(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [value, value.payload, value.data, value.record];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if (!candidate.fromNodeId || !candidate.toNodeId) continue;
    if (!["offer", "answer", "ice", "hello"].includes(candidate.type)) continue;
    return candidate;
  }
  return null;
}
