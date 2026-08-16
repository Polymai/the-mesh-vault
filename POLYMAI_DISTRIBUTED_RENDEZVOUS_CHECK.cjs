const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const rendezvousConfig = read("data/rendezvousConfig.js");
const runtime = read("data/runtime-config.js");
const index = read("index.html");
const worker = read("sw.js");
const policy = read("js/network/supabase-fallback-policy.js");
const provider = read("js/network/providers/supabase-bootstrap-provider.js");
const nodeService = read("js/network/node-service.js");
const patientZeroOperator = read("js/platform/patient-zero-operator.js");
const anchorView = read("js/views/anchor-view.js");
const supabase = read("js/services/supabase.js");
const schema = read("supabase/schema.sql");
const security = read("js/content/public-documents.js");
const defensive = read("DEFENSIVE_PUBLICATION.md");

expect(/enabled:\s*false/.test(rendezvousConfig), "Public rendezvous relays must be disabled.");
expect(/relayUrls:\s*Object\.freeze\(\[\]\)/.test(rendezvousConfig), "The deployed rendezvous relay list must be empty.");
expect(!/wss:\/\//.test(rendezvousConfig), "No third-party WSS rendezvous endpoint may be shipped.");
expect(!/distributed-rendezvous-provider/.test(index), "The page must not load the retired distributed-rendezvous provider.");
expect(!/distributed-rendezvous-provider/.test(worker), "The service worker must not cache the retired distributed-rendezvous provider.");
expect(!/nostr-tools/.test(index) && !/nostr-tools/.test(worker), "The active app shell must not load or cache Nostr rendezvous code.");

expect(/supabaseAutomaticFallbackEnabled:\s*true/.test(runtime), "The bounded first-contact gate must be enabled.");
expect(/supabaseFallbackWindowMs:\s*60000/.test(runtime), "The ordinary-node first-contact gate must be bounded to 60 seconds.");
expect(/supabase-bootstrap-complete-v3/.test(policy), "Successful first contact must be persisted per local node profile.");
expect(/supabaseBootstrapCompleted\(\)[\s\S]{0,180}return false/.test(policy), "A completed profile must never automatically reopen Supabase.");
expect(/patientZeroListener \|\| supabaseFallbackWindowOpen\(\)/.test(policy), "Only Patient Zero or an open first-contact window may use the provider.");
expect(/discover_bootstrap_gateways/.test(policy), "The exact Patient Zero discovery RPC must be allowed during first contact.");
expect(!/discover_node_candidates/.test(policy), "Broad node discovery must remain blocked.");
expect(!/get_mesh_overview|get_vault_index/.test(policy), "Mesh overview and vault indexes must remain blocked from Supabase runtime.");

expect(/discover_bootstrap_gateways/.test(provider), "First contact must query only the Patient Zero gateway RPC.");
expect(/device_public_key/.test(provider), "The returned gateway must be matched to the pinned Patient Zero public key.");
expect(/p_limit:\s*3/.test(provider), "The first-contact response must remain tightly bounded.");
expect(/discoverPeers\(\{ force = false \}/.test(provider) && /publishPresenceOnce\(\{ force \}\)/.test(provider), "Bounded cold start must be able to refresh a missed Patient Zero registration.");
expect(!/discover_node_candidates/.test(provider), "The provider must not contain broad candidate discovery.");

expect(/retireOrdinaryBootstrapRegistration/.test(nodeService), "Ordinary nodes must retire their temporary Supabase bootstrap state.");
expect(/vault_id:\s*null/.test(nodeService), "Patient Zero registration must not depend on or disclose a local vault ID.");
expect(/const delay = patientZero \? 0 :/.test(nodeService), "Patient Zero must open its sparse first-contact listener without the ordinary cold-start delay.");
expect(/const delays = \[4000, 9000, 16000\]/.test(nodeService), "Cold start must retry a startup race only a small bounded number of times.");
expect(/discoverPeers\(\{ force: true \}\)/.test(nodeService), "A bounded retry must bypass a stale empty Patient Zero discovery result.");
expect(/if \(devicePublicKey\) return configuredAuthorityKeys\(\)\.includes\(devicePublicKey\)/.test(patientZeroOperator), "The deployed public-key pin must deterministically activate Patient Zero without a fragile local UI flag.");
expect(/markSupabaseBootstrapComplete/.test(nodeService), "Ordinary nodes must persist the post-bootstrap cutoff.");
expect(/clearAnonymousSessionLocally/.test(nodeService), "The temporary anonymous session must be cleared after direct mesh contact.");
expect(/setRealtimeEnabled\(false\)/.test(nodeService) && /disconnectNode\(\)/.test(nodeService), "The temporary Realtime channel must be closed after direct mesh contact.");
expect(/autoRefreshToken:\s*false/.test(supabase), "Ordinary sessions must not refresh automatically.");
expect(/MESH_ONLY/.test(supabase) && /status:\s*409/.test(supabase), "Out-of-window Supabase requests must be rejected locally before network I/O.");
expect(/patientZeroOperatorEnabled\(runtimeNode\.device_public_key\)/.test(anchorView), "Patient Zero UI must derive publication from the deployment-pinned public key.");
expect(/Configuration published/.test(anchorView) && /First-contact listener/.test(anchorView), "Patient Zero UI must distinguish deployed configuration from live listener status.");

expect(/discover_bootstrap_gateways/.test(schema), "The schema must expose the exact Patient Zero discovery RPC.");
expect(/device_public_key=any\(p_device_public_keys\)/.test(schema), "Patient Zero discovery must require the pinned public key list.");
expect(/first contact/i.test(security) && /Patient Zero/.test(security), "Public documentation must explain the one-time gate and Patient Zero exception.");
expect(/first-contact/i.test(defensive) && /Patient Zero/.test(defensive), "The defensive publication must document the same runtime boundary.");

if (failures.length) {
  console.error("POLYMAI_DISTRIBUTED_RENDEZVOUS_CHECK: FAIL");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log("POLYMAI_DISTRIBUTED_RENDEZVOUS_CHECK: PASS");
}
