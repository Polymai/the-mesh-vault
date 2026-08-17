import { LEGAL_VERSIONS } from "../content/public-documents.js";

const prefix = window.__POLYMAI_SUPABASE_CONFIG__?.appStoragePrefix || "polymai:app717:";
const storageKey = `${prefix}legal-acceptance-v1`;

export function currentLegalAcceptance() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "null");
    return value && value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export function hasCurrentLegalAcceptance() {
  const value = currentLegalAcceptance();
  return value?.termsVersion === LEGAL_VERSIONS.terms && value?.privacyVersion === LEGAL_VERSIONS.privacy;
}

export function recordLegalAcceptance() {
  const value = {
    schemaVersion: 1,
    termsVersion: LEGAL_VERSIONS.terms,
    privacyVersion: LEGAL_VERSIONS.privacy,
    acceptedAt: new Date().toISOString(),
    storage: "this-browser-only",
  };
  localStorage.setItem(storageKey, JSON.stringify(value));
  return value;
}
