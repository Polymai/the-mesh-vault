const path = require("path");
const os = require("os");
const assert = require("assert");
const { chromium } = require(path.join(os.homedir(), "Polymai", "node_modules", "playwright"));

const BASE_URL = "http://127.0.0.1:3007";
const PRIVATE_NAME = "Private Family Archive";
const PUBLIC_NODE_NAME = "Aurora Test Phone";

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|net::ERR|Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  try {
    await page.goto(`${BASE_URL}/#/onboarding`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-onboard='anonymous']").first().click();
    await page.locator("[data-legal-consent] input[name='termsAccepted']").check();
    await page.locator("[data-confirm-legal]").click();
    await page.waitForURL(/#\/dashboard/, { timeout: 30000 });

    const cryptographicChecks = await page.evaluate(async ({ privateName }) => {
      const { currentVaultIdentity } = await import("/js/identity/vault-identity.js");
      const { buildEncryptedVaultProfile, openEncryptedVaultProfile } = await import("/js/services/vault-service.js");
      const identity = currentVaultIdentity();
      const envelope = await buildEncryptedVaultProfile(identity, { name: privateName }, Date.now());
      const opened = await openEncryptedVaultProfile(envelope, identity);
      const serialized = JSON.stringify(envelope);
      const tampered = structuredClone(envelope);
      tampered.encryptedProfile.cipher = `${tampered.encryptedProfile.cipher.slice(0, -2)}AA`;
      const rejected = await openEncryptedVaultProfile(tampered, identity);
      return {
        plaintextAbsent: !serialized.includes(privateName),
        roundTripName: opened?.name || null,
        tamperRejected: rejected === null,
      };
    }, { privateName: PRIVATE_NAME });
    assert.equal(cryptographicChecks.plaintextAbsent, true, "The private vault name leaked into the coordination envelope.");
    assert.equal(cryptographicChecks.roundTripName, PRIVATE_NAME, "The encrypted private vault name did not round-trip.");
    assert.equal(cryptographicChecks.tamperRejected, true, "A tampered private vault profile was accepted.");

    await page.goto(`${BASE_URL}/#/settings`);
    await page.getByLabel("Public node name").fill(PUBLIC_NODE_NAME);
    await page.getByRole("button", { name: "Save public name" }).click();
    await page.getByText("Public node name saved.", { exact: true }).waitFor({ timeout: 15000 });
    assert.equal((await page.locator(".node-summary strong").textContent()).includes(PUBLIC_NODE_NAME), true, "The public node name did not update in the app shell.");
    const storedPublicName = await page.evaluate(async () => {
      const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(`${prefix}device-identity-v1`, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return new Promise((resolve, reject) => {
        const request = db.transaction("device", "readonly").objectStore("device").get("primary");
        request.onsuccess = () => resolve(request.result?.label || null);
        request.onerror = () => reject(request.error);
      });
    });
    assert.equal(storedPublicName, PUBLIC_NODE_NAME, "The public node name was acknowledged before its browser transaction committed.");

    await page.getByLabel("Private vault name (optional)").fill(PRIVATE_NAME);
    await page.getByRole("button", { name: "Save private name" }).click();
    await page.waitForFunction((name) => document.querySelector(".account-email")?.textContent?.includes(name), PRIVATE_NAME, { timeout: 30000 });
    assert.equal((await page.locator(".account-email").textContent()).includes(PRIVATE_NAME), true, "The private vault name did not update in the owner-only shell.");
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "The naming controls overflow on mobile.");
    await page.screenshot({ path: path.join(os.tmpdir(), "themeshvault-private-public-names-settings.png"), fullPage: true });

    await page.goto(`${BASE_URL}/#/mesh`);
    await page.getByRole("heading", { name: "Live Mesh", exact: true }).waitFor({ timeout: 15000 });
    const meshText = await page.locator(".mesh-layout").innerText();
    const liveNode = await page.evaluate(async () => {
      const { currentNode } = await import("/js/network/node-service.js");
      const node = currentNode();
      return node ? { id: node.id, label: node.device_label, localOnly: node.coordination_status === "local-only" } : null;
    });
    const reloadedDevice = await page.evaluate(async () => {
      const { currentDeviceIdentity } = await import("/js/identity/device-identity.js");
      const identity = currentDeviceIdentity();
      const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(`${prefix}device-identity-v1`, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const request = db.transaction("device", "readonly").objectStore("device").get("primary");
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
      return { cached: identity?.label || null, stored: record?.label || null, prefix };
    });
    assert.equal(meshText.includes(PUBLIC_NODE_NAME), true, `Live Mesh did not show the public node name. Current node: ${JSON.stringify(liveNode)}; device: ${JSON.stringify(reloadedDevice)}; mesh text: ${JSON.stringify(meshText.slice(0, 600))}`);
    assert.equal(meshText.includes(PRIVATE_NAME), false, "Live Mesh exposed the private vault name.");

    const registryCheck = await page.evaluate(async ({ publicNodeName }) => {
      const registry = await import("/js/network/peer-registry.js");
      registry.upsertPeer({ peerId: "naming-check-peer", nodeName: publicNodeName, protocolVersion: 1, trustStatus: "gossiped" });
      return registry.getPeer("naming-check-peer")?.nodeName || null;
    }, { publicNodeName: "Signed Gossip Phone" });
    assert.equal(registryCheck, "Signed Gossip Phone", "The peer registry dropped the public name received through gossip.");

    assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
    console.log(`PASS: private vault names are encrypted, owner-signed, tamper-rejected and absent from Live Mesh; public node names persist through the UI and peer registry. Screenshot: ${path.join(os.tmpdir(), "themeshvault-private-public-names-settings.png")}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
