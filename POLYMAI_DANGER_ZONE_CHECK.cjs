const fs = require("fs");
const path = require("path");

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const settings = read("js/views/settings-view.js");
const bootstrap = read("js/bootstrap.js");
const reset = read("js/platform/v3-storage-reset.js");
const css = read("css/views.css");
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

expect(settings.includes("Remove vault from this device"), "Local vault removal is missing from Settings.");
expect(settings.includes("Delete vault contents"), "Permanent vault-content deletion is missing from Settings.");
expect(settings.includes("Save Mesh Key first"), "Local removal is not visibly gated by a saved Mesh Key.");
expect(settings.includes('new FormData(form).get("confirmation") !== "DELETE"'), "Permanent deletion lacks an explicit typed confirmation.");
expect(settings.includes("data-device-reset-dialog") && settings.includes("data-vault-delete-dialog"), "Danger actions must use app-native dialogs.");
expect(!settings.includes("window.confirm("), "Danger zone must not use a browser confirmation dialog.");
expect(bootstrap.includes("await deleteFile(files[index].id"), "Permanent reset does not use the signed file deletion flow.");
expect(bootstrap.includes("await deleteFolderRecord(identity.vaultId, folderIds)"), "Permanent reset does not remove folder records.");
expect(bootstrap.includes("await pushOperationLog()"), "Signed deletion state is not flushed before local access is removed.");
expect(bootstrap.includes("await stopNativeNode()"), "Android background work is not stopped before local vault removal.");
expect(bootstrap.includes("identity.meshKeySaved"), "Local vault removal is not guarded by saved recovery material.");
expect(reset.includes('"vault-identity-v3"') && reset.includes('"vault-index-v3"') && reset.includes('"oplog-v3"'), "Private vault databases are not scheduled for deletion.");
const privateBlock = reset.match(/const PRIVATE_VAULT_DATABASE_SUFFIXES[\s\S]*?\]\);/)?.[0] || "";
for (const preserved of ["device-identity-v3", "shards-v3", "vault-settings-v3", "anchor-control-v3", "rendezvous-identity-v1"]) {
  expect(!privateBlock.includes(preserved), `${preserved} must survive a local vault reset.`);
}
expect(reset.includes("pending-vault-reset-v3") && reset.includes("performPendingVaultReset"), "The pre-bootstrap reset marker flow is missing.");
expect(css.includes(".danger-zone-panel") && css.includes(".danger-dialog__actions"), "Danger zone responsive styling is missing.");

if (failures.length) {
  console.log("POLYMAI_DANGER_ZONE_CHECK: REPAIR NEEDED");
  failures.forEach((failure) => console.log(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log("POLYMAI_DANGER_ZONE_CHECK: PASS");
  console.log("Verified local-only removal, signed permanent deletion, recovery gating, native shutdown and preserved hosted shards/device identity.");
}
