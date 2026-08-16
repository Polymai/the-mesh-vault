const ROUTES = Object.freeze(["direct", "anchor", "supabase"]);
const MAX_ENTRIES = 24;
const MERGE_WINDOW_MS = 1500;
const EMIT_INTERVAL_MS = 750;
const RECENT_WINDOW_MS = 5 * 60 * 1000;
const MAX_SAMPLES = 4096;
const encoder = new TextEncoder();
const listeners = new Set();
const entries = [];
const samples = [];
const totals = Object.fromEntries(ROUTES.map((route) => [route, { inboundBytes: 0, outboundBytes: 0, events: 0 }]));
let emitTimer = null;

function safeText(value, fallback, maxLength = 80) {
  const text = String(value || fallback || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (text || fallback || "").slice(0, maxLength);
}

function notifySoon() {
  if (emitTimer !== null) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    const snapshot = dataFlowSnapshot();
    listeners.forEach((listener) => { try { listener(snapshot); } catch {} });
  }, EMIT_INTERVAL_MS);
}

export function byteLength(value) {
  if (typeof value === "string") return encoder.encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  return 0;
}

export function describePeerMessage(messageType) {
  const type = String(messageType || "");
  if (type.startsWith("shard-delete") || type === "shard-deleted") return "Shard deletion";
  if (type.startsWith("shard-")) return type.includes("request") ? "Shard request" : "Encrypted shard";
  if (type.startsWith("proof-") || type === "availability") return "Shard verification";
  if (type.startsWith("manifest-")) return "Encrypted manifest";
  if (type.startsWith("control-")) return "Signed coordination";
  if (type === "relay-signal") return "Peer connection";
  if (type === "gossip") return "Mesh discovery";
  if (type === "ping" || type === "pong") return "Connection check";
  return "Peer data";
}

export function describeSupabaseRequest(urlValue, method = "GET", body = null) {
  let path = "";
  try { path = new URL(String(urlValue), globalThis.location?.href || "https://local.invalid/").pathname; } catch {}
  const rpc = path.match(/\/rpc\/([^/?]+)/)?.[1] || "";
  const table = path.match(/\/rest\/v1\/([^/?]+)/)?.[1] || "";
  if (path.includes("/auth/v1/")) return "Anonymous session";
  if (path.includes("/functions/v1/")) {
    try {
      const action = JSON.parse(typeof body === "string" ? body : "{}").action;
      if (action === "turn-credentials") return "Peer connection setup";
      if (/wake|push/i.test(String(action || ""))) return "Node reminder";
      if (/account/i.test(String(action || ""))) return "Optional account";
    } catch {}
    return "Connection setup";
  }
  const rpcLabels = {
    discover_bootstrap_gateways: "Find Patient Zero",
    get_node_signal_topic: "Peer signal channel",
    send_mesh_signal: "Peer signal",
    load_network_overview: "Mesh overview",
    network_totals: "Mesh totals",
    load_operation_cache_delta: "Vault changes",
  };
  if (rpcLabels[rpc]) return rpcLabels[rpc];
  const tableLabels = {
    nodes: String(method).toUpperCase() === "GET" ? "Node status" : "Node heartbeat",
    vaults: "Vault bootstrap",
    vault_index_cache: "Encrypted vault index",
    vault_operation_cache: "Vault changes",
    fragment_location_cache: "Shard locations",
    recovery_envelope_cache: "Legacy recovery record",
    files: "Vault catalog",
    folders: "Vault catalog",
    file_versions: "Vault catalog",
    content_segments: "Shard metadata",
    version_segments: "Shard metadata",
    segment_shards: "Shard metadata",
    shard_placements: "Shard metadata",
    transfers: "Transfer status",
    encrypted_manifest_cache: "Encrypted manifest index",
    signed_operation_cache: "Vault changes",
    fragment_locations: "Shard locations",
    network_events: "Mesh activity",
    network_snapshots: "Mesh history",
    node_push_subscriptions: "Node reminders",
    push_subscriptions: "Node reminders",
    account_links: "Optional account",
  };
  return tableLabels[table] || "Database request";
}

export function recordDataFlow({ route, direction, kind, bytes = 0, counterparty = null, transport = null, at = Date.now() } = {}) {
  if (!ROUTES.includes(route) || !["in", "out"].includes(direction)) return false;
  const safeBytes = Math.max(0, Math.round(Number(bytes) || 0));
  const safeKind = safeText(kind, "Data", 64);
  const safeCounterparty = counterparty ? safeText(counterparty, "Peer", 64) : null;
  const key = [route, direction, safeKind, safeCounterparty || ""].join("|");
  const existing = entries.find((entry) => entry.key === key && at - entry.at <= MERGE_WINDOW_MS);
  totals[route][direction === "in" ? "inboundBytes" : "outboundBytes"] += safeBytes;
  totals[route].events += 1;
  samples.push({ route, direction, bytes: safeBytes, at });
  const cutoff = at - RECENT_WINDOW_MS;
  while (samples.length && (samples[0].at < cutoff || samples.length > MAX_SAMPLES)) samples.shift();
  if (existing) {
    existing.bytes += safeBytes;
    existing.count += 1;
    existing.at = at;
    const index = entries.indexOf(existing);
    if (index > 0) entries.unshift(...entries.splice(index, 1));
  } else {
    entries.unshift({ key, route, direction, kind: safeKind, bytes: safeBytes, count: 1, counterparty: safeCounterparty, transport: safeText(transport, "", 32) || null, at });
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  }
  notifySoon();
  return true;
}

export function dataFlowSnapshot() {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recentTotals = Object.fromEntries(ROUTES.map((route) => [route, { inboundBytes: 0, outboundBytes: 0, events: 0 }]));
  samples.forEach((sample) => {
    if (sample.at < cutoff) return;
    recentTotals[sample.route][sample.direction === "in" ? "inboundBytes" : "outboundBytes"] += sample.bytes;
    recentTotals[sample.route].events += 1;
  });
  return {
    startedAt: sessionStartedAt,
    totals: Object.fromEntries(ROUTES.map((route) => [route, { ...totals[route] }])),
    recentWindowMs: RECENT_WINDOW_MS,
    recentTotals,
    entries: entries.map(({ key: _key, ...entry }) => ({ ...entry })),
  };
}

export function subscribeDataFlow(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetDataFlowLog() {
  entries.length = 0;
  samples.length = 0;
  ROUTES.forEach((route) => { totals[route] = { inboundBytes: 0, outboundBytes: 0, events: 0 }; });
  notifySoon();
}

const sessionStartedAt = Date.now();
