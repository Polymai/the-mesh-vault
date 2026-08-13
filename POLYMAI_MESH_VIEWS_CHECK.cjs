const path = require("path");
const os = require("os");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const BASE_URL = "http://127.0.0.1:3007";

async function session(browser, viewport = { width: 390, height: 844 }, storageState = undefined) {
  const context = await browser.newContext({ viewport, storageState });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|net::ERR|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  return { context, page, errors };
}

async function createVault(page) {
  await page.goto(`${BASE_URL}/#/onboarding`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-onboard='anonymous']").first().click();
  await page.locator("[data-legal-consent] input[name='termsAccepted']").check();
  await page.locator("[data-confirm-legal]").click();
  await page.waitForURL(/#\/dashboard/, { timeout: 30000 });
}

async function joinStorageNode(page) {
  await page.goto(`${BASE_URL}/#/onboarding`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-onboard-toggle='node']").click();
  await page.locator("[data-onboard='node']").click();
  await page.waitForURL(/#\/settings/, { timeout: 30000 });
  await page.getByRole("heading", { name: "Settings" }).waitFor();
}

async function waitForMode(page, mode) {
  await page.waitForFunction((expected) => {
    const root = document.querySelector("[data-mesh-connections]");
    return root?.dataset.meshGraphMode === expected
      && root.getAttribute("aria-busy") === "false"
      && !!root.dataset.presenceAnimation;
  }, mode, { timeout: 20000 });
}

async function connectedEndpoints(page) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const endpoints = await page.evaluate(async () => {
      const [{ currentNode }, { connectedProtocols }] = await Promise.all([
        import("/js/network/node-service.js"),
        import("/js/network/peer-manager.js"),
      ]);
      const fromNodeId = currentNode()?.id;
      const toNodeId = connectedProtocols().find((peer) => peer.nodeId)?.nodeId;
      return fromNodeId && toNodeId ? { fromNodeId, toNodeId } : null;
    });
    if (endpoints) return endpoints;
    await page.waitForTimeout(250);
  }
  return null;
}

async function dispatchShardPulse(page, endpoints) {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent("meshvault:shard-pulse", { detail }));
  }, endpoints);
}

