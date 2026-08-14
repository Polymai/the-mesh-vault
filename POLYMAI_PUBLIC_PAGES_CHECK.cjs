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
    await page.getByRole("heading", { name: "A private cloud, built from spare devices." }).waitFor();
    assert((await page.locator(".hero-media").evaluate((element) => getComputedStyle(element).backgroundImage)).includes("meshvault-hero.webp"), "Existing hero asset is not used.");
    assert.equal(await page.locator(".mesh-story__stage").count(), 3, "Home must explain the mesh in one three-stage visual.");
    assert.equal(await page.locator(".landing-paths article").count(), 2, "Home must expose the storage and contribution paths.");
    assert.equal(await page.locator(".landing-steps").count(), 0, "The old generic three-step text section remains.");
    await page.getByRole("link", { name: "See how it works" }).click();
    await page.waitForTimeout(500);
    assert((await page.locator("#mesh-in-one-look").boundingBox()).y < 170, "How it works did not scroll to the visual explanation.");
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator(".public-nav [data-scroll-target='mesh-in-one-look']").click();
    await page.waitForTimeout(500);
    assert((await page.locator("#mesh-in-one-look").boundingBox()).y < 170, "Header How it works did not scroll to the visual explanation.");
    assert.equal(await page.getByText("Upload photos, videos, documents or backups.").count(), 0, "Old long-form landing copy remains.");
    await page.screenshot({ path: path.join(screenshots, "public-home-desktop.png"), fullPage: true });

    await page.getByRole("link", { name: "Create my vault" }).first().click();
    await page.locator("[data-onboard='anonymous']").first().click();
    assert(await page.locator("[data-legal-consent]").evaluate((element) => element.open), "Create vault did not open the legal agreement.");
    const agreementText = await page.locator("[data-legal-consent]").innerText();
    assert(!agreementText.includes("Supabase"), "The first-run agreement contains infrastructure detail that belongs in the public documentation.");
    assert(agreementText.length < 360, `The first-run agreement is still too verbose (${agreementText.length} characters).`);
    assert(agreementText.includes("Save your Mesh Key."), "The compact agreement lost its essential recovery warning.");
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
        const simpleOverview = await page.locator(".architecture-simple").innerText();
        assert(simpleOverview.includes("Save files. Share spare space."), "Security is missing the plain-language service overview.");
        assert(simpleOverview.includes("Your own photos and apps stay untouched."), "Security does not explain what shared phone storage leaves untouched.");
        assert(simpleOverview.includes("The readable file is not stored in Supabase Storage."), "Security overview does not explain Supabase's simple data boundary.");
        await page.locator(".architecture-simple").screenshot({ path: path.join(screenshots, "public-security-simple-desktop.png") });
        const backbone = await page.locator("#document-supabase-backbone").innerText();
        assert(backbone.toLowerCase().includes("operationally important"), "Security does not state Supabase's current operational importance.");
        assert(backbone.includes("no secret-key lookup occurs"), "Security does not disclose the protocol-v3 Mesh Key boundary.");
        assert(backbone.includes("public-key-pinned WSS Backbone"), "Security omits the verified Backbone cold-start boundary.");
        assert.equal(await page.locator("#document-supabase-backbone [data-supabase-disclosure]").count(), 1, "Security is missing the structured Supabase data map.");
        assert.equal(await page.locator(".architecture-process").count(), 4, "Security must render the key, Android boundary, upload and recovery process diagrams.");
        const processText = await page.locator(".architecture-process").allInnerTexts();
        assert(processText.join(" ").includes("app-scoped IndexedDB"), "Key diagram does not show local at-rest storage.");
        assert(processText.join(" ").includes("AES-256-GCM"), "Process diagrams do not identify the encryption primitive.");
        assert(processText.join(" ").includes("Every layer must verify"), "Recovery diagram does not show the verification gate.");
        assert(processText.join(" ").includes("background node have different authority"), "Security does not show the Android native key boundary.");
        await page.locator(".architecture-process--keys").screenshot({ path: path.join(screenshots, "public-security-keys-desktop.png") });
        await page.locator(".architecture-process--upload").screenshot({ path: path.join(screenshots, "public-security-upload-desktop.png") });
        await page.locator(".architecture-process--recovery").screenshot({ path: path.join(screenshots, "public-security-recovery-desktop.png") });
        await page.locator(".architecture-process--native").screenshot({ path: path.join(screenshots, "public-security-android-desktop.png") });
      }
      if (route === "privacy") {
        const noAccount = await page.locator("#document-anonymous-first").innerText();
        assert(noAccount.includes("no named account required"), "Privacy does not distinguish no-account access from anonymity.");
        assert(noAccount.includes("not legal or network anonymity"), "Privacy overstates anonymity.");
        const coordination = await page.locator("#document-coordination-data").innerText();
        assert(coordination.includes("current Supabase backbone"), "Privacy no longer explains the hosted coordination provider.");
        assert(coordination.includes("does not use Supabase Storage"), "Privacy no longer states the Supabase file-content boundary.");
        assert.equal(await page.locator("#document-coordination-data [data-supabase-disclosure]").count(), 1, "Privacy is missing the structured Supabase data map.");
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
    await mobile.goto("http://127.0.0.1:3007/#/home", { waitUntil: "domcontentloaded" });
    await mobile.locator("[data-public-menu-toggle]").click();
    await mobile.locator(".public-sidebar [data-scroll-target='mesh-in-one-look']").click();
    await mobile.waitForTimeout(500);
    assert((await mobile.locator("#mesh-in-one-look").boundingBox()).y < 150, "Mobile How it works did not scroll to the visual explanation.");
    assert(!(await mobile.locator("[data-public-menu]").evaluate((element) => element.classList.contains("is-open"))), "Mobile menu stayed open after the explanation link.");
    await mobile.goto("http://127.0.0.1:3007/#/onboarding", { waitUntil: "domcontentloaded" });
    await mobile.locator("[data-onboard='anonymous']").first().click();
    const mobileAgreement = await mobile.locator("[data-legal-consent]").boundingBox();
    assert(mobileAgreement.width <= 390 && mobileAgreement.height < 700, `Compact agreement does not fit the phone viewport: ${JSON.stringify(mobileAgreement)}`);
    await mobile.screenshot({ path: path.join(screenshots, "vault-terms-dialog-mobile.png"), fullPage: true });
    await mobile.locator("[data-close-legal]").first().click();
    await mobile.goto("http://127.0.0.1:3007/#/security", { waitUntil: "domcontentloaded" });
    await mobile.locator(".architecture-simple").screenshot({ path: path.join(screenshots, "public-security-simple-mobile.png") });
    assert.equal(await mobile.locator(".architecture-process").count(), 4, "Mobile Security lost one or more process diagrams.");
    for (const kind of ["keys", "native", "upload", "recovery"]) {
      const diagram = mobile.locator(`.architecture-process--${kind}`);
      const box = await diagram.boundingBox();
      assert(box.width <= 390, `${kind} process diagram is wider than the mobile viewport.`);
      assert(await diagram.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), `${kind} process diagram has internal horizontal overflow.`);
      await diagram.screenshot({ path: path.join(screenshots, `public-security-${kind}-mobile.png`) });
    }
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
