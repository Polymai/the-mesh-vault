import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createBackboneServer } from "./backbone-server.mjs";
import { validateStorageLayout } from "./storage-layout.mjs";
import { SupabaseNodeRegistry } from "./supabase-registry.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(process.env.MESHVAULT_BACKBONE_CONFIG || process.argv.find((arg) => arg.startsWith("--config="))?.slice(9) || `${root}/backbone-host.json`);
const command = process.argv[2] || "check";

function defaultConfig() {
  return {
    protocolVersion: 3, physicalHostId: randomUUID(), label: "TheMeshVault Backbone",
    listen: { host: "127.0.0.1", port: 3717 }, publicUrl: "", tls: { certificatePath: "", privateKeyPath: "" }, reserveBytesPerPool: 1073741824,
    supabase: { url: "https://pfnlebwkbhblytpvaokd.supabase.co", publishableKey: "sb_publishable_O8CemBWuZAjQDC6gSkNq9Q_wAmDtHiv", heartbeatMs: 600000 },
    storagePools: [{ id: "primary", path: resolve(root, "data"), physicalDeviceId: "auto" }],
    instances: [{ id: randomUUID(), label: "Backbone 1", poolId: "primary", quotaBytes: 100 * 1024 ** 3 }],
  };
}
function load() { const value = JSON.parse(readFileSync(configPath, "utf8")); if (value.protocolVersion !== 3) throw new Error("Backbone protocolVersion must be 3."); return value; }

if (command === "init") {
  if (!existsSync(configPath)) { mkdirSync(dirname(configPath), { recursive: true }); writeFileSync(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { flag: "wx" }); }
  console.log(configPath); process.exit(0);
}

const config = load(); const layout = { ...validateStorageLayout(config), publicUrl: String(config.publicUrl || "") };
if (command === "check") {
  console.log(JSON.stringify({ ok: true, physicalHostId: config.physicalHostId, publicUrl: config.publicUrl || null, pools: layout.pools, instances: layout.instances.map(({ pool, ...instance }) => instance) }, null, 2));
  process.exit(0);
}
if (command !== "start") throw new Error("Use init, check or start.");
const service = createBackboneServer(config, layout, resolve(dirname(configPath), "backbone-identity.jwk"));
const address = await service.start();
const registry = new SupabaseNodeRegistry(config, layout, service.identity, resolve(dirname(configPath), "backbone-supabase-session.json"), service.store);
await registry.start();
service.setInstanceChangeHandler(() => registry.upsert("online").catch(() => false));
console.log(`TheMeshVault Backbone listening on ${typeof address === "string" ? address : `${address.address}:${address.port}`}`);
console.log(`Pinned public key: ${service.identity.publicKey}`);
const stop = async () => { await registry.stop(); await service.stop(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
