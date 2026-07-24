const path = require("path");
const os = require("os");
const assert = require("assert");
const fs = require("fs");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

async function main() {
  const browser = await chromium.launch();
  const errors = [];
  const screenshots = path.join(process.cwd(), ".polymai", "visual-check");
  fs.mkdirSync(screenshots, { recursive: true });
  const watch = (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource|ERR_/.test(message.text())) errors.push(message.text());
    });
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    watch(page);
    await page.goto("http://127.0.0.1:3007/#/home", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Your files\. Encrypted/ }).waitFor();
    assert((await page.locator(".hero-media").evaluate((element) => getComputedStyle(element).backgroundImage)).includes("meshvault-hero.webp"), "Existing hero asset is not used.");
    assert.equal(await page.locator(".landing-steps article").count(), 3, "Home must keep the explanation to three short steps.");
    assert.equal(await page.getByText("Upload photos, videos, documents or backups.").count(), 0, "Old long-form landing copy remains.");
    await page.screenshot({ path: path.join(screenshots, "public-home-desktop.png"), fullPage: true });

    await page.getByRole("link", { name: "Create my vault" }).first().click();
    await page.locator("[data-onboard='anonymous']").first().click();
    assert(await page.locator("[data-legal-consent]").evaluate((element) => element.open), "Create vault did not open the legal agreement.");
    assert(await page.locator("[data-confirm-legal]").isDisabled(), "Create must be disabled before explicit Terms acceptance.");
    await page.locator("input[name='termsAccepted']").check();
    assert(!(await page.locator("[data-confirm-legal]").isDisabled()), "Explicit acceptance did not enable vault creation.");
    assert(await page.locator("[data-legal-consent] a[href='#/terms']").count(), "Terms link is missing from the agreement.");
    assert(await page.locator("[data-legal-consent] a[href='#/privacy']").count(), "Privacy link is missing from the agreement.");
    await page.screenshot({ path: path.join(screenshots, "vault-terms-dialog-desktop.png"), fullPage: true });
    await page.locator("[data-close-legal]").first().click();
    assert(!(await page.locator("[data-legal-consent]").evaluate((element) => element.open)), "Agreement did not close.");

    for (const route of ["security", "terms", "privacy"]) {
      await page.goto(`http://127.0.0.1:3007/#/${route}`, { waitUntil: "domcontentloaded" });
      await page.locator(`[data-document-id="${route}"]`).waitFor();
      assert((await page.locator(".document-section").count()) >= 8, `${route} document is unexpectedly incomplete.`);
      assert.equal(await page.locator(".public-footer a").count(), 3, `${route} footer does not expose all public documents.`);
      if (route === "security") {
        const backbone = await page.locator("#document-supabase-backbone").innerText();
        assert(backbone.includes("Operationally important today."), "Security does not state Supabase's current operational importance.");
        assert(backbone.includes("The phrase and decrypted private material are not sent."), "Security does not disclose the recovery-cache data boundary.");
      }
      if (route === "privacy") {
        const noAccount = await page.locator("#document-anonymous-first").innerText();
        assert(noAccount.includes("no named account required"), "Privacy does not distinguish no-account access from anonymity.");
        assert(noAccount.includes("not legal or network anonymity"), "Privacy overstates anonymity.");
      }
    }
    await page.screenshot({ path: path.join(screenshots, "public-privacy-desktop.png"), fullPage: true });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    watch(mobile);
    for (const route of ["home", "security", "terms", "privacy"]) {
      await mobile.goto(`http://127.0.0.1:3007/#/${route}`, { waitUntil: "domcontentloaded" });
      const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(overflow <= 1, `${route} has ${overflow}px mobile horizontal overflow.`);
    }
    await mobile.goto("http://127.0.0.1:3007/#/security", { waitUntil: "domcontentloaded" });
    await mobile.locator("[data-public-menu-toggle]").click();
    assert(await mobile.locator("[data-public-menu]").evaluate((element) => element.classList.contains("is-open")), "Public mobile document menu did not open.");
    await mobile.screenshot({ path: path.join(screenshots, "public-security-mobile.png"), fullPage: true });
    const directContext = await browser.newContext();
    const direct = await directContext.newPage({ viewport: { width: 390, height: 844 } });
    watch(direct);
    await direct.goto("http://127.0.0.1:3007/#/security", { waitUntil: "domcontentloaded" });
    await direct.locator("#document-supabase-backbone").waitFor();
    await direct.waitForTimeout(1200);
    assert.equal(new URL(direct.url()).hash, "#/security", "A fresh direct Security link was redirected away from the public document.");
    await directContext.close();
    assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
    console.log("PASS: concise home, legal agreement, direct public documents, Supabase/pseudonymity disclosure, footer and mobile layout.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
