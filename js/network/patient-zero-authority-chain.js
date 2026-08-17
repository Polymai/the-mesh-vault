import {
  ALG_ED25519, base64UrlToBytes, canonicalBytes, importPublicKeyRaw, verify,
} from "../security/signing.js";
import { supabase } from "../services/supabase.js";

export const PATIENT_ZERO_DEPLOYMENT_ID = "app717";
export const PATIENT_ZERO_AUTHORITY_PROTOCOL = "themeshvault-patient-zero-authority-v1";
const CACHE_KEY = "themeshvault.patientZeroAuthorityBundle.v1";
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

function configuredGenesisKey() {
  const values = globalThis.__POLYMAI_RENDEZVOUS_CONFIG__?.authorityPublicKeys;
  return Array.isArray(values) ? String(values.find((value) => PUBLIC_KEY_PATTERN.test(String(value || ""))) || "") : "";
}

function genesisState() {
  const genesisPublicKey = configuredGenesisKey();
  return Object.freeze({
    deploymentId: PATIENT_ZERO_DEPLOYMENT_ID,
    genesisPublicKey,
    activeAuthorityPublicKey: genesisPublicKey,
    responderDevicePublicKey: genesisPublicKey,
    recoveryPublicKey: null,
    sequence: 0,
    updatedAt: null,
  });
}

let verifiedBundle = Object.freeze({ state: genesisState(), history: [] });
let loadingPromise = null;

function validPublicKey(value) { return PUBLIC_KEY_PATTERN.test(String(value || "")); }
function validSignature(value) { return SIGNATURE_PATTERN.test(String(value || "")); }
function sameNullable(left, right) { return (left || null) === (right || null); }

async function verifySignature(publicKey, signature, statement) {
  if (!validPublicKey(publicKey) || !validSignature(signature)) return false;
  const raw = base64UrlToBytes(publicKey);
  const signatureBytes = base64UrlToBytes(signature);
  try {
    const imported = await importPublicKeyRaw(raw, ALG_ED25519);
    return await verify(imported, ALG_ED25519, signatureBytes, canonicalBytes(statement));
  } finally {
    raw.fill(0);
    signatureBytes.fill(0);
  }
}

function normalizeState(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    deploymentId: String(value.deploymentId || ""),
    genesisPublicKey: String(value.genesisPublicKey || ""),
    activeAuthorityPublicKey: String(value.activeAuthorityPublicKey || ""),
    responderDevicePublicKey: String(value.responderDevicePublicKey || ""),
    recoveryPublicKey: value.recoveryPublicKey ? String(value.recoveryPublicKey) : null,
    sequence: Number(value.sequence || 0),
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
  };
}

function normalizeHistory(raw) {
  return (Array.isArray(raw) ? raw : []).map((entry) => ({
    sequence: Number(entry?.sequence || 0),
    operation: String(entry?.operation || ""),
    authorizedBy: String(entry?.authorizedBy || ""),
    statement: entry?.statement && typeof entry.statement === "object" ? entry.statement : null,
    signature: String(entry?.signature || ""),
    successorSignature: entry?.successorSignature ? String(entry.successorSignature) : null,
    recoveryProofSignature: entry?.recoveryProofSignature ? String(entry.recoveryProofSignature) : null,
    createdAt: entry?.createdAt ? String(entry.createdAt) : null,
  })).sort((left, right) => left.sequence - right.sequence);
}

