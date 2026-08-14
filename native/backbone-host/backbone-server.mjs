import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import { BackboneStore } from "./backbone-store.mjs";
import { canonicalBytes, loadOrCreateIdentity, verifyClientObject } from "./identity.mjs";
import { verifyControlObject, verifyDeletionAuthorization, verifyManifestEnvelope } from "./verification.mjs";

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const nowIso = () => new Date().toISOString();
const MANAGEMENT_PATH = "/_themeshvault/backbone";

function allowedManagementOrigin(origin) {
  if (!origin) return false;
  try {
    const value = new URL(origin);
    return value.origin === "https://themeshvault.com"
      || value.origin === "https://www.themeshvault.com"
      || ((value.hostname === "127.0.0.1" || value.hostname === "localhost") && value.protocol === "http:");
  } catch { return false; }
}

export function createBackboneServer(config, layout, identityPath) {
  const identity = loadOrCreateIdentity(identityPath);
  const store = new BackboneStore({ ...layout, backbonePublicKey: identity.publicKey });
  const clients = new Map();
  const tls = config.tls?.certificatePath && config.tls?.privateKeyPath;
  const startedAt = Date.now();
  let instanceChangeHandler = null;
  async function readJson(request) {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8192) throw new Error("Management request is too large.");
      chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }
  function managementResponse(response, status, value, origin = null) {
    if (origin && allowedManagementOrigin(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Private-Network", "true");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.writeHead(status); response.end(JSON.stringify(value));
  }
  async function managementRequest(request, response) {
    const origin = String(request.headers.origin || "");
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(MANAGEMENT_PATH)) { response.writeHead(404); response.end(); return; }
    if (!allowedManagementOrigin(origin)) { managementResponse(response, 403, { ok: false, error: "Origin is not allowed." }); return; }
    if (request.method === "OPTIONS") { managementResponse(response, 204, null, origin); return; }
    if (request.method === "GET" && url.pathname === `${MANAGEMENT_PATH}/status`) {
      managementResponse(response, 200, {
        ok: true, protocolVersion: 3, managerVersion: 1, pid: process.pid, startedAt,
        physicalHostId: config.physicalHostId, launcherHostId: config.launcherHostId || null,
        label: config.label || "TheMeshVault Backbone",
        instances: store.instanceStatuses(),
      }, origin);
      return;
    }
    const match = new RegExp(`^${MANAGEMENT_PATH}/instances/([a-f0-9-]+)/(start|stop|restart)$`, "i").exec(url.pathname);
    if (request.method === "POST" && match) {
      await readJson(request);
      const [, instanceId, action] = match;
      const instance = store.instance(instanceId);
      if (!instance) { managementResponse(response, 404, { ok: false, error: "Unknown Backbone instance." }, origin); return; }
      const result = action === "stop"
        ? store.setInstanceEnabled(instanceId, false)
        : store.setInstanceEnabled(instanceId, true, { restart: action === "restart" });
      await instanceChangeHandler?.();
      managementResponse(response, 200, { ok: true, instance: result }, origin);
      return;
    }
    managementResponse(response, 404, { ok: false, error: "Unknown management action." }, origin);
  }
  const server = tls
    ? createHttpsServer({ cert: readFileSync(config.tls.certificatePath), key: readFileSync(config.tls.privateKeyPath) }, (request, response) => managementRequest(request, response).catch((error) => managementResponse(response, 500, { ok: false, error: error.message }, request.headers.origin)))
    : createHttpServer((request, response) => managementRequest(request, response).catch((error) => managementResponse(response, 500, { ok: false, error: error.message }, request.headers.origin)));
  const websocket = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

  function send(socket, value) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
  function reply(socket, requestId, result, error = null) { send(socket, error ? { type: "response", requestId, ok: false, error } : { type: "response", requestId, ok: true, result }); }
  function broadcastPresence() { const value = store.peers(); for (const client of clients.values()) send(client.socket, { type: "presence", payload: value }); }
  function responseWelcome() {
    const core = { type: "welcome", protocolVersion: 3, serverPublicKey: identity.publicKey, physicalHostId: config.physicalHostId, createdAt: Date.now(), expiresAt: Date.now() + 120000 };
    return { ...core, signature: identity.signObject(core) };
  }
  async function action(client, name, payload) {
    if (name === "ping") return { ok: true, at: Date.now() };
    if (name === "discover") return store.peers();
    if (name === "presence") {
      store.putLease({ ...payload, nodeId: client.nodeId, devicePublicKey: client.publicKey, lastSeenAt: nowIso() });
      broadcastPresence(); return true;
    }
    if (name === "signal") {
      if (payload?.fromNodeId !== client.nodeId || !payload?.toNodeId) return false;
      const target = clients.get(payload.toNodeId); if (!target) return false;
      send(target.socket, { type: "signal", payload }); return true;
    }
    if (name === "control-put") { if (!verifyControlObject(payload?.object)) throw new Error("Invalid signed control object."); return store.putControl(payload.object); }
    if (name === "control-query") return store.queryControl(payload?.kind, payload?.lookupKey, payload?.limit);
    if (name === "manifest-put") { if (!verifyManifestEnvelope(payload?.envelope)) throw new Error("Invalid signed manifest."); return store.putManifest(payload.envelope); }
    if (name === "manifest-get") return store.getManifest(payload?.manifestId);
    if (name === "fragment-put") return store.putFragmentLocation(payload?.shardHash, client.nodeId);
    if (name === "fragment-get") return store.fragmentLocations(payload?.shardHash);
    if (name === "shard-start") { store.startShard(payload?.instanceId, payload?.transferId, payload?.shardHash, payload?.expectedSize, payload?.expectedHash); return true; }
    if (name === "shard-chunk") { store.appendShard(payload?.transferId, String(payload?.data || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(payload?.data || "").length / 4) * 4, "=")); return true; }
    if (name === "shard-finish") return store.finishShard(payload?.transferId);
    if (name === "shard-abort") { const upload = store.uploads.get(payload?.transferId); store.uploads.delete(payload?.transferId); try { if (upload?.tempPath) (await import("node:fs")).rmSync(upload.tempPath); } catch {} return true; }
    if (name === "shard-info") { const bytes = store.getShard(payload?.instanceId, payload?.shardHash); return bytes ? { hash: payload.shardHash, size: bytes.byteLength } : null; }
    if (name === "shard-read") { const bytes = store.getShard(payload?.instanceId, payload?.shardHash); if (!bytes) return null; const offset = Math.max(0, Number(payload?.offset) || 0); const length = Math.min(65536, Math.max(1, Number(payload?.length) || 65536)); return { data: bytes.subarray(offset, offset + length).toString("base64url") }; }
    if (name === "shard-delete") { if (!verifyDeletionAuthorization(payload?.authorization, payload?.instanceId, payload?.shardHash)) return false; return store.deleteShard(payload.instanceId, payload.shardHash); }
    throw new Error("Unsupported Backbone action.");
  }

  websocket.on("connection", (socket) => {
    let client = null;
    const helloTimer = setTimeout(() => socket.close(1008, "Signed hello required"), 5000);
    socket.on("message", async (raw) => {
      if (raw.byteLength > MAX_MESSAGE_BYTES) { socket.close(1009, "Message too large"); return; }
      let message; try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (!client) {
        if (message.type !== "hello" || message.protocolVersion !== 3 || !message.node?.nodeId) { socket.close(1008, "Invalid hello"); return; }
        const helloAge = Math.abs(Date.now() - Number(message.createdAt || 0));
        if (!verifyClientObject(message, message.clientPublicKey) || message.node.devicePublicKey !== message.clientPublicKey || Number(message.expiresAt || 0) <= Date.now() || helloAge > 120000) { socket.close(1008, "Unverified client"); return; }
        client = { socket, nodeId: message.node.nodeId, publicKey: message.clientPublicKey }; clients.set(client.nodeId, client); store.putLease(message.node); clearTimeout(helloTimer); send(socket, responseWelcome()); broadcastPresence(); return;
      }
      if (message.type !== "request" || !message.requestId) return;
      try { reply(socket, message.requestId, await action(client, message.action, message.payload || {})); }
      catch (error) { reply(socket, message.requestId, null, String(error?.message || "Backbone request failed.").slice(0, 240)); }
    });
    socket.on("close", () => { clearTimeout(helloTimer); if (client && clients.get(client.nodeId)?.socket === socket) clients.delete(client.nodeId); broadcastPresence(); });
  });

  return {
    identity,
    store,
    setInstanceChangeHandler(handler) { instanceChangeHandler = typeof handler === "function" ? handler : null; },
    async start() { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(config.listen?.port ?? 3717), config.listen?.host || "127.0.0.1", resolve); }); return server.address(); },
    async stop() { store.flush(); for (const client of clients.values()) client.socket.close(1001, "Server stopping"); await new Promise((resolve) => websocket.close(() => server.close(resolve))); },
  };
}
