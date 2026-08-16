export const PATIENT_ZERO_OPERATOR_KEY = "themeshvault.patientZeroOperator.v1";

function operatorStorage() {
  try { return globalThis.localStorage || null; }
  catch { return null; }
}

function requestedByUrl() {
  try { return new URLSearchParams(globalThis.location?.search || "").get("patient-zero-setup") === "1"; }
  catch { return false; }
}

export function patientZeroOperatorEnabled() {
  const storage = operatorStorage();
  if (requestedByUrl()) {
    try { storage?.setItem(PATIENT_ZERO_OPERATOR_KEY, "1"); } catch {}
    return true;
  }
  try { return storage?.getItem(PATIENT_ZERO_OPERATOR_KEY) === "1"; }
  catch { return false; }
}

export function disablePatientZeroOperator() {
  try { operatorStorage()?.removeItem(PATIENT_ZERO_OPERATOR_KEY); } catch {}
}
