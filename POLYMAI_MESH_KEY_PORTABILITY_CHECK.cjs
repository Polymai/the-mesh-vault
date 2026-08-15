const path = require("path");
const os = require("os");
const fs = require("fs");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const BASE_URL = "http://127.0.0.1:3007";
const ZERO_ROOT_VECTOR = Object.freeze({
  phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
  publicKey: "vKqqNw-9lZ46XkURsOALoKf_5DfYGWfNyDNuUou8tKo",
  vaultId: "164155213bc1a4d46fc982a8ed2fbc18162de669079a23f1d170231764e10c00",
});

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  const consoleMessages = [];
  const outboundBodies = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    consoleMessages.push(message.text());
    if (message.type() === "error" && !/favicon|net::ERR|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  page.on("request", (request) => {
    const body = request.postData();
    if (body) outboundBodies.push(body);
  });
  return { context, page, errors, consoleMessages, outboundBodies };
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

async function inspectMnemonicContract(page, phrase) {
  return page.evaluate(async ({ phrase, vector }) => {
    const mnemonic = await import("/js/identity/mnemonic.js");
    const { BIP39_ENGLISH_WORDS } = await import("/js/identity/bip39-english.js");
    const signing = await import("/js/security/signing.js");

    const decoded = await mnemonic.mnemonicToEntropy(phrase);
    const roundTrip = await mnemonic.entropyToMnemonic(decoded);
    const zeroRoot = new Uint8Array(32);
    const vectorPhrase = await mnemonic.entropyToMnemonic(zeroRoot);
    const signingSeed = await signing.deriveRootBytes(zeroRoot, "owner-ed25519-seed");
    const pair = await signing.keyPairFromSeed(signingSeed);
    const publicBytes = await signing.exportPublicKeyRaw(pair.publicKey);

    const words = phrase.split(" ");
    let invalidPhrase = null;
    for (const candidate of BIP39_ENGLISH_WORDS) {
      if (candidate === words.at(-1)) continue;
      const altered = [...words.slice(0, -1), candidate].join(" ");
      try { await mnemonic.mnemonicToEntropy(altered); }
      catch { invalidPhrase = altered; break; }
    }

    decoded.fill(0);
    zeroRoot.fill(0);
    signingSeed.fill(0);
    return {
      wordCount: mnemonic.MESH_KEY_WORD_COUNT,
      entropyBits: mnemonic.MESH_KEY_ENTROPY_BITS,
      roundTripMatches: roundTrip === phrase,
      invalidPhrase,
      vectorMatches: vectorPhrase === vector.phrase
        && signing.bytesToBase64Url(publicBytes) === vector.publicKey
        && await signing.hashHex(publicBytes) === vector.vaultId,
    };
  }, { phrase, vector: ZERO_ROOT_VECTOR });
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
    await source.page.getByRole("button", { name: "Download Mesh Key file" }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    const keyText = await fs.promises.readFile(downloadPath, "utf8");
    const keyFile = JSON.parse(keyText);

    assert.equal(keyFile.format, "themeshvault-mesh-key", "The download is not a v3 Mesh Key file.");
    assert.equal(keyFile.version, 3, "The Mesh Key file does not use portable version 3.");
    assert.equal(keyFile.algorithm, "Ed25519", "The Mesh Key file does not identify the v3 signing algorithm.");
    assert.match(keyFile.vaultId, /^[a-f0-9]{64}$/, "The Mesh Key file does not contain a self-certifying Vault ID.");
    assert.deepEqual(
      Object.keys(keyFile).sort(),
      ["algorithm", "createdAt", "format", "meshKey", "vaultId", "version", "warning"].sort(),
      "The Mesh Key file contains an unexpected envelope, wrapped key or private-key field.",
    );
    assert.equal(/^[a-z]+(?: [a-z]+){23}$/.test(keyFile.meshKey), true, "The Mesh Key is not exactly 24 lowercase words.");

    const mnemonicContract = await inspectMnemonicContract(source.page, keyFile.meshKey);
    assert.deepEqual(
      { wordCount: mnemonicContract.wordCount, entropyBits: mnemonicContract.entropyBits },
      { wordCount: 24, entropyBits: 256 },
      "The v3 Mesh Key no longer represents a 256-bit root as 24 words.",
    );
    assert.equal(mnemonicContract.roundTripMatches, true, "The exported Mesh Key failed its BIP39 checksum round trip.");
    assert.equal(mnemonicContract.vectorMatches, true, "The deterministic Ed25519/Vault ID vector changed.");
    assert.ok(mnemonicContract.invalidPhrase, "The checksum-negative test vector could not be constructed.");

    const portable = await openPage(browser);
    sessions.push(portable);
    await openRestorePanel(portable.page);
    await portable.page.getByLabel("Mesh Key file").setInputFiles({
      name: "themeshvault-mesh-key.json",
      mimeType: "application/json",
      buffer: Buffer.from(keyText),
    });
    await portable.page.getByText("themeshvault-mesh-key.json - ready", { exact: true }).waitFor();
    assert.equal(await portable.page.getByRole("tab", { name: "Mesh Key file" }).getAttribute("aria-selected"), "true", "Restore did not default to the v3 Mesh Key file.");
    assert(await portable.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "The restore flow overflows a 390 px viewport.");
    await portable.page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-v3-restore-mobile.png"), fullPage: true });
    await portable.page.getByRole("button", { name: "Restore vault" }).click();
    await expectRestoredVault(portable.page, keyFile.vaultId);

    const phraseOnly = await openPage(browser);
    sessions.push(phraseOnly);
    await openRestorePanel(phraseOnly.page);
    await phraseOnly.page.getByRole("tab", { name: "Recovery phrase" }).click();
    assert.equal(await phraseOnly.page.locator("[data-recovery-method='file']").isHidden(), true, "The inactive file method remained visible.");
    await phraseOnly.page.getByLabel("24-word Mesh Key", { exact: true }).fill(keyFile.meshKey);
    await phraseOnly.page.getByRole("button", { name: "Restore vault" }).click();
    await expectRestoredVault(phraseOnly.page, keyFile.vaultId);

    const checksumRejected = await openPage(browser);
    sessions.push(checksumRejected);
    await openRestorePanel(checksumRejected.page);
    await checksumRejected.page.getByRole("tab", { name: "Recovery phrase" }).click();
    await checksumRejected.page.getByLabel("24-word Mesh Key", { exact: true }).fill(mnemonicContract.invalidPhrase);
    await checksumRejected.page.getByRole("button", { name: "Restore vault" }).click();
    await checksumRejected.page.locator("[data-onboard-panel='restore'] .form-status").filter({ hasText: "checksum is not valid" }).waitFor();
    assert.equal(new URL(checksumRejected.page.url()).hash, "#/onboarding", "A checksum-invalid Mesh Key was accepted.");

    const v2Rejected = await openPage(browser);
    sessions.push(v2Rejected);
    await openRestorePanel(v2Rejected.page);
    const staleV2File = JSON.stringify({
      format: "themeshvault-recovery-kit",
      version: 2,
      vaultId: keyFile.vaultId,
      recoveryPhrase: keyFile.meshKey,
      envelope: { cipher: "stale", salt: "stale", wrappedSegmentKey: "stale" },
    });
    await v2Rejected.page.getByLabel("Mesh Key file").setInputFiles({
      name: "pre-release-v2-recovery-kit.json",
      mimeType: "application/json",
      buffer: Buffer.from(staleV2File),
    });
    await v2Rejected.page.getByText("pre-release-v2-recovery-kit.json - not recognized", { exact: true }).waitFor();
    await v2Rejected.page.getByRole("button", { name: "Restore vault" }).click();
    await v2Rejected.page.locator("[data-onboard-panel='restore'] .form-status").filter({ hasText: "complete TheMeshVault v3 Mesh Key file" }).waitFor();
    assert.equal(new URL(v2Rejected.page.url()).hash, "#/onboarding", "A pre-v3 recovery envelope crossed the v3 restore gate.");

    for (const session of sessions) assert.deepEqual(session.errors, [], `Browser errors: ${session.errors.join(" | ")}`);
    assert.equal(sessions.some((session) => session.consoleMessages.some((message) => message.includes(keyFile.meshKey))), false, "The Mesh Key appeared in browser console output.");
    assert.equal(sessions.some((session) => session.outboundBodies.some((body) => body.includes(keyFile.meshKey))), false, "The Mesh Key appeared in an outbound request body.");
    const mode = process.argv.includes("--local-only") ? "local-only" : "full";
    console.log(`PASS (${mode}): the 256-bit/24-word checksum contract, deterministic Ed25519 Vault ID vector, envelope-free v3 file, file/phrase portability and pre-v3 rejection all hold. Screenshot: ${path.join(os.tmpdir(), "themeshvault-v3-restore-mobile.png")}. No Mesh Key was logged.`);
  } finally {
    await Promise.all(sessions.map(({ context }) => context.close().catch(() => {})));
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