async function main() {
  const browser = await chromium.launch();
  const sessions = [];
  const topologyHeights = {};
  try {
    const bootstrap = await browser.newContext();
    const bootstrapPage = await bootstrap.newPage();
    await bootstrapPage.goto(`${BASE_URL}/#/onboarding`, { waitUntil: "domcontentloaded" });
    await bootstrapPage.evaluate(async () => (await import("/js/services/supabase.js")).ensureAnonymousSession());
    const sharedCoordinationState = await bootstrap.storageState();
    await bootstrap.close();

    const owner = await session(browser, { width: 390, height: 844 }, sharedCoordinationState);
    sessions.push(owner);
    await createVault(owner.page);

    for (let index = 0; index < 3; index += 1) {
      const helper = await session(browser, { width: 360, height: 780 }, sharedCoordinationState);
      sessions.push(helper);
      await joinStorageNode(helper.page);
    }

    await owner.page.goto(`${BASE_URL}/#/mesh`);
    await owner.page.waitForFunction(async () => {
      const { listKnownPeers } = await import("/js/network/peer-registry.js");
      return listKnownPeers().length >= 2;
    }, null, { timeout: 30000 });
    await owner.page.getByRole("heading", { name: "Live Mesh", exact: true }).waitFor();

    await waitForMode(owner.page, "radial");
    topologyHeights.radial = await owner.page.locator("[data-mesh-connections]").evaluate((element) => element.getBoundingClientRect().height);
    assert.equal(await owner.page.locator(".mesh-connections__mode strong").textContent(), "Radial");
    await owner.page.waitForFunction(() =>
      document.querySelector("[data-mesh-connections]")?.dataset.presenceAnimation === "breathing-halos",
    null, { timeout: 20000 });
    try {
      await owner.page.waitForFunction(() =>
        Number(document.querySelector("[data-mesh-connections]")?.dataset.presencePulseTargets || 0) >= 1,
      null, { timeout: 6000 });
    } catch (error) {
      const diagnostics = await owner.page.evaluate(async () => {
        const [{ listKnownPeers }, { connectedProtocols }] = await Promise.all([
          import("/js/network/peer-registry.js"),
          import("/js/network/peer-manager.js"),
        ]);
        const root = document.querySelector("[data-mesh-connections]");
        return {
          knownPeers: listKnownPeers().map((peer) => peer.peerId),
          connectedPeers: connectedProtocols().map((peer) => peer.nodeId),
          graphNodes: document.querySelectorAll("[data-mesh-connections-canvas] canvas").length,
          presencePulseTargets: root?.dataset.presencePulseTargets || null,
        };
      });
      diagnostics.sessions = await Promise.all(sessions.map(({ page }) => page.evaluate(async () => {
        const [{ currentNode, coordinationStatus }, { connectedProtocols }, { appTable }] = await Promise.all([
          import("/js/network/node-service.js"),
          import("/js/network/peer-manager.js"),
          import("/js/services/supabase.js"),
        ]);
        const node = currentNode();
        const visible = await appTable("nodes").select("id,status,last_seen_at").in("id", [node?.id].filter(Boolean));
        return {
          nodeId: node?.id || null,
          localOnly: node?.coordination_status === "local-only",
          connectedPeers: connectedProtocols().map((peer) => peer.nodeId),
          coordination: coordinationStatus(),
          backendRow: visible.data?.[0] || null,
          backendError: visible.error?.message || null,
        };
      }).catch((sessionError) => ({ error: sessionError.message }))));
      throw new Error(`Presence animation did not include a connected peer: ${JSON.stringify(diagnostics)}. ${error.message}`);
    }
    assert.equal(await owner.page.getByRole("button", { name: "Arrange radial view" }).textContent(), "Arrange");
    assert.equal(await owner.page.getByRole("button", { name: "Fit all nodes" }).textContent(), "Fit");
    assert.equal(await owner.page.getByRole("button", { name: "Show more nodes" }).textContent(), "More");
    await owner.page.getByRole("button", { name: "Show more nodes" }).click();
    await owner.page.waitForFunction(() => document.querySelector(".mesh-scope-toolbar strong")?.textContent === "Sample");
    await owner.page.getByRole("button", { name: "Show fewer nodes" }).click();
    await owner.page.waitForFunction(() => document.querySelector(".mesh-scope-toolbar strong")?.textContent === "Local");
    await waitForMode(owner.page, "radial");
    assert.equal(await owner.page.locator("[data-mesh-connections]").getAttribute("data-transfer-animation"), "real-shard-pulses-only");
    assert.equal(await owner.page.locator(".mesh-transfer-particle").count(), 0, "An idle connection rendered a fake transfer particle.");
    await owner.page.waitForTimeout(1200);
    const technicalDetails = owner.page.locator("details.node-technical").first();
    await technicalDetails.evaluate((element) => { element.open = true; element.dispatchEvent(new Event("toggle")); });
    await owner.page.evaluate(() => {
      window.__polymaiMeshLayout = document.querySelector("[data-mesh-layout]");
      window.__polymaiMeshCanvas = document.querySelector("[data-mesh-connections-canvas] canvas");
    });
    await owner.page.evaluate(async () => {
      const { announce } = await import("/js/state/store.js");
      announce("Mesh stability contract", "info", 0);
    });
    await owner.page.waitForTimeout(250);
    assert.equal(await owner.page.evaluate(() => document.querySelector("[data-mesh-layout]") === window.__polymaiMeshLayout), true, "An unrelated shell update replaced the Live Mesh layout.");
    assert.equal(await owner.page.evaluate(() => document.querySelector("[data-mesh-connections-canvas] canvas") === window.__polymaiMeshCanvas), true, "An unrelated shell update recreated the Cytoscape canvas.");
    assert.equal(await owner.page.locator("details.node-technical").first().evaluate((element) => element.open), true, "An unrelated shell update closed Technical details.");
    await owner.page.evaluate(async () => (await import("/js/state/store.js")).setState({ notice: null }));
    await owner.page.evaluate(async () => {
      const { upsertPeer } = await import("/js/network/peer-registry.js");
      upsertPeer({ peerId: "live-mesh-refresh-contract", nodeName: "Newly discovered node", devicePublicKey: "live-mesh-refresh-key", protocolVersion: 3, capacityBytes: 4096 });
    });
    await owner.page.waitForFunction(() => document.querySelector("[data-mesh-layout]") !== window.__polymaiMeshLayout);
    assert.equal(await owner.page.locator("details.node-technical").first().evaluate((element) => element.open), true, "A newly discovered peer closed Technical details while Live Mesh refreshed.");
    await owner.page.evaluate(async () => (await import("/js/network/peer-registry.js")).removePeer("live-mesh-refresh-contract"));
    const topologyDeduplication = await owner.page.evaluate(async () => {
      const { listTopologyObservations, recordTopologyObservation } = await import("/js/network/topology-registry.js");
      const existing = listTopologyObservations()[0];
      if (!existing) return { available: false };
      let events = 0;
      const count = () => { events += 1; };
      window.addEventListener("meshvault:topology-updated", count);
      const changed = recordTopologyObservation({ ...existing, connectedNodeIds: [...existing.connectedNodeIds].reverse(), observedAt: Date.now() });
      window.removeEventListener("meshvault:topology-updated", count);
      return { available: true, changed, events };
    });
    if (topologyDeduplication.available) {
      assert.equal(topologyDeduplication.changed, false, "An identical heartbeat was classified as a topology change.");
      assert.equal(topologyDeduplication.events, 0, "An identical heartbeat emitted a topology redraw event.");
    }
    const endpoints = await connectedEndpoints(owner.page);
    assert(endpoints?.fromNodeId && endpoints?.toNodeId, `Could not resolve a real connected peer pair for the transfer renderer check: ${JSON.stringify(endpoints)}.`);
    await dispatchShardPulse(owner.page, endpoints);
    const radialParticle = owner.page.locator(".mesh-transfer-particle").first();
    await radialParticle.waitFor({ state: "attached", timeout: 3000 });
    await owner.page.waitForFunction(() => [...document.querySelectorAll(".mesh-transfer-particle")]
      .some((particle) => Number(particle.dataset.progress) > .12 && Number(particle.dataset.progress) < .95), null, { timeout: 3000 });
    await owner.page.waitForFunction(() => document.querySelectorAll(".mesh-transfer-particle").length === 0, null, { timeout: 3000 });
    await owner.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-mesh-radial-mobile.png"), fullPage: true });

    await owner.page.getByRole("button", { name: "Route view" }).click();
    await waitForMode(owner.page, "routes");
    topologyHeights.routes = await owner.page.locator("[data-mesh-connections]").evaluate((element) => element.getBoundingClientRect().height);
    assert.equal(await owner.page.locator(".mesh-connections__mode strong").textContent(), "Routes");
    assert.equal(await owner.page.locator("[data-mesh-connections]").getAttribute("data-link-geometry"), "curved", "Routes did not use its distinct curved-link geometry.");
    assert.equal(await owner.page.locator("[data-mesh-connections]").getAttribute("data-route-layout"), "adaptive-arcs", "Routes reverted to the old standing level layout.");
    await owner.page.waitForTimeout(800);
    await owner.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-mesh-routes-mobile.png"), fullPage: true });

    await owner.page.getByRole("button", { name: "Cluster view" }).click();
    await waitForMode(owner.page, "clusters");
    topologyHeights.clusters = await owner.page.locator("[data-mesh-connections]").evaluate((element) => element.getBoundingClientRect().height);
    assert.equal(await owner.page.locator(".mesh-connections__mode strong").textContent(), "Clusters");
    await owner.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-mesh-clusters-mobile.png"), fullPage: true });

    await owner.page.getByRole("button", { name: "3D universe view" }).click();
    await owner.page.locator("[data-mesh-universe] canvas").waitFor({ timeout: 10000 });
    topologyHeights.universe = await owner.page.locator("[data-mesh-universe]").evaluate((element) => element.getBoundingClientRect().height);
    assert.equal(await owner.page.locator("[data-mesh-universe]").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(4, 11, 19)", "3D universe lost its dark space surface.");
    const pinchZoom = await owner.page.locator("[data-mesh-universe] canvas").evaluate((canvas) => {
      const root = canvas.closest("[data-mesh-universe]");
      const rect = canvas.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dispatch = (type, pointerId, clientX, clientY, isPrimary = false) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId, pointerType: "touch", isPrimary, clientX, clientY,
      }));
      const before = Number(root.dataset.cameraZoom);
      dispatch("pointerdown", 71, centerX - 40, centerY, true);
      dispatch("pointerdown", 72, centerX + 40, centerY);
      dispatch("pointermove", 72, centerX + 100, centerY);
      dispatch("pointerup", 72, centerX + 100, centerY);
      dispatch("pointerup", 71, centerX - 40, centerY, true);
      return {
        before,
        after: Number(root.dataset.cameraZoom),
        gesture: root.dataset.touchGesture,
        touchAction: getComputedStyle(canvas).touchAction,
      };
    });
    assert.equal(pinchZoom.gesture, "drag-and-pinch", "3D universe did not advertise its mobile gesture contract.");
    assert.equal(pinchZoom.touchAction, "none", "The browser intercepted the 3D universe pinch gesture.");
    assert(pinchZoom.after > pinchZoom.before * 1.25, `Two-finger pinch did not zoom the 3D universe: ${JSON.stringify(pinchZoom)}.`);
    assert.equal(await owner.page.getByRole("button", { name: "Zoom in" }).evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return button === topElement || button.contains(topElement);
    }), true, "The mobile node-scope toolbar covered the 3D zoom controls.");
    const heightValues = Object.values(topologyHeights);
    assert(Math.max(...heightValues) - Math.min(...heightValues) <= 1, `Live Mesh modes do not share one browser height: ${JSON.stringify(topologyHeights)}.`);
    await owner.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-mesh-universe-mobile.png"), fullPage: true });

    await owner.page.getByRole("tab", { name: "File locations" }).click();
    await owner.page.locator(".data-globe canvas").first().waitFor({ timeout: 20000 });
    assert.equal(await owner.page.locator("[data-data-globe]").getAttribute("data-transfer-animation"), "real-shard-pulses-only");
    assert.equal(await owner.page.locator("[data-data-globe]").evaluate((element) => element.classList.contains("has-live-transfer")), false, "The idle globe claimed an active transfer.");
    await dispatchShardPulse(owner.page, endpoints);
    await owner.page.waitForFunction(() => document.querySelector("[data-data-globe]")?.classList.contains("has-live-transfer"), null, { timeout: 3000 });
    await owner.page.waitForFunction(() => !document.querySelector("[data-data-globe]")?.classList.contains("has-live-transfer"), null, { timeout: 4000 });
    assert.notEqual(await owner.page.locator(".data-globe").evaluate((element) => getComputedStyle(element).backgroundImage), "none", "File locations lost the shared light visual surface.");
    await owner.page.evaluate(() => {
      window.__polymaiGlobeCanvas = document.querySelector(".data-globe canvas");
      window.dispatchEvent(new CustomEvent("meshvault:topology-updated"));
    });
    await owner.page.waitForTimeout(500);
    assert.equal(await owner.page.evaluate(() => document.querySelector(".data-globe canvas") === window.__polymaiGlobeCanvas), true, "A topology update recreated the globe WebGL canvas.");
    await owner.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-file-locations-light-mobile.png"), fullPage: true });
    await owner.page.getByRole("tab", { name: "Network" }).click();
    await owner.page.getByRole("button", { name: "Cluster view" }).click();
    await waitForMode(owner.page, "clusters");

    const mobileMetrics = await owner.page.evaluate(() => ({
      noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      stageHeight: document.querySelector("[data-mesh-connections]")?.getBoundingClientRect().height || 0,
      stageBottom: document.querySelector("[data-mesh-connections]")?.getBoundingClientRect().bottom || 0,
      viewportHeight: window.innerHeight,
      labelStyle: document.querySelector("[data-mesh-connections]")?.dataset.labelStyle,
      buttons: [...document.querySelectorAll("[data-mesh-display]")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
      canvasCount: document.querySelectorAll("[data-mesh-connections-canvas] canvas").length,
    }));
    assert.equal(mobileMetrics.noOverflow, true, "Live Mesh overflows the mobile viewport.");
    assert(mobileMetrics.stageHeight >= 320 && mobileMetrics.stageHeight <= 360, `The graph does not use the compact mobile browser height: ${mobileMetrics.stageHeight}px.`);
    assert(mobileMetrics.stageBottom <= mobileMetrics.viewportHeight + 2, `The graph extends below the first phone viewport (${mobileMetrics.stageBottom}px > ${mobileMetrics.viewportHeight}px).`);
    assert.equal(mobileMetrics.labelStyle, "plain", "Node labels reverted to opaque background boxes.");
    assert(mobileMetrics.buttons.every(({ width, height }) => width <= 36 && height <= 36), `Graph mode icons are too large: ${JSON.stringify(mobileMetrics.buttons)}`);
    assert(mobileMetrics.canvasCount > 0, "Cytoscape did not render a graph canvas.");

    await owner.page.setViewportSize({ width: 1440, height: 900 });
    await owner.page.getByRole("button", { name: "Radial view" }).click();
    await waitForMode(owner.page, "radial");
    await owner.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-mesh-radial-desktop.png"), fullPage: true });

    for (const current of sessions) assert.deepEqual(current.errors, [], `Browser errors: ${current.errors.join(" | ")}`);
    console.log(`PASS: four real browser profiles rendered distinct responsive Radial, Routes, Clusters and 3D Universe views over the same observed mesh. Idle links stayed static, a real shard-pulse contract moved a packet across Cytoscape, and the globe only entered transfer mode for that pulse while preserving the exact WebGL canvas through a forced topology update. Screenshots: ${path.join(os.tmpdir(), "themeshvault-mesh-radial-mobile.png")}, ${path.join(os.tmpdir(), "themeshvault-mesh-routes-mobile.png")}, ${path.join(os.tmpdir(), "themeshvault-mesh-clusters-mobile.png")}, ${path.join(os.tmpdir(), "themeshvault-mesh-universe-mobile.png")}.`);
  } finally {
    await Promise.all(sessions.map(({ context }) => context.close().catch(() => {})));
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
