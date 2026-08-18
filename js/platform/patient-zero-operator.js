import { isCurrentPatientZeroResponder, patientZeroAuthorityState } from "../network/patient-zero-authority-chain.js";

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
  // Runtime authority comes from the deployed public-key pin. Requiring an
  // additional local UI flag made Patient Zero silently stop listening after
  // a vault reset, profile migration or operator-tool cleanup. Possession of
  // the matching private device key is the proof; the public pin is safe to
  // ship with every client.
  if (devicePublicKey) {
    const authority = patientZeroAuthorityState();
    return Number(authority.sequence || 0) > 0
      ? isCurrentPatientZeroResponder(devicePublicKey)
      : configuredAuthorityKeys().includes(devicePublicKey);
  }

  const storage = operatorStorage();
  const locallyEnabled = (() => {
    try { return requestedByUrl() || storage?.getItem(PATIENT_ZERO_OPERATOR_KEY) === "1"; }
    catch { return requestedByUrl(); }
  })();
  if (requestedByUrl()) {
    try { storage?.setItem(PATIENT_ZERO_OPERATOR_KEY, "1"); } catch {}
  }
  // Calls without a device key control only the hidden operator UI. They do
  // not grant runtime listener authority.
  return locallyEnabled;
}

export function disablePatientZeroOperator() {
  try { operatorStorage()?.removeItem(PATIENT_ZERO_OPERATOR_KEY); } catch {}
}
