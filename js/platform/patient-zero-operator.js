export const PATIENT_ZERO_OPERATOR_KEY = "themeshvault.patientZeroOperator.v1";

function operatorStorage() {
  try { return globalThis.localStorage || null; }
  catch { return null; }
}

function requestedByUrl() {
  try { return new URLSearchParams(globalThis.location?.search || "").get("patient-zero-setup") === "1"; }
  catch { return false; }
}

function configuredAuthorityKeys() {
  const values = globalThis.__POLYMAI_RENDEZVOUS_CONFIG__?.authorityPublicKeys;
  return Array.isArray(values) ? values.filter((value) => typeof value === "string" && value.length === 43) : [];
}

export function patientZeroOperatorEnabled(devicePublicKey = "") {
  const storage = operatorStorage();
  const locallyEnabled = (() => {
    try { return requestedByUrl() || storage?.getItem(PATIENT_ZERO_OPERATOR_KEY) === "1"; }
    catch { return requestedByUrl(); }
  })();
  if (requestedByUrl()) {
    try { storage?.setItem(PATIENT_ZERO_OPERATOR_KEY, "1"); } catch {}
  }
  if (!locallyEnabled) return false;
  // Views may omit the key so the operator can export the initial public
  // configuration. Runtime listener privileges require the deployed app to
  // pin this exact device key; a query flag alone cannot create Patient Zero.
  if (!devicePublicKey) return true;
  return configuredAuthorityKeys().includes(devicePublicKey);
}

export function disablePatientZeroOperator() {
  try { operatorStorage()?.removeItem(PATIENT_ZERO_OPERATOR_KEY); } catch {}
}
