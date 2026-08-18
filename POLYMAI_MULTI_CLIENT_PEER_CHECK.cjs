const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const root = __dirname;
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };

function serve() {
  const server = http.createServer((request, response) => {
    if (request.url === "/multi-client-check") {
      response.writeHead(200, { "content-type": mime[".html"] });
      response.end("<!doctype html><meta charset=utf-8><title>multi-client peer check</title><script src='/js/vendor/nacl-fast.min.js'></script>");
      return;
    }
    const relative = decodeURIComponent(String(request.url || "/").split("?")[0]).replace(/^\/+/, "");
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": mime[path.extname(resolved)] || "application/octet-stream" });
    fs.createReadStream(resolved).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function installNode(page, nodeId, routeSignal) {
  await page.exposeFunction("routeMeshSignal", routeSignal);
  await page.goto(page.context()._options.baseURL + "/multi-client-check");
  await page.evaluate(async (id) => {
    window.__meshSignalHandlers = [];
    window.__receiveMeshSignal = (signal) => {
      for (const handler of window.__meshSignalHandlers.slice()) handler(signal);
    };
    const registry = await import("/js/network/providers/provider-registry.js");
    const types = await import("/js/network/providers/provider-types.js");
    const policy = await import("/js/network/coordination-policy.js");
    const peers = await import("/js/network/peer-manager.js");
    const signing = await import("/js/security/signing.js");
    const gossip = await import("/js/network/gossip.js");
    const anchor = await import("/js/network/anchor-service.js");
    const anchorProvider = await import("/js/network/providers/anchor-peer-bootstrap-provider.js");
    const pair = await signing.generateKeyPair();
    const publicKey = signing.bytesToBase64Url(await signing.exportPublicKeyRaw(pair.publicKey));
    const signer = {
      publicKey,
      algorithm: pair.algorithm,
      sign: (bytes) => signing.sign(pair.privateKey, pair.algorithm, bytes),
    };
    const announcements = new Map();
    registry.registerProvider(types.PROVIDER_KINDS.SIGNALING, {
      name: "local-peer",
      sendSignal: (signal) => window.routeMeshSignal(signal),
      onSignal(handler) {
        window.__meshSignalHandlers.push(handler);
        return () => { window.__meshSignalHandlers = window.__meshSignalHandlers.filter((entry) => entry !== handler); };
      },
    });
    registry.registerProvider(types.PROVIDER_KINDS.SIGNALING, anchorProvider.anchorPeerBootstrapProvider);
    registry.setCoordinationMode(policy.COORDINATION_MODES.ANCHOR_PRIMARY);
    window.__peerStates = [];
    window.__protocolConnections = [];
    window.__gossipReceived = [];
    window.__relayReceived = [];
    window.__anchorSends = [];
    const originalAnchorSendSignal = anchorProvider.anchorPeerBootstrapProvider.sendSignal.bind(anchorProvider.anchorPeerBootstrapProvider);
    anchorProvider.anchorPeerBootstrapProvider.sendSignal = async (signal) => {
      const result = await originalAnchorSendSignal(signal);
      window.__anchorSends.push({ from: signal.fromNodeId, to: signal.toNodeId, type: signal.type, result });
      return result;
    };
    const announce = async () => {
      const message = await gossip.buildGossipMessage(signer, gossip.GOSSIP_KINDS.PEER_ANNOUNCE, {
        nodeId: id,
        nodeName: id,
        protocolVersion: 3,
        capacityBytes: 1024,
        usedBytes: 0,
        capabilities: ["mesh-control-lite-v3"],
      });
      announcements.set(id, message);
      peers.broadcastGossip(message);
    };
    peers.configurePeers({
      fromNodeId: id,
      iceServers: [{ urls: "stun:127.0.0.1:9" }],
      onState: (remoteId, state) => window.__peerStates.push({ remoteId, state }),
      onProtocolConnected: async (peer) => {
        window.__protocolConnections.push(peer.nodeId);
        for (const [announcedNodeId, message] of announcements) {
          if (announcedNodeId !== peer.nodeId && announcedNodeId !== id) peer.protocol.sendGossip(message);
        }
        await announce();
      },
      onGossip: (_peer, message) => {
        window.__gossipReceived.push({ via: _peer.nodeId, kind: message.kind, announced: message.payload?.nodeId });
        if (message.kind !== gossip.GOSSIP_KINDS.PEER_ANNOUNCE) return;
        announcements.set(message.payload.nodeId, message);
        const remoteId = message.payload.nodeId;
        if (remoteId !== id && !peers.connectedProtocol(remoteId)) peers.connectPeer(remoteId).then((peer) => {
          window.__peerStates.push({ remoteId, state: "connect-return", pc: peer?.pc?.connectionState, channel: peer?.channel?.readyState || null });
        }).catch((error) => {
          window.__peerStates.push({ remoteId, state: "connect-error", error: String(error?.message || error) });
        });
      },
      onRelaySignal: (peer, signal) => {
        const accepted = anchor.receiveRelayedSignal(signal, peer.nodeId);
        window.__relayReceived.push({ via: peer.nodeId, from: signal.fromNodeId, to: signal.toNodeId, type: signal.type, visited: signal.relayVisited, accepted });
        return accepted;
      },
    });
    await anchor.configureAnchorService({
      nodeId: id,
      deviceIdentity: { devicePublicKey: publicKey, algorithm: pair.algorithm, sign: signer.sign },
      getPeers: peers.connectedProtocols,
      peerInfo: (remoteId) => ({ nodeId: remoteId, capabilities: [] }),
      getCoordinationStatus: () => ({ mode: policy.COORDINATION_MODES.ANCHOR_PRIMARY, fallbackActive: false }),
    });
    window.__peerManager = peers;
  }, nodeId);
}

(async () => {
  const server = await serve();
  const address = server.address();
  const baseURL = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  const pages = new Map();
  const pending = new Map();
  const routeSignal = async (signal) => {
    // The local provider represents the first-contact path. Client-to-client
    // signalling is deliberately unavailable here and must traverse the
    // authenticated Mainframe protocol connection instead.
    if (signal.fromNodeId !== "mainframe" && signal.toNodeId !== "mainframe") return false;
    const target = pages.get(signal.toNodeId);
    if (!target) {
      const queued = pending.get(signal.toNodeId) || [];
      queued.push(signal);
      pending.set(signal.toNodeId, queued);
      return true;
    }
    await target.evaluate((value) => window.__receiveMeshSignal(value), signal);
    return true;
  };
  try {
    for (const nodeId of ["mainframe", "client-a", "client-b"]) {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      pages.set(nodeId, page);
      await installNode(page, nodeId, routeSignal);
      for (const signal of pending.get(nodeId) || []) await page.evaluate((value) => window.__receiveMeshSignal(value), signal);
      pending.delete(nodeId);
    }

    await Promise.all(["client-a", "client-b"].map((nodeId) => pages.get(nodeId).evaluate(() => (
      window.__peerManager.connectPeer("mainframe", { forceOffer: true })
    ))));

    try {
      await pages.get("mainframe").waitForFunction(() => window.__peerManager.connectedProtocols().length === 2, null, { timeout: 15000 });
      await pages.get("client-a").waitForFunction(() => window.__peerManager.connectedProtocols().length === 2, null, { timeout: 15000 });
      await pages.get("client-b").waitForFunction(() => window.__peerManager.connectedProtocols().length === 2, null, { timeout: 15000 });
    } catch (error) {
      const diagnostics = {};
      for (const [nodeId, page] of pages) diagnostics[nodeId] = await page.evaluate(() => ({
        connected: window.__peerManager.connectedProtocols().map((peer) => peer.nodeId),
        states: window.__peerStates,
        protocolConnections: window.__protocolConnections,
        gossipReceived: window.__gossipReceived,
        relayReceived: window.__relayReceived,
        anchorSends: window.__anchorSends,
      }));
      console.error(JSON.stringify(diagnostics, null, 2));
      throw error;
    }

    const mainframePeers = await pages.get("mainframe").evaluate(() => window.__peerManager.connectedProtocols().map((peer) => peer.nodeId).sort());
    assert.deepEqual(mainframePeers, ["client-a", "client-b"]);
    const clientAPeers = await pages.get("client-a").evaluate(() => window.__peerManager.connectedProtocols().map((peer) => peer.nodeId).sort());
    const clientBPeers = await pages.get("client-b").evaluate(() => window.__peerManager.connectedProtocols().map((peer) => peer.nodeId).sort());
    assert.deepEqual(clientAPeers, ["client-b", "mainframe"]);
    assert.deepEqual(clientBPeers, ["client-a", "mainframe"]);
    const nodeService = fs.readFileSync(path.join(root, "js", "network", "node-service.js"), "utf8");
    assert.match(nodeService, /firstContact\s*\|\|\s*!reserveIds\.has\(nodeId\)/, "Patient Zero first contact must bypass reserve suppression");
    console.log("POLYMAI multi-client peer check passed: Mainframe accepted two simultaneous peers, introduced both clients, and relayed their client-to-client WebRTC signalling.");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
