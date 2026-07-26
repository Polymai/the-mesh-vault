const path = require("path");
const os = require("os");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const BASE_URL = "http://127.0.0.1:3007";

async function session(browser, viewport = { width: 390, height: 844 }) {
  const context = await browser.newContext({ viewport });
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
    return root?.dataset.meshGraphMode === expected && root.getAttribute("aria-busy") === "false";
  }, mode, { timeout: 20000 });
}

async function connectedEndpoints(page) {
  await page.waitForFunction(async () => {
    const { connectedProtocols } = await import("/js/network/peer-manager.js");
    return connectedProtocols().length > 0;
  }, null, { timeout: 30000 });
  return page.evaluate(async () => {
    const [{ currentNode }, { connectedProtocols }] = await Promise.all([
      import("/js/network/node-service.js"),
      import("/js/network/peer-manager.js"),
    ]);
    return { fromNodeId: currentNode()?.id, toNodeId: connectedProtocols()[0]?.nodeId };
  });
}

async function dispatchShardPulse(page, endpoints) {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent("meshvault:shard-pulse", { detail }));
  }, endpoints);
}

async function main() {
  const browser = await chromium.launch();
  const sessions = [];
  try {
    const owner = await session(browser);
    sessions.push(owner);
    await createVault(owner.page);

    for (let index = 0; index < 3; index += 1) {
      const helper = await session(browser, { width: 360, height: 780 });
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
    assert.equal(await owner.page.locator(".mesh-connections__mode strong").textContent(), "Radial");
    assert.equal(await owner.page.locator("[data-mesh-connections]").getAttribute("data-transfer-animation"), "real-shard-pulses-only");
    assert.equal(await owner.page.locator(".mesh-transfer-particle").count(), 0, "An idle connection rendered a fake transfer particle.");
    const endpoints = await connectedEndpoints(owner.page);
    assert(endpoints.fromNodeId && endpoints.toNodeId, "Could not resolve a real connected peer pair for the transfer renderer check.");
    await dispatchShardPulse(owner.page, endpoints);
    const radialParticle = owner.page.locator(".mesh-transfer-particle").first();
    await radialParticle.waitFor({ state: "attached", timeout: 3000 });
    await owner.page.waitForFunction(() => [...document.querySelectorAll(".mesh-transfer-particle")]
      .some((particle) => Number(particle.dataset.progress) > .12 && Number(particle.dataset.progress) < .95), null, { timeout: 3000 });
    await owner.page.waitForFunction(() => document.querySelectorAll(".mesh-transfer-particle").length === 0, null, { timeout: 3000 });
    await owner.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-mesh-radial-mobile.png"), fullPage: true });

    await owner.page.getByRole("button", { name: "Route view" }).click();
    await waitForMode(owner.page, "routes");
    assert.equal(await owner.page.locator(".mesh-connections__mode strong").textContent(), "Routes");
    assert.equal(await owner.page.locator("[data-mesh-connections]").getAttribute("data-link-geometry"), "curved", "Routes did not use its distinct curved-link geometry.");
    await owner.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-mesh-routes-mobile.png"), fullPage: true });

    await owner.page.getByRole("button", { name: "Cluster view" }).click();
    await waitForMode(owner.page, "clusters");
    assert.equal(await owner.page.locator(".mesh-connections__mode strong").textContent(), "Clusters");
    await owner.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-mesh-clusters-mobile.png"), fullPage: true });

    await owner.page.getByRole("button", { name: "3D universe view" }).click();
    await owner.page.locator("[data-mesh-universe] canvas").waitFor({ timeout: 10000 });
    assert.equal(await owner.page.locator("[data-mesh-universe]").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(4, 11, 19)", "3D universe lost its dark space surface.");
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
      buttons: [...document.querySelectorAll("[data-mesh-display]")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
      canvasCount: document.querySelectorAll("[data-mesh-connections-canvas] canvas").length,
    }));
    assert.equal(mobileMetrics.noOverflow, true, "Live Mesh overflows the mobile viewport.");
    assert(mobileMetrics.stageHeight >= 600, `The graph is too short on mobile: ${mobileMetrics.stageHeight}px.`);
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
