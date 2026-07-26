const path = require("path");
const os = require("os");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  await page.addInitScript(() => {
    window.__meshVaultInstallPromptCalls = 0;
    window.__meshVaultSharedAppData = null;
    window.__meshVaultCopiedAppLink = null;
    Object.defineProperty(navigator, "share", { configurable: true, value: async (data) => { window.__meshVaultSharedAppData = data; } });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { window.__meshVaultCopiedAppLink = value; } } });
    window.addEventListener("DOMContentLoaded", () => {
      const installEvent = new Event("beforeinstallprompt", { cancelable: true });
      Object.defineProperties(installEvent, {
        prompt: {
          value: async () => {
            window.__meshVaultInstallPromptCalls += 1;
            window.setTimeout(() => window.dispatchEvent(new Event("appinstalled")), 0);
          },
        },
        userChoice: { value: Promise.resolve({ outcome: "accepted", platform: "web" }) },
      });
      window.dispatchEvent(installEvent);
    });
  });
  await page.route("**/app717-meshvault-api", async (route) => {
    const body = route.request().postDataJSON?.() || {};
    if (body.action === "push-config") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ publicKey: null, setupRequired: true }) });
    return route.continue();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/favicon|net::ERR|Failed to load resource/.test(message.text())) errors.push(message.text()); });
  try {
    await page.goto("http://127.0.0.1:3007/#/onboarding", { waitUntil: "domcontentloaded" });
    await page.locator("[data-onboard='anonymous']").first().click();
    await page.locator("[data-legal-consent] input[name='termsAccepted']").check();
    await page.locator("[data-confirm-legal]").click();
    await page.waitForURL(/#\/dashboard/, { timeout: 30000 });
    await page.goto("http://127.0.0.1:3007/#/settings");
    await page.getByRole("heading", { name: "Install or share TheMeshVault" }).waitFor();
    const expectedAppUrl = "https://polymai.github.io/the-mesh-vault/#/home";
    const publicAppLink = page.locator(".pwa-public-link");
    assert.equal(await publicAppLink.getAttribute("href"), expectedAppUrl, "Settings did not expose the configured public app link.");
    await page.getByRole("button", { name: "Share TheMeshVault" }).click();
    assert.equal(await page.evaluate(() => window.__meshVaultSharedAppData?.url), expectedAppUrl, "Native app sharing received the wrong URL.");
    await page.getByRole("button", { name: "Copy link" }).click();
    assert.equal(await page.evaluate(() => window.__meshVaultCopiedAppLink), expectedAppUrl, "Copy link received the wrong URL.");
    const desktopInstallIcon = await page.locator(".pwa-install-icon svg").boundingBox();
    assert(desktopInstallIcon && desktopInstallIcon.width <= 24 && desktopInstallIcon.height <= 24, `Install icon expanded unexpectedly on desktop: ${JSON.stringify(desktopInstallIcon)}`);
    assert.equal(await page.locator(".pwa-install-icon svg rect").evaluate((element) => getComputedStyle(element).fill), "none", "Install icon rendered as a filled black rectangle.");
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-install-settings-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(450);
    await page.getByRole("button", { name: "Install", exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "Install settings overflow on mobile.");
    const installBounds = await page.evaluate(() => {
      const selectors = [".pwa-install-panel", ".pwa-install-panel h2", ".pwa-install-row", "[data-install-pwa]"];
      return selectors.map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { selector, left: rect.left, right: rect.right, viewport: innerWidth };
      });
    });
    assert(installBounds.every((item) => item.left >= 0 && item.right <= item.viewport), `Install controls are clipped: ${JSON.stringify(installBounds)}`);
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-install-settings-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Install", exact: true }).click();
    await page.getByText("Open it from your home screen or app list.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__meshVaultInstallPromptCalls), 1, "The trusted browser install prompt was not called exactly once.");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("http://127.0.0.1:3007/#/anchor");
    await page.getByRole("link", { name: "Open Night Node" }).click();
    await page.waitForURL(/#\/night-node/);
    await page.getByRole("button", { name: /Start Night Node/ }).click();
    await page.getByRole("heading", { name: "Night Node is running." }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("[data-night-lease]")?.textContent !== "expired", null, { timeout: 15000 });
    assert(await page.locator("[data-night-lease]").textContent() !== "expired", "Night Node lease did not start.");
    assert(await page.getByText("The browser still controls background suspension", { exact: false }).count() === 0, "Stopped-state copy remained after starting.");
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-night-node.png"), fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Night Node is running." }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("[data-night-lease]")?.textContent !== "expired", null, { timeout: 15000 });
    await page.getByRole("button", { name: /Stop Night Node/ }).click();
    await page.getByRole("heading", { name: "Run an overnight Anchor." }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator("[data-night-lease]").textContent(), "expired", "Stopping Night Node must expire its lease.");
    assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
    console.log(`PASS: Settings invokes the trusted PWA install prompt without mobile overflow; live anonymous vault starts, restores, and stops Night Node leases. Screenshots: ${path.join(os.tmpdir(), "themeshvault-install-settings-mobile.png")}, ${path.join(os.tmpdir(), "themeshvault-night-node.png")}`);
  } finally {
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
