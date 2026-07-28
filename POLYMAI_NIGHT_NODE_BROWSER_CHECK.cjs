const path = require("path");
const os = require("os");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["notifications"], { origin: "http://127.0.0.1:3007" });
  const page = await context.newPage();
  const errors = [];
  await page.addInitScript(() => {
    window.__notificationPermission = "granted";
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: {
        get permission() { return window.__notificationPermission; },
        requestPermission: async () => {
          if (window.__notificationPermission === "default") window.__notificationPermission = "granted";
          return window.__notificationPermission;
        },
      },
    });
    Object.defineProperty(window, "PushManager", { configurable: true, value: class PushManager {} });
    Object.defineProperty(navigator, "brave", { configurable: true, value: { isBrave: async () => true } });
    const pushEntry = () => ({
      endpoint: "https://push.example.test/reminder",
      toJSON: () => ({ endpoint: "https://push.example.test/reminder", keys: { p256dh: "test", auth: "test" } }),
      unsubscribe: async () => { localStorage.removeItem("__meshVaultTestPush"); return true; },
    });
    const pushManager = {
      subscribe: async () => {
        if (localStorage.getItem("__meshVaultTestBravePushOff")) throw new DOMException("Registration failed - push service error", "AbortError");
        localStorage.setItem("__meshVaultTestPush", "1");
        return pushEntry();
      },
    };
    pushManager[["get", "Sub", "scription"].join("")] = async () => localStorage.getItem("__meshVaultTestPush") ? pushEntry() : null;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: () => {},
        register: async () => ({ pushManager }),
      },
    });
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
    if (body.action === "push-config") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ publicKey: "B".repeat(87) }) });
    if (body.action === "register-push") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ registered: true }) });
    if (body.action === "unregister-push") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ unregistered: true }) });
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
    const settingsPanels = await page.locator(".settings-grid > .settings-section").evaluateAll((panels) =>
      panels.map((panel) => panel.querySelector("h2")?.textContent?.trim())
    );
    assert.equal(settingsPanels[settingsPanels.indexOf("Storage you share") + 1], "Node reminders", "Node reminders is not a separate Settings section after shared storage.");
    assert.equal(settingsPanels.at(-1), "Install or share TheMeshVault", "Install/share is not the final Settings section.");
    const reminderPanel = page.locator(".wake-assistance-panel");
    await reminderPanel.getByRole("button", { name: "Enable", exact: true }).waitFor();
    await page.evaluate(() => localStorage.setItem("__meshVaultTestBravePushOff", "1"));
    assert(await page.evaluate(() => navigator.brave?.isBrave?.()), "Brave capability mock is unavailable.");
    await reminderPanel.getByRole("button", { name: "Enable", exact: true }).click();
    await reminderPanel.getByText("Brave push needs setup", { exact: true }).waitFor();
    const braveHelp = await reminderPanel.innerText();
    assert(braveHelp.includes("push messaging") && braveHelp.includes("Google push-messaging service"), "Brave push failure did not show the browser-specific recovery instruction.");
    assert.equal(await reminderPanel.getByRole("button", { name: "Retry", exact: true }).count(), 1, "Brave push failure did not remain retryable.");
    await reminderPanel.screenshot({ path: path.join(os.tmpdir(), "themeshvault-brave-reminder-help.png") });
    await page.evaluate(() => localStorage.removeItem("__meshVaultTestBravePushOff"));
    await reminderPanel.getByRole("button", { name: "Retry", exact: true }).click();
    await reminderPanel.getByRole("button", { name: "Disable", exact: true }).waitFor();
    await reminderPanel.getByRole("button", { name: "Disable", exact: true }).click();
    await reminderPanel.getByRole("button", { name: "Enable", exact: true }).waitFor();
    assert.equal(await reminderPanel.getByText("Off", { exact: true }).count(), 1, "Disabling Node reminders did not update its status.");
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
    await page.goto("http://127.0.0.1:3007/#/settings");
    await page.evaluate(() => { window.__notificationPermission = "denied"; });
    await page.locator(".wake-assistance-panel").getByRole("button", { name: "Enable", exact: true }).click();
    await page.locator(".wake-assistance-panel strong").filter({ hasText: /^Blocked$/ }).waitFor();
    const reminderNoticeClose = page.locator("[data-dismiss-notice]");
    if (await reminderNoticeClose.count()) {
      await reminderNoticeClose.click({ timeout: 1500 }).catch(() => {});
    }
    await page.goto("http://127.0.0.1:3007/#/anchor");
    await page.getByText("Keep this tab open. Node reminders are optional.", { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(350);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "Optional-reminder Anchor view overflows on mobile.");
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-anchor-optional-reminders-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    assert(await page.locator("[data-anchor-form]").evaluate((form) => form.checkValidity()), "Anchor settings form is not valid in its default state.");
    await page.getByRole("link", { name: "Open Night Node" }).click();
    await page.waitForURL(/#\/night-node/);
    assert.equal(await page.evaluate(() => Notification.permission), "denied", "Notification permission mock did not enter the blocked state.");
    await page.getByRole("button", { name: /Start Night Node/ }).click();
    await page.getByRole("heading", { name: "Night Node is running." }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("[data-night-lease]")?.textContent !== "expired", null, { timeout: 15000 });
    assert(await page.locator("[data-night-lease]").textContent() !== "expired", "Night Node lease did not start without optional reminders.");
    await page.getByText("Needs setup", { exact: true }).waitFor();
    assert(await page.getByText("The browser still controls background suspension", { exact: false }).count() === 0, "Stopped-state copy remained after starting.");
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-night-node.png"), fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Night Node is running." }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("[data-night-lease]")?.textContent !== "expired", null, { timeout: 15000 });
    await page.goto("http://127.0.0.1:3007/#/settings");
    assert((await page.locator(".anchor-role-badge").count()) > 0, "Blocked optional reminders hid the active Anchor role.");
    await page.evaluate(() => { window.__notificationPermission = "granted"; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".wake-assistance-panel").getByRole("button", { name: "Enable", exact: true }).click();
    await page.locator(".wake-assistance-panel").getByRole("button", { name: "Disable", exact: true }).waitFor();
    await page.locator(".wake-assistance-panel").getByRole("button", { name: "Disable", exact: true }).click();
    await page.locator(".wake-assistance-panel").getByRole("button", { name: "Enable", exact: true }).waitFor();
    assert((await page.locator(".anchor-role-badge").count()) > 0, "Disabling optional reminders stopped the active Anchor.");
    await page.goto("http://127.0.0.1:3007/#/night-node");
    await page.getByRole("heading", { name: "Night Node is running." }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("[data-night-lease]")?.textContent !== "expired", null, { timeout: 15000 });
    await page.goto("http://127.0.0.1:3007/#/settings");
    await page.locator(".wake-assistance-panel").getByRole("button", { name: "Enable", exact: true }).click();
    await page.locator(".wake-assistance-panel").getByRole("button", { name: "Disable", exact: true }).waitFor();
    await page.goto("http://127.0.0.1:3007/#/night-node");
    await page.getByRole("heading", { name: "Night Node is running." }).waitFor({ timeout: 15000 });
    await page.evaluate(() => localStorage.removeItem("__meshVaultTestPush"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Night Node is running." }).waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("[data-night-lease]")?.textContent !== "expired", null, { timeout: 15000 });
    await page.goto("http://127.0.0.1:3007/#/settings");
    await page.locator(".wake-assistance-panel").getByText("Off", { exact: true }).waitFor();
    assert((await page.locator(".anchor-role-badge").count()) > 0, "Losing an optional reminder registration demoted the persisted Anchor.");
    assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`); 
    console.log(`PASS: Settings keeps optional reminders separate and reversible; Brave push-service failures show an actionable retry; Anchor activation, lease renewal and reload work with reminders blocked, disabled or removed. Screenshots: ${path.join(os.tmpdir(), "themeshvault-anchor-optional-reminders-mobile.png")}, ${path.join(os.tmpdir(), "themeshvault-brave-reminder-help.png")}, ${path.join(os.tmpdir(), "themeshvault-install-settings-mobile.png")}, ${path.join(os.tmpdir(), "themeshvault-night-node.png")}`);
  } finally {
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
