const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { webcrypto } = require("node:crypto");

const root = __dirname;
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

globalThis.crypto ||= webcrypto;
globalThis.btoa ||= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ||= (value) => Buffer.from(value, "base64").toString("binary");
globalThis.nacl = require(path.join(root, "js/vendor/nacl-fast.min.js"));

(async () => {
  const signing = await import(`${pathToFileURL(path.join(root, "js/security/signing.js")).href}?rendezvous-check`);
  const protocol = await import(`${pathToFileURL(path.join(root, "js/network/rendezvous/bootstrap-protocol.js")).href}?rendezvous-check`);
  const nostr = await import(`${pathToFileURL(path.join(root, "js/vendor/nostr-tools.bundle.js")).href}?rendezvous-check`);
  const pair = await signing.generateKeyPair();
  const publicKey = signing.bytesToBase64Url(await signing.exportPublicKeyRaw(pair.publicKey));
  const signer = {
    publicKey,
    algorithm: signing.ALG_ED25519,
    sign: (bytes) => signing.sign(pair.privateKey, signing.ALG_ED25519, bytes),
  };
  const transportPublicKey = "13".repeat(32);
  const presence = {
    nodeId: "node-patient-zero",
    nodeName: "Patient Zero",
    devicePublicKey: publicKey,
    protocolVersion: 3,
    capabilities: ["storage", "coordination"],
    capacityBytes: 1024,
    usedBytes: 64,
    failureDomainId: "device:patient-zero",
  };

  const presenceEnvelope = await protocol.signPresenceObject(signer, transportPublicKey, presence, 60000);
  expect(!!(await protocol.verifyPresenceObject(presenceEnvelope, transportPublicKey)), "A valid device-signed presence must verify.");
  expect(!(await protocol.verifyPresenceObject(presenceEnvelope, "42".repeat(32))), "A presence must be bound to its exact rendezvous transport key.");
  expect(!(await protocol.verifyPresenceObject({ ...presenceEnvelope, presence: { ...presenceEnvelope.presence, nodeId: "attacker" } }, transportPublicKey)), "A modified peer identity must fail verification.");

  const directory = await protocol.signAuthorityObject(signer, "tmv-peer-directory-v1", {
    peers: [{ transportPublicKey, presenceEnvelope }],
  }, 60000);
  expect(!!(await protocol.verifyAuthorityObject(directory, [publicKey], "tmv-peer-directory-v1")), "A Patient Zero directory signed by the pinned public device key must verify.");
  expect(!(await protocol.verifyAuthorityObject({ ...directory, payload: { peers: [] } }, [publicKey], "tmv-peer-directory-v1")), "A modified Patient Zero directory must fail verification.");
  expect(!(await protocol.verifyAuthorityObject(directory, [], "tmv-peer-directory-v1")), "An unpinned Patient Zero directory must be rejected.");

  const senderTransportSecret = nostr.generateSecretKey();
  const recipientTransportSecret = nostr.generateSecretKey();
  const recipientTransportPublic = nostr.getPublicKey(recipientTransportSecret);
  const senderConversation = nostr.nip44v2.utils.getConversationKey(senderTransportSecret, recipientTransportPublic);
  const recipientConversation = nostr.nip44v2.utils.getConversationKey(recipientTransportSecret, nostr.getPublicKey(senderTransportSecret));
  const encryptedDirectory = nostr.nip44v2.encrypt(JSON.stringify(directory), senderConversation);
  expect(nostr.nip44v2.decrypt(encryptedDirectory, recipientConversation) === JSON.stringify(directory), "NIP-44 transport encryption must round-trip between separate rendezvous identities.");
  expect(!encryptedDirectory.includes(publicKey), "The relay-visible NIP-44 event content must not expose the Patient Zero device key or directory plaintext.");

  const rendezvousConfig = read("data/rendezvousConfig.js");
  const runtime = read("data/runtime-config.js");
  const provider = read("js/network/providers/distributed-rendezvous-provider.js");
  const policy = read("js/network/coordination-policy.js");
  const bootstrap = read("js/bootstrap.js");
  const anchorView = read("js/views/anchor-view.js");
  const settingsView = read("js/views/settings-view.js");
  const operatorAccess = read("js/platform/patient-zero-operator.js");
  const worker = read("sw.js");
  const security = read("js/content/public-documents.js");
  const defensive = read("DEFENSIVE_PUBLICATION.md");

  globalThis.window ||= {};
  globalThis.location = { search: "" };
  const operatorValues = new Map();
  globalThis.localStorage = {
    getItem: (key) => operatorValues.has(key) ? operatorValues.get(key) : null,
    setItem: (key, value) => operatorValues.set(key, String(value)),
    removeItem: (key) => operatorValues.delete(key),
  };
  const anchorModule = await import(`${pathToFileURL(path.join(root, "js/views/anchor-view.js")).href}?operator-visibility-check`);
  const operatorModule = await import(`${pathToFileURL(path.join(root, "js/platform/patient-zero-operator.js")).href}?operator-persistence-check`);
  const settingsModule = await import(`${pathToFileURL(path.join(root, "js/views/settings-view.js")).href}?operator-settings-check`);
  const anchorState = { anchor: {}, nativeNode: {} };
  const settingsState = { node: { status: "online" }, nativeNode: {}, pwaInstall: {}, survival: {} };
  expect(!anchorModule.renderAnchorView(anchorState).includes("Private cold start"), "Normal Backbone UI must not expose Patient Zero infrastructure controls.");
  globalThis.location.search = "?patient-zero-setup=1";
  const operatorMarkup = anchorModule.renderAnchorView(anchorState);
  expect(operatorMarkup.includes("Download public setup") && operatorMarkup.includes("Copy app configuration"), "Explicit Patient Zero operator mode must provide public backup and deployable app configuration exports.");
  globalThis.location.search = "";
  expect(anchorModule.renderAnchorView(anchorState).includes("Patient Zero setup"), "Patient Zero operator mode must persist only in the browser profile that activated it.");
  operatorModule.disablePatientZeroOperator();
  expect(!anchorModule.renderAnchorView(anchorState).includes("Patient Zero setup"), "A local operator must be able to hide Patient Zero tools again.");
  expect(!settingsModule.renderSettingsView(settingsState).includes("Deployment tools"), "Ordinary Settings must not reveal Patient Zero tools.");
  globalThis.location.search = "?patient-zero-setup=1";
  expect(settingsModule.renderSettingsView(settingsState).includes("Deployment tools"), "The activated browser profile must receive its compact Patient Zero Settings entry.");
  operatorModule.disablePatientZeroOperator();
  globalThis.location.search = "";

  expect((rendezvousConfig.match(/wss:\/\//g) || []).length >= 3, "At least three replaceable public WSS rendezvous relays must be configured.");
  expect(!/(privateKey|secretKey|meshKey)\s*:/i.test(rendezvousConfig), "The public rendezvous configuration must not contain secret fields.");
  expect(/presenceRefreshMs:\s*120000/.test(runtime), "Signed rendezvous presence must refresh sparsely, not continuously.");
  expect(policy.indexOf('"distributed-rendezvous"') >= 0 && policy.indexOf('"distributed-rendezvous"') < policy.lastIndexOf('"supabase"'), "Distributed rendezvous must be attempted before Supabase.");
  expect(/verifyPresenceObject\(message\.presenceEnvelope,?/.test(provider) || /rememberPeer\(event\.pubkey, message\.presenceEnvelope\)/.test(provider), "Incoming rendezvous peer claims must be signature verified.");
  expect(/nodeTransportKeys\.get\(message\.signal\.fromNodeId\) !== event\.pubkey/.test(provider), "Signals must be bound to the verified peer transport key.");
  expect(/nip44v2\.encrypt/.test(provider) && /nip44v2\.decrypt/.test(provider), "Relay payloads must use authenticated NIP-44 encryption.");
  expect(/if \(!allowedAuthorities\(\)\.length\)[\s\S]{0,220}return statusSnapshot\(\)/.test(provider), "The app must not contact public rendezvous relays before a Patient Zero public key is pinned.");
  const publicSetupOffset = provider.indexOf("patientZeroPublicSetup()");
  expect(publicSetupOffset >= 0 && provider.indexOf("loadOrCreateRendezvousIdentity()", publicSetupOffset) > publicSetupOffset, "Patient Zero public setup must be exportable locally before its trust key is deployed.");
  expect(/patientZeroOperatorEnabled/.test(anchorView) && /patientZeroOperatorEnabled/.test(settingsView) && /patient-zero-setup/.test(operatorAccess), "Patient Zero setup controls must use the shared browser-profile operator gate and remain absent elsewhere.");
  expect(/themeshvault-patient-zero-public-setup/.test(bootstrap) && /copyPatientZeroConfig/.test(bootstrap), "The operator flow must generate a public setup backup and a ready-to-publish rendezvous configuration.");
  expect(/fallbackIceLoader:\s*\(\)\s*=>\s*getPeerIceConfig/.test(bootstrap), "Hosted TURN credentials must be loaded only through the delayed fallback path.");
  expect(!/Promise\.all\([\s\S]{0,400}getPeerIceConfig/.test(bootstrap), "Startup must not fetch hosted ICE configuration eagerly.");
  expect(/themeshvault-shell-v\d+/.test(worker) && /rendezvousConfig\.js/.test(worker) && /distributed-rendezvous-provider\.js/.test(worker) && /patient-zero-operator\.js/.test(worker), "The installable app shell must cache the distributed rendezvous runtime and local operator gate.");
  expect(/Patient Zero/.test(security) && /NIP-44/.test(security) && /IP address/.test(security), "Public Security and Privacy text must explain Patient Zero encryption and relay-visible pseudonymous network data.");
  expect(/Patient Zero/.test(defensive) && /outbound/.test(defensive) && /Supabase/.test(defensive), "The defensive publication must document outbound Patient Zero rendezvous and remaining Supabase boundaries.");

  signing.destroyPrivateKey(pair.privateKey);
  if (failures.length) {
    console.error("POLYMAI_DISTRIBUTED_RENDEZVOUS_CHECK: FAIL");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
    return;
  }
  console.log("POLYMAI_DISTRIBUTED_RENDEZVOUS_CHECK: PASS");
})().catch((error) => {
  console.error("POLYMAI_DISTRIBUTED_RENDEZVOUS_CHECK: FAIL");
  console.error(error?.stack || error);
  process.exitCode = 1;
});
