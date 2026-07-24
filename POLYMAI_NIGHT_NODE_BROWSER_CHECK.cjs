const path = require("path");
const os = require("os");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
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
    await page.goto("http://127.0.0.1:3007/#/anchor");
    await page.getByRole("link", { name: "Open Night Node" }).click();
    await page.waitForURL(/#\/night-node/);
    await page.getByRole("button", { name: /Start Night Node/ }).click();
    await page.getByRole("heading", { name: "Keeping this node useful." }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("[data-night-lease]")?.textContent !== "expired", null, { timeout: 15000 });
    assert(await page.locator("[data-night-lease]").textContent() !== "expired", "Night Node lease did not start.");
    assert(await page.getByText("The browser still controls background suspension", { exact: false }).count() === 0, "Stopped-state copy remained after starting.");
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-night-node.png"), fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Keeping this node useful." }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("[data-night-lease]")?.textContent !== "expired", null, { timeout: 15000 });
    await page.getByRole("button", { name: /Stop Night Node/ }).click();
    await page.getByRole("heading", { name: "Turn this device into an anchor." }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator("[data-night-lease]").textContent(), "expired", "Stopping Night Node must expire its lease.");
    assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
    console.log(`PASS: live anonymous vault starts, restores, and stops Night Node leases. Screenshot: ${path.join(os.tmpdir(), "themeshvault-night-node.png")}`);
  } finally {
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
