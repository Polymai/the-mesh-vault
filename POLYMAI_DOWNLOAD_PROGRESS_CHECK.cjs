const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const BASE_URL = "http://127.0.0.1:3007";

async function createAnonymousVault(page) {
  await page.goto(`${BASE_URL}/#/onboarding`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-onboard='anonymous']").first().click();
  await page.locator("[data-legal-consent] input[name='termsAccepted']").check();
  await page.locator("[data-confirm-legal]").click();
  await page.waitForURL(/#\/dashboard/, { timeout: 30000 });
}

async function main() {
  const source = fs.readFileSync(path.join(process.cwd(), "js", "flows", "download-flow.js"), "utf8");
  const driveSource = fs.readFileSync(path.join(process.cwd(), "js", "views", "drive-view.js"), "utf8");
  for (const phase of ["finding", "choosing", "retrieving", "reconstructing", "decrypting", "verifying", "saving"]) {
    assert(source.includes(`task.phase("${phase}"`), `Download flow does not report the ${phase} phase.`);
  }
  assert(source.includes("Exact recovery verified"), "Successful recovery no longer reports exact verification.");
  assert(source.includes("signal: task.signal"), "Shard retrieval is not wired to download cancellation.");
  assert(driveSource.includes('error?.name !== "AbortError"'), "A user-cancelled download is still surfaced as an application error.");

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await createAnonymousVault(page);
    await page.goto(`${BASE_URL}/#/drive`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "My Drive" }).waitFor();
    await page.evaluate(async () => {
      const { createTask } = await import("/js/ui/task-state.js");
      const task = createTask("Recovering file", 60000, {
        kind: "download",
        fileName: "family-photo.jpg",
        phase: "finding",
        totalSegments: 4,
        segmentIndex: 2,
        preventUnload: true,
        autoDismissMs: 60000,
      });
      task.signal.addEventListener("abort", () => {
        window.__downloadCancelled = true;
        task.cancelled("Download cancelled");
      }, { once: true });
      task.phase("retrieving", "Received 5 of 8 required shards", { progress: .42 });
    });

    const popup = page.locator("[data-download-status]");
    await popup.waitFor();
    assert.equal(await popup.getAttribute("aria-label"), "Download progress");
    assert.equal(await popup.locator(".upload-status__head strong").textContent(), "family-photo.jpg");
    assert.equal(await popup.locator(".upload-status__head b").textContent(), "42%");
    assert.equal(await popup.locator(".upload-status__meta").textContent().then((text) => text.includes("Segment 2 of 4")), true);
    assert.equal(await popup.locator(".download-stages li").count(), 5);
    const bounds = await popup.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, "Download popup overflows the phone viewport.");
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-download-progress-mobile.png"), fullPage: false });

    await popup.getByRole("button", { name: "Cancel download" }).click();
    await page.waitForFunction(() => window.__downloadCancelled === true);
    await page.getByText("Download cancelled", { exact: true }).first().waitFor();

    await page.evaluate(async () => {
      const { createTask } = await import("/js/ui/task-state.js");
      const task = createTask("Recovering file", 60000, {
        kind: "download",
        fileName: "temporarily-unavailable.zip",
        phase: "retrieving",
        totalSegments: 2,
        segmentIndex: 1,
      });
      task.fail(new Error("Only 3 of 8 required shards are currently reachable."));
    });
    await page.getByText("Only 3 of 8 required shards are currently reachable.", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "Close" }).last().click();

    await page.evaluate(async () => {
      const { createTask } = await import("/js/ui/task-state.js");
      const task = createTask("Recovering file", 60000, {
        kind: "download",
        fileName: "verified-document.pdf",
        phase: "verifying",
        totalSegments: 3,
        segmentIndex: 3,
        autoDismissMs: 60000,
      });
      task.done("Exact recovery verified");
    });
    await page.getByText("Exact recovery verified", { exact: true }).first().waitFor();
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(`PASS: truthful mobile download popup reports all recovery phases, segment/shard progress, cancellation, an actionable shard-shortage failure and exact byte-recovery success. Screenshot: ${path.join(os.tmpdir(), "themeshvault-download-progress-mobile.png")}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
