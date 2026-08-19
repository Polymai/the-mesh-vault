const path = require("path");
const os = require("os");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const BASE_URL = "http://127.0.0.1:3007";
const TEST_SHARD_ID = "b90f3d51e66d4a59e1218c4b2b765d43d8e6bb8732fbf1772dc95512ac461203";

async function createVault(page) {
  await page.goto(`${BASE_URL}/#/onboarding`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-onboard='anonymous']").first().click();
  await page.locator("[data-legal-consent] input[name='termsAccepted']").check();
  await page.locator("[data-confirm-legal]").click();
  await page.waitForURL(/#\/dashboard/, { timeout: 30000 });
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|net::ERR|Failed to load resource|app717-meshvault-api.*blocked by CORS policy/.test(message.text())) errors.push(message.text());
  });
  try {
    await createVault(page);
    await page.goto(`${BASE_URL}/#/settings`);
    assert.equal(await page.getByText("Devices with vault access").count(), 0, "The unfinished trusted-device feature is still visible in Settings.");
    assert.equal(await page.locator("a[href='#/trusted-devices']").count(), 0, "The unfinished trusted-device route is still linked.");

    await page.evaluate(async (shardId) => {
      const { putShard } = await import("/js/storage/fragment-store.js");
      await putShard(shardId, new Uint8Array(4096).fill(71));
    }, TEST_SHARD_ID);
    await page.getByRole("link", { name: "View", exact: true }).click();
    await page.waitForURL(/#\/hosted-storage/);
    await page.getByRole("heading", { name: "Hosted pieces" }).waitFor();
    await page.locator("[data-hosted-storage][aria-busy='false']").waitFor();
    await page.waitForFunction(() => window.scrollY === 0);
    assert.equal(await page.locator(".hosted-piece").count(), 1, "The real locally stored shard was not listed.");
    assert.equal(await page.locator(".hosted-piece strong").getAttribute("title"), TEST_SHARD_ID, "The viewer did not expose the exact local hash identifier.");
    await page.locator(".hosted-piece").getByText("4.0 KB", { exact: true }).waitFor();
    await page.getByText("Why there is no folder link").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "Device access or hosted storage overflows mobile width.");
    const screenshot = path.join(os.tmpdir(), "themeshvault-hosted-pieces-mobile.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
    console.log(`PASS: the unfinished trusted-device feature is absent from Settings, and the in-app Hosted pieces view lists a real 4 KB browser-private encrypted shard by exact hash without claiming an OS folder. Screenshot: ${screenshot}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
