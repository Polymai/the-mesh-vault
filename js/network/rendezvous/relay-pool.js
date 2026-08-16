import { recordDataFlow } from "../../observability/data-flow-log.js";

const MAX_EVENT_BYTES = 256 * 1024;

function normalizedUrls(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter((value) => /^wss:\/\/[^\s/]+(?:\/.*)?$/i.test(value)))].slice(0, 5);
}

function wireBytes(value) { return new TextEncoder().encode(String(value || "")).byteLength; }

export class RelayPool {
  constructor(urls) {
    this.urls = normalizedUrls(urls);
    this.connections = new Map();
    this.subscriptions = new Map();
    this.seen = new Map();
    this.closed = false;
    this.connectAll();
  }

  connectAll() { this.urls.forEach((url) => this.connect(url)); }

  connect(url) {
    if (this.closed || this.connections.get(url)?.socket?.readyState <= WebSocket.OPEN) return;
    const state = this.connections.get(url) || { socket: null, attempts: 0, timer: null };
    let socket;
    try { socket = new WebSocket(url); } catch { this.scheduleReconnect(url, state); return; }
    state.socket = socket;
    this.connections.set(url, state);
    socket.addEventListener("open", () => {
      state.attempts = 0;
      for (const [id, subscription] of this.subscriptions) this.send(socket, ["REQ", id, subscription.filter], url);
    });
    socket.addEventListener("message", (event) => this.handleMessage(url, event.data));
    socket.addEventListener("close", () => this.scheduleReconnect(url, state));
    socket.addEventListener("error", () => {});
  }

  scheduleReconnect(url, state) {
    if (this.closed || state.timer) return;
    const delay = Math.min(60000, 1000 * (2 ** Math.min(6, state.attempts++))) * (0.8 + Math.random() * 0.4);
    state.timer = setTimeout(() => { state.timer = null; this.connect(url); }, delay);
  }

  send(socket, message, url) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const wire = JSON.stringify(message);
    socket.send(wire);
    recordDataFlow({ route: "rendezvous", direction: "out", kind: "Encrypted rendezvous", bytes: wireBytes(wire), counterparty: new URL(url).hostname, transport: "wss" });
    return true;
  }

  handleMessage(url, raw) {
    const text = typeof raw === "string" ? raw : "";
    if (!text || wireBytes(text) > MAX_EVENT_BYTES) return;
    recordDataFlow({ route: "rendezvous", direction: "in", kind: "Encrypted rendezvous", bytes: wireBytes(text), counterparty: new URL(url).hostname, transport: "wss" });
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (!Array.isArray(message) || message[0] !== "EVENT" || typeof message[1] !== "string" || !message[2]?.id) return;
    const subscription = this.subscriptions.get(message[1]);
    if (!subscription) return;
    const seenAt = this.seen.get(message[2].id);
    if (seenAt && Date.now() - seenAt < 10 * 60 * 1000) return;
    this.seen.set(message[2].id, Date.now());
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value);
    try { subscription.handler(message[2], url); } catch {}
  }

  subscribe(filter, handler) {
    const id = `tmv-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.subscriptions.set(id, { filter: structuredClone(filter), handler });
    for (const [url, state] of this.connections) this.send(state.socket, ["REQ", id, filter], url);
    return () => {
      this.subscriptions.delete(id);
      for (const [url, state] of this.connections) this.send(state.socket, ["CLOSE", id], url);
    };
  }

  async query(filter, timeoutMs = 2500) {
    const events = [];
    const stop = this.subscribe(filter, (event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, timeoutMs)));
    stop();
    return events;
  }

  async publish(event, timeoutMs = 2500) {
    const deadline = Date.now() + Math.max(250, timeoutMs);
    while (!this.closed && Date.now() < deadline) {
      let sent = 0;
      for (const [url, state] of this.connections) sent += this.send(state.socket, ["EVENT", event], url) ? 1 : 0;
      if (sent) return sent;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return 0;
  }

  status() {
    return {
      configured: this.urls.length,
      connected: [...this.connections.values()].filter((state) => state.socket?.readyState === WebSocket.OPEN).length,
    };
  }

  close() {
    this.closed = true;
    for (const state of this.connections.values()) { clearTimeout(state.timer); state.socket?.close?.(1000, "TheMeshVault stopped"); }
    this.connections.clear();
    this.subscriptions.clear();
  }
}
