const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const ROOT = __dirname;
const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
};

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG", `${file} is not a PNG.`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function validateFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8"));
  assert(manifest.id, "Manifest needs a stable app id.");
  assert(manifest.name && manifest.short_name, "Manifest needs app names.");
  assert(manifest.start_url && manifest.scope, "Manifest needs start_url and scope.");
  assert(["standalone", "fullscreen", "minimal-ui"].includes(manifest.display), "Manifest must open outside a normal browser tab.");
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((candidate) => candidate.type === "image/png" && candidate.sizes.split(/\s+/).includes(`${size}x${size}`));
    assert(icon, `Manifest needs a ${size}x${size} PNG icon.`);
    assert.deepEqual(pngSize(path.join(ROOT, icon.src)), { width: size, height: size }, `${icon.src} has the wrong dimensions.`);
  }
  assert(manifest.icons.some((icon) => String(icon.purpose || "").split(/\s+/).includes("maskable")), "Manifest needs a maskable icon.");
  assert.deepEqual(pngSize(path.join(ROOT, "assets", "apple-touch-icon.png")), { width: 180, height: 180 });

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert(/rel="manifest"/.test(html), "The page must link its web app manifest.");
  assert(/rel="apple-touch-icon"[^>]+180x180/.test(html), "The page needs an Apple touch icon.");
  assert(/apple-mobile-web-app-capable[^>]+yes/.test(html), "The page must opt into the installed iOS web-app presentation.");

  const worker = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  for (const asset of ["manifest.webmanifest", "pwa-icon-192.png", "pwa-icon-512.png", "apple-touch-icon.png"]) {
    assert(worker.includes(asset), `The offline shell does not include ${asset}.`);
  }
  const workerRegistration = fs.readFileSync(path.join(ROOT, "js", "platform", "service-worker.js"), "utf8");
  assert(workerRegistration.includes("registration.update()"), "Installed clients must check for a newer service worker when opened or resumed.");
  assert(workerRegistration.includes("controllerchange") && workerRegistration.includes("window.location.reload()"), "Installed clients must load the newly activated application version without a manual restart.");
  const runtime = fs.readFileSync(path.join(ROOT, "data", "runtime-config.js"), "utf8");
  const shell = fs.readFileSync(path.join(ROOT, "js", "ui", "app-shell.js"), "utf8");
  assert(/release:\s*Object\.freeze\(\{\s*version:\s*"3\.0",\s*build:\s*37,\s*label:\s*"v3\.0\.37"/.test(runtime), "Runtime configuration must expose one visible release identifier.");
  assert(shell.includes("app-version") && shell.includes("release?.label"), "The private app header must show the runtime release identifier.");
  const bootstrap = fs.readFileSync(path.join(ROOT, "js", "bootstrap.js"), "utf8");
  assert(bootstrap.includes("visibilitychange") && bootstrap.includes("refreshNodePeers"), "The installed app must refresh mesh discovery after returning to the foreground.");
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url, "http://127.0.0.1");
      let relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "") || "index.html";
      if (relative === "share-target") relative = "index.html";
      const resolved = path.resolve(ROOT, relative);
      if (!resolved.startsWith(`${path.resolve(ROOT)}${path.sep}`) && resolved !== path.join(ROOT, "index.html")) {
        response.writeHead(403).end();
        return;
      }
      fs.readFile(resolved, (error, content) => {
        if (error) {
          response.writeHead(404).end("Not found");
          return;
        }
        response.writeHead(200, {
          "content-type": MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream",
          "cache-control": "no-store",
        });
        response.end(content);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function browserInstallability(label, origin, executablePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "themeshvault-pwa-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath,
    serviceWorkers: "allow",
    viewport: { width: 390, height: 844 },
  });
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(`${origin}/#/home`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15000 });

    const client = await context.newCDPSession(page);
    await client.send("Page.enable");
    const manifest = await client.send("Page.getAppManifest");
    const installability = await client.send("Page.getInstallabilityErrors");
    assert.equal(manifest.errors.length, 0, `${label} manifest errors: ${JSON.stringify(manifest.errors)}`);
    assert.equal(installability.installabilityErrors.length, 0, `${label} installability errors: ${JSON.stringify(installability.installabilityErrors)}`);
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js")), true, `${label} is not controlled by sw.js.`);
    assert.equal(JSON.parse(manifest.data).display, "standalone", `${label} did not read standalone display mode.`);
    if (label === "Bundled Chromium") {
      const mirror = await context.newPage();
      await mirror.goto(`${origin}/#/home`, { waitUntil: "domcontentloaded" });
      await mirror.evaluate(() => {
        window.__polymaiPeerRegistryEvents = 0;
        window.addEventListener("meshvault:peer-registry-updated", () => { window.__polymaiPeerRegistryEvents += 1; });
      });
      const sharedPeerId = `profile-sync-${Date.now()}`;
      await page.evaluate(async (peerId) => {
        const { upsertPeer } = await import("/js/network/peer-registry.js");
        upsertPeer({ peerId, nodeName: "PWA profile peer", devicePublicKey: "profile-sync-key", protocolVersion: 3, capacityBytes: 1024 });
      }, sharedPeerId);
      await mirror.waitForFunction(async (peerId) => {
        const { listKnownPeers } = await import("/js/network/peer-registry.js");
        return listKnownPeers().some((peer) => peer.peerId === peerId);
      }, sharedPeerId, { timeout: 5000 });
      assert.equal(await mirror.evaluate(() => window.__polymaiPeerRegistryEvents > 0), true, "A browser tab and its installed PWA did not share discovered peer changes.");
      await mirror.close();
    }
    if (label === "Bundled Chromium") {
      await page.evaluate(() => {
        sessionStorage.removeItem("themeshvault:pwa-install-prompt-dismissed");
        window.__meshVaultStartupInstallCalls = 0;
        const event = new Event("beforeinstallprompt", { cancelable: true });
        Object.defineProperties(event, {
          prompt: { value: async () => { window.__meshVaultStartupInstallCalls += 1; } },
          userChoice: { value: Promise.resolve({ outcome: "accepted", platform: "web" }) },
        });
        window.dispatchEvent(event);
      });
      const startupPrompt = page.locator("[data-pwa-install-prompt]");
      await startupPrompt.waitFor({ state: "visible" });
      await startupPrompt.getByRole("heading", { name: "Open it like an app." }).waitFor();
      await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-pwa-startup-prompt.png"), fullPage: true });
      await startupPrompt.getByRole("button", { name: "Install app" }).click();
      await page.waitForFunction(() => window.__meshVaultStartupInstallCalls === 1);
      await startupPrompt.waitFor({ state: "detached" });
      await page.reload({ waitUntil: "domcontentloaded" });
      assert.equal(await page.locator("[data-pwa-install-prompt]").count(), 0, "Dismissed startup installation prompt returned in the same browser session.");
      await page.evaluate(() => sessionStorage.removeItem("themeshvault:pwa-install-prompt-dismissed"));
      await page.goto(`${origin}/#/onboarding`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(250);
      assert.equal(await page.locator("[data-pwa-install-prompt]").count(), 0, "Startup installation prompt must not cover onboarding.");
    }
    return `${label}: eligible`;
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  validateFiles();
  const server = await startServer();
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const candidates = [
    ["Bundled Chromium", undefined],
    ["Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
    ["Microsoft Edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"],
  ];
  const results = [];
  try {
    for (const [label, executablePath] of candidates) {
      if (executablePath && !fs.existsSync(executablePath)) {
        results.push(`${label}: not installed on this test machine`);
        continue;
      }
      results.push(await browserInstallability(label, origin, executablePath));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log(`PASS: standalone PWA manifest, PNG/Apple icons, early service worker control, startup install prompt/session dismissal and native Chromium installability. ${results.join("; ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