export async function verifyPatientZeroAuthorityBundle(rawBundle) {
  const expectedGenesis = configuredGenesisKey();
  if (!validPublicKey(expectedGenesis)) throw new Error("No valid Patient Zero genesis key is configured.");
  const advertisedState = normalizeState(rawBundle?.state);
  const history = normalizeHistory(rawBundle?.history);
  if (advertisedState.deploymentId !== PATIENT_ZERO_DEPLOYMENT_ID || advertisedState.genesisPublicKey !== expectedGenesis) {
    throw new Error("Patient Zero authority state is not anchored to this deployment.");
  }

  let state = { ...genesisState() };
  for (const entry of history) {
    const statement = entry.statement;
    if (!statement || statement.protocol !== PATIENT_ZERO_AUTHORITY_PROTOCOL
      || statement.deploymentId !== PATIENT_ZERO_DEPLOYMENT_ID
      || Number(statement.sequence) !== state.sequence + 1
      || entry.sequence !== Number(statement.sequence)
      || statement.previousAuthorityPublicKey !== state.activeAuthorityPublicKey
      || !validPublicKey(statement.nextAuthorityPublicKey)
      || !validPublicKey(statement.responderDevicePublicKey)
      || !["set_recovery", "rotate"].includes(statement.operation)
      || entry.operation !== statement.operation
      || entry.authorizedBy !== statement.authorizedBy) {
      throw new Error("Patient Zero authority history is malformed or out of order.");
    }
    const recoveryPublicKey = statement.recoveryPublicKey || null;
    if (recoveryPublicKey && !validPublicKey(recoveryPublicKey)) throw new Error("Patient Zero recovery key is invalid.");

    if (statement.operation === "set_recovery") {
      if (statement.authorizedBy !== "active"
        || statement.nextAuthorityPublicKey !== state.activeAuthorityPublicKey
        || statement.responderDevicePublicKey !== state.responderDevicePublicKey
        || !recoveryPublicKey
        || !await verifySignature(state.activeAuthorityPublicKey, entry.signature, statement)
        || !await verifySignature(recoveryPublicKey, entry.recoveryProofSignature, statement)) {
        throw new Error("Patient Zero recovery-key registration could not be verified.");
      }
    } else {
      const authorizer = statement.authorizedBy === "active"
        ? state.activeAuthorityPublicKey
        : statement.authorizedBy === "recovery" ? state.recoveryPublicKey : null;
      if (!authorizer
        || statement.nextAuthorityPublicKey === state.activeAuthorityPublicKey
        || !sameNullable(recoveryPublicKey, state.recoveryPublicKey)
        || !await verifySignature(authorizer, entry.signature, statement)
        || !await verifySignature(statement.nextAuthorityPublicKey, entry.successorSignature, statement)) {
        throw new Error("Patient Zero key rotation could not be verified.");
      }
    }
    state = {
      deploymentId: PATIENT_ZERO_DEPLOYMENT_ID,
      genesisPublicKey: expectedGenesis,
      activeAuthorityPublicKey: statement.nextAuthorityPublicKey,
      responderDevicePublicKey: statement.responderDevicePublicKey,
      recoveryPublicKey,
      sequence: Number(statement.sequence),
      updatedAt: statement.createdAt || entry.createdAt || null,
    };
  }

  if (advertisedState.sequence !== state.sequence
    || advertisedState.activeAuthorityPublicKey !== state.activeAuthorityPublicKey
    || advertisedState.responderDevicePublicKey !== state.responderDevicePublicKey
    || !sameNullable(advertisedState.recoveryPublicKey, state.recoveryPublicKey)) {
    throw new Error("Patient Zero authority state does not match its signed history.");
  }
  return Object.freeze({ state: Object.freeze(state), history: Object.freeze(history) });
}

function saveVerifiedBundle(bundle) {
  verifiedBundle = bundle;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(bundle)); } catch {}
  if (typeof globalThis.CustomEvent === "function") {
    globalThis.dispatchEvent?.(new CustomEvent("meshvault:patient-zero-authority", { detail: bundle.state }));
  }
  return bundle;
}

export async function loadPatientZeroAuthorityBundle({ force = false } = {}) {
  if (!force && loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        if (cached) saveVerifiedBundle(await verifyPatientZeroAuthorityBundle(cached));
      } catch { try { localStorage.removeItem(CACHE_KEY); } catch {} }
    }
    const { data, error } = await supabase.schema("app717_meshvault").rpc("get_patient_zero_authority_bundle", {
      p_deployment_id: PATIENT_ZERO_DEPLOYMENT_ID,
    });
    if (error) return verifiedBundle;
    return saveVerifiedBundle(await verifyPatientZeroAuthorityBundle(data));
  })();
  try { return await loadingPromise; }
  finally { loadingPromise = null; }
}

export function patientZeroAuthorityBundle() { return verifiedBundle; }
export function patientZeroAuthorityState() { return verifiedBundle.state; }
export function currentPatientZeroResponderKey() { return verifiedBundle.state.responderDevicePublicKey || configuredGenesisKey(); }
export function isCurrentPatientZeroResponder(devicePublicKey) { return !!devicePublicKey && devicePublicKey === currentPatientZeroResponderKey(); }
export async function acceptPatientZeroAuthorityBundle(bundle) { return saveVerifiedBundle(await verifyPatientZeroAuthorityBundle(bundle)); }
