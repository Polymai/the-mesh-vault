#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

async function main() {
  const logSource = read("js/observability/data-flow-log.js");
  const panelSource = read("js/ui/data-flow-panel.js");
  const supabaseSource = read("js/services/supabase.js");
  const transferSource = read("js/network/transfer-protocol.js");
  const peerSource = read("js/network/peer-manager.js");
  const meshSource = read("js/views/mesh-view.js");
  const css = read("css/data-flow.css");
  const sw = read("sw.js");

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(logSource).toString("base64")}`;
  const log = await import(moduleUrl);
  log.resetDataFlowLog();
  log.recordDataFlow({ route: "direct", direction: "out", kind: "Encrypted shard", bytes: 1024, counterparty: "Phone" });
  log.recordDataFlow({ route: "direct", direction: "out", kind: "Encrypted shard", bytes: 2048, counterparty: "Phone" });
  log.recordDataFlow({ route: "supabase", direction: "in", kind: "Mesh overview", bytes: 500 });
  const snapshot = log.dataFlowSnapshot();
  expect(snapshot.totals.direct.outboundBytes === 3072, "Direct byte totals do not aggregate correctly.");
  expect(snapshot.totals.supabase.inboundBytes === 500, "Supabase byte totals do not aggregate correctly.");
  expect(snapshot.entries.length === 2 && snapshot.entries[0].route === "supabase", "Recent flow ordering or aggregation is incorrect.");
  expect(snapshot.entries.every((entry) => !("payload" in entry || "fileName" in entry || "vaultId" in entry)), "The local log must not retain payloads, file names or vault IDs.");
  expect(log.describePeerMessage("shard-chunk") === "Encrypted shard", "Shard traffic is not labelled clearly.");
  expect(log.describeSupabaseRequest("https://project.supabase.co/rest/v1/rpc/discover_node_candidates", "POST", "{}") === "Find nodes", "Supabase discovery is not labelled clearly.");

  expect(/global:\s*\{\s*fetch:\s*supabaseFetch\s*\}/.test(supabaseSource), "Supabase client traffic is not routed through the local observer.");
  expect((supabaseSource.match(/globalThis\.fetch\(/g) || []).length === 1, "The observer must perform exactly the original fetch, not a second measurement request.");
  expect(/handlers\.onTraffic\?\./.test(transferSource), "WebRTC send/receive traffic is not observed at the protocol boundary.");
  expect(/anchorRoute\s*\?\s*"anchor"\s*:\s*"direct"/.test(peerSource), "Direct and Anchor WebRTC paths are not separated.");
  expect(/bindDataFlowPanel\(\)/.test(meshSource) && /unbindDataFlow/.test(meshSource), "Live Mesh does not bind and clean up the independent flow panel.");
  expect(!/actions\.rerender/.test(panelSource), "Data-flow updates must not rerender the mesh visualization.");
  expect(/@media \(max-width:650px\)/.test(css), "The flow panel lacks a mobile layout.");
  expect(sw.includes("css/data-flow.css") && sw.includes("js/observability/data-flow-log.js"), "The installed PWA cache does not include the data-flow UI.");

  if (failures.length) {
    console.error("DATA FLOW CHECK: FAIL");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log("DATA FLOW CHECK: PASS");
  console.log("Verified local-only aggregated Direct, Anchor and Supabase flow observability without extra measurement requests or mesh rerenders.");
}

main().catch((error) => { console.error("DATA FLOW CHECK: FAIL"); console.error(error); process.exit(1); });
