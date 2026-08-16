const path = require("path");
const os = require("os");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const BASE_URL = "http://127.0.0.1:3007";
const SHARE_CACHE = "themeshvault-share-inbox-v3";

async function createAnonymousVault(page) {
  await page.goto(`${BASE_URL}/#/onboarding`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-onboard='anonymous']").first().click();
  await page.locator("[data-legal-consent] input[name='termsAccepted']").check();
  await page.locator("[data-confirm-legal]").click();
  await page.waitForURL(/#\/dashboard/, { timeout: 30000 });
}

async function activateCurrentWorker(page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15000 });
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "allow",
  });
  const page = await context.newPage();
  const errors = [];
  const isHandledCoordinationOfflineError = (text) =>
    /TypeError:\s*Failed to fetch[\s\S]*@supabase\/supabase-js[\s\S]*ensureAnonymousSession/.test(String(text || ""));
  page.on("pageerror", (error) => {
    const detail = error.stack || error.message;
    if (!isHandledCoordinationOfflineError(detail)) errors.push(detail);
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/favicon|net::ERR|Failed to load resource/.test(message.text()) &&
      !isHandledCoordinationOfflineError(message.text())
    ) errors.push(message.text());
  });

  try {
    await createAnonymousVault(page);
    await page.getByRole("heading", { name: /Vault overview|Your vault is ready/ }).waitFor();
    const dashboardUpload = await page.locator(".dashboard-head > .button").boundingBox();
    const dashboardHead = await page.locator(".dashboard-head").boundingBox();
    assert(dashboardUpload && dashboardHead, "Dashboard upload layout was not rendered.");
    assert(dashboardUpload.width >= dashboardHead.width - 2, `Dashboard upload is not full width (${dashboardUpload.width}/${dashboardHead.width}).`);
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-dashboard-upload-mobile.png"), fullPage: true });

    await activateCurrentWorker(page);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js")), true, "The current page is not controlled by TheMeshVault service worker.");

    const sharedName = `shared-to-vault-${Date.now()}.txt`;
    await page.evaluate(() => {
      const form = document.createElement("form");
      form.id = "share-target-uat";
      form.method = "POST";
      form.enctype = "multipart/form-data";
      form.action = new URL("./share-target", document.baseURI).href;
      const input = document.createElement("input");
      input.id = "share-target-uat-file";
      input.type = "file";
      input.name = "files";
      form.append(input);
      document.body.append(form);
    });
    await page.locator("#share-target-uat-file").setInputFiles({
      name: sharedName,
      mimeType: "text/plain",
      buffer: Buffer["from"]("TheMeshVault Android share-target production-path test.\n".repeat(128)),
    });
    await page.locator("#share-target-uat").evaluate((form) => form.requestSubmit());
    await page.waitForURL(/#\/drive/, { timeout: 30000 });
    await page.getByText(sharedName, { exact: true }).waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !location.hash.includes("share-target="), null, { timeout: 30000 });

    await page.waitForFunction(async (cacheName) => {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      return keys.every((request) => !new URL(request.url).pathname.endsWith("/manifest"));
    }, SHARE_CACHE, { timeout: 30000 });
    const inboxManifests = await page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      return keys.filter((request) => new URL(request.url).pathname.endsWith("/manifest")).length;
    }, SHARE_CACHE);
    assert.equal(inboxManifests, 0, "A successfully imported shared file remained in the temporary local inbox.");
    await page.locator("[data-dismiss-notice]").click().catch(() => {});
    await page.locator("[data-mesh-key-dismiss]").click().catch(() => {});

    const uploadButton = page.locator(".drive-head .upload-button");
    const uploadActions = page.locator(".drive-head .drive-upload-actions");
    const uploadBounds = await uploadButton.boundingBox();
    const actionsBounds = await uploadActions.boundingBox();
    assert(uploadBounds && actionsBounds, "Drive upload controls were not rendered.");
    assert(uploadBounds.width >= actionsBounds.width - 2, `Drive upload is not full width (${uploadBounds.width}/${actionsBounds.width}).`);
    const cameraInput = page.locator("[data-camera-input]");
    assert.equal(await cameraInput.getAttribute("accept"), "image/*", "Camera picker must accept images.");
    assert.equal(await cameraInput.getAttribute("capture"), "environment", "Camera picker must request the rear camera.");

    await page.locator("[data-new-folder]").click();
    const folderDialog = page.locator("[data-folder-dialog]");
    await folderDialog.getByLabel("Close dialog").click();
    assert.equal(await folderDialog.evaluate((dialog) => dialog.open), false, "Close must dismiss an empty New folder dialog.");
    await page.locator("[data-new-folder]").click();
    await folderDialog.getByRole("button", { name: "Cancel" }).click();
    assert.equal(await folderDialog.evaluate((dialog) => dialog.open), false, "Cancel must dismiss an empty New folder dialog.");

    const cameraName = `camera-into-vault-${Date.now()}.png`;
    await page.goto(`${BASE_URL}/#/drive?camera=1`);
    const cameraDialog = page.locator("[data-camera-launch-dialog]");
    await cameraDialog.getByRole("heading", { name: "Take a photo into your vault" }).waitFor();
    assert(!page.url().includes("camera=1"), "The one-time camera shortcut query was not cleared.");
    const fileChooserPromise = page.waitForEvent("filechooser");
    await cameraDialog.getByRole("button", { name: "Open camera" }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: cameraName,
      mimeType: "image/png",
      buffer: Buffer["from"]("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    });
    await page.getByText(cameraName, { exact: true }).waitFor({ timeout: 60000 });
    const cameraTask = page.locator(".upload-status").filter({ hasText: cameraName });
    await cameraTask.getByText("Stored", { exact: true }).waitFor({ timeout: 60000 });
    await cameraTask.getByRole("button", { name: "Close" }).click();
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-drive-share-camera-mobile.png"), fullPage: true });

    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "Drive overflows horizontally on mobile.");
    assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
    console.log(`PASS: installed-PWA share target imported through the production upload pipeline, the local inbox was cleared after success, camera capture uploaded, and Dashboard/Drive upload actions span the mobile content width. Screenshots: ${path.join(os.tmpdir(), "themeshvault-dashboard-upload-mobile.png")}, ${path.join(os.tmpdir(), "themeshvault-drive-share-camera-mobile.png")}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
