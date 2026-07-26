const path = require("path");
const os = require("os");
const fs = require("fs");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const BASE_URL = "http://127.0.0.1:3007";

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|net::ERR|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  return { context, page, errors };
}

async function openRestorePanel(page) {
  await page.goto(`${BASE_URL}/#/onboarding`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-onboard-toggle='restore']").click();
  await page.getByRole("heading", { name: "Restore your vault" }).waitFor();
}

async function expectRestoredVault(page, vaultId) {
  await page.waitForURL(/#\/dashboard/, { timeout: 30000 });
  await page.goto(`${BASE_URL}/#/settings`);
  await page.locator(".vault-identity-panel .mono-id").waitFor({ timeout: 30000 });
  const shownId = await page.locator(".vault-identity-panel .mono-id").textContent();
  assert.equal(shownId.startsWith(vaultId.slice(0, 24)), true, "The restored browser opened a different vault identity.");
}

async function main() {
  const browser = await chromium.launch();
  const sessions = [];
  try {
    const source = await openPage(browser);
    sessions.push(source);
    await source.page.goto(`${BASE_URL}/#/onboarding`, { waitUntil: "domcontentloaded" });
    await source.page.locator("[data-onboard='anonymous']").first().click();
    await source.page.locator("[data-legal-consent] input[name='termsAccepted']").check();
    await source.page.locator("[data-confirm-legal]").click();
    await source.page.waitForURL(/#\/dashboard/, { timeout: 30000 });
    await source.page.goto(`${BASE_URL}/#/recovery`);
    const downloadPromise = source.page.waitForEvent("download");
    await source.page.getByRole("button", { name: "Download complete key file" }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const kitText = await fs.promises.readFile(downloadPath, "utf8");
    const kit = JSON.parse(kitText);
    assert.equal(kit.format, "themeshvault-recovery-kit", "The download is not a complete recovery kit.");
    assert.equal(kit.version, 2, "The recovery kit version is not portable version 2.");
    assert.equal(/^[a-z0-9]{7}(?:-[a-z0-9]{7}){5}$/.test(String(kit.recoveryPhrase || "")), true, "The complete recovery kit does not contain a valid recovery phrase.");
    assert.equal(Boolean(kit.envelope?.cipher && kit.envelope?.salt), true, "The complete recovery kit does not contain its encrypted recovery envelope.");

    const portable = await openPage(browser);
    sessions.push(portable);
    await openRestorePanel(portable.page);
    await portable.page.getByLabel("Mesh Key file").setInputFiles({
      name: "themeshvault-complete-key.json",
      mimeType: "application/json",
      buffer: Buffer["from"](kitText),
    });
    await portable.page.getByText("themeshvault-complete-key.json - ready", { exact: true }).waitFor();
    assert.equal(await portable.page.locator("[data-legacy-key-warning]").isHidden(), true, "A complete key file incorrectly displayed the legacy warning.");
    assert.equal(await portable.page.getByRole("tab", { name: "Mesh Key file" }).getAttribute("aria-selected"), "true", "The simple restore flow did not default to the Mesh Key file.");
    assert(await portable.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "The simple restore flow overflows a 390 px viewport.");
    await portable.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-simple-restore-mobile.png"), fullPage: true });
    await portable.page.getByRole("button", { name: "Restore vault" }).click();
    await expectRestoredVault(portable.page, kit.vaultId);

    const phraseOnly = await openPage(browser);
    sessions.push(phraseOnly);
    await openRestorePanel(phraseOnly.page);
    await phraseOnly.page.getByRole("tab", { name: "Recovery phrase" }).click();
    assert.equal(await phraseOnly.page.locator("[data-recovery-method='file']").isHidden(), true, "The inactive file method remained visible.");
    await phraseOnly.page.getByLabel("Recovery phrase", { exact: true }).fill(kit.recoveryPhrase);
    await phraseOnly.page.getByRole("button", { name: "Restore vault" }).click();
    await expectRestoredVault(phraseOnly.page, kit.vaultId);

    const legacy = await openPage(browser);
    sessions.push(legacy);
    await openRestorePanel(legacy.page);
    const legacyText = JSON.stringify(kit.envelope);
    await legacy.page.getByLabel("Mesh Key file").setInputFiles({
      name: "legacy-version-1-key.json",
      mimeType: "application/json",
      buffer: Buffer["from"](legacyText),
    });
    await legacy.page.getByText("legacy-version-1-key.json - older file", { exact: true }).waitFor();
    await legacy.page.getByText("Older key file", { exact: true }).waitFor();
    await legacy.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-legacy-key-guidance-mobile.png"), fullPage: true });
    await legacy.page.getByRole("button", { name: "Restore vault" }).click();
    await legacy.page.getByText("This older key file also needs its matching recovery phrase.", { exact: true }).waitFor();
    await legacy.page.getByLabel("Older key file recovery phrase").fill(kit.recoveryPhrase);
    await legacy.page.getByRole("button", { name: "Restore vault" }).click();
    await expectRestoredVault(legacy.page, kit.vaultId);

    for (const session of sessions) assert.deepEqual(session.errors, [], `Browser errors: ${session.errors.join(" | ")}`);
    console.log(`PASS: the compact one-method-at-a-time restore UI recovered the same vault from either a complete Mesh Key file or phrase; legacy guidance remained conditional. Screenshot: ${path.join(os.tmpdir(), "themeshvault-simple-restore-mobile.png")}. No recovery secret was logged.`);
  } finally {
    await Promise.all(sessions.map(({ context }) => context.close().catch(() => {})));
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
