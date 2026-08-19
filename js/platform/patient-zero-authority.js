import {
  ALG_ED25519, bytesToBase64Url, canonicalBytes, destroyPrivateKey, exportPrivateKeyJwk,
  exportPublicKeyRaw, generateKeyPair, importPrivateKeyJwk, sign,
} from "../security/signing.js";
import { currentDeviceSigner } from "../network/node-service.js";
import {
  acceptPatientZeroAuthorityBundle, loadPatientZeroAuthorityBundle,
  PATIENT_ZERO_AUTHORITY_PROTOCOL, PATIENT_ZERO_DEPLOYMENT_ID,
} from "../network/patient-zero-authority-chain.js";
import { ensureAnonymousSession, supabase } from "../services/supabase.js";
import { withPatientZeroOperatorRequest } from "../network/supabase-fallback-policy.js";

const DB_NAME = "themeshvault-patient-zero-authority-v1";
const STORE = "keys";

async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function idb(method, value = null) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, method === "get" ? "readonly" : "readwrite");
    const store = tx.objectStore(STORE);
    const request = method === "get" ? store.get(value) : method === "delete" ? store.delete(value) : store.put(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function publicKeyOf(pair) { return bytesToBase64Url(await exportPublicKeyRaw(pair.publicKey)); }
async function signatureOf(signer, statement) { return bytesToBase64Url(await signer.sign(canonicalBytes(statement))); }
async function invoke(body) {
  const { data, error } = await withPatientZeroOperatorRequest(async () => {
    await ensureAnonymousSession({ refreshIfExpiring: true });
    return supabase.functions.invoke("app717-meshvault-api", {
      body: { ...body, clientProtocolVersion: 3 },
    });
  });
  if (error || data?.error) throw new Error(data?.error || error?.message || "Patient Zero update failed.");
  return acceptPatientZeroAuthorityBundle(data.bundle);
}
async function loadAuthority() {
  return withPatientZeroOperatorRequest(async () => {
    await ensureAnonymousSession({ refreshIfExpiring: true });
    return loadPatientZeroAuthorityBundle({ force: true });
  });
}
async function activeSigner(state) {
  const device = currentDeviceSigner();
  if (device?.publicKey === state.activeAuthorityPublicKey) return device;
  let stored = await idb("get", "active");
  if (!stored?.privateKeyJwk || stored.publicKey !== state.activeAuthorityPublicKey) {
    const pending = await idb("get", "pending");
    if (pending?.privateKeyJwk && pending.publicKey === state.activeAuthorityPublicKey) {
      stored = { ...pending, id: "active", activatedAt: Date.now() };
      await idb("put", stored);
      await idb("delete", "pending");
    }
  }
  if (!stored?.privateKeyJwk || stored.publicKey !== state.activeAuthorityPublicKey) {
    throw new Error("This profile does not hold the active Patient Zero private key.");
  }
  const privateKey = await importPrivateKeyJwk(stored.privateKeyJwk, ALG_ED25519);
  return { publicKey: stored.publicKey, sign: (bytes) => sign(privateKey, ALG_ED25519, bytes), destroy: () => destroyPrivateKey(privateKey) };
}
function statementFor(state, operation, authorizedBy, nextAuthorityPublicKey, responderDevicePublicKey, recoveryPublicKey) {
  return {
    protocol: PATIENT_ZERO_AUTHORITY_PROTOCOL,
    deploymentId: PATIENT_ZERO_DEPLOYMENT_ID,
    sequence: Number(state.sequence) + 1,
    operation,
    authorizedBy,
    previousAuthorityPublicKey: state.activeAuthorityPublicKey,
    nextAuthorityPublicKey,
    responderDevicePublicKey,
    recoveryPublicKey: recoveryPublicKey || null,
    createdAt: new Date().toISOString(),
  };
}

export async function rotatePatientZeroAuthority() {
  const { state } = await loadAuthority();
  const device = currentDeviceSigner();
  if (!device?.publicKey || device.publicKey !== state.responderDevicePublicKey) throw new Error("Only the active Mainframe profile can rotate Patient Zero.");
  const authorizer = await activeSigner(state);
  const successor = await generateKeyPair();
  try {
    const nextPublicKey = await publicKeyOf(successor);
    const pending = { id: "pending", publicKey: nextPublicKey, privateKeyJwk: await exportPrivateKeyJwk(successor.privateKey), savedAt: Date.now() };
    await idb("put", pending);
    const successorSigner = { sign: (bytes) => sign(successor.privateKey, ALG_ED25519, bytes) };
    const statement = statementFor(state, "rotate", "active", nextPublicKey, device.publicKey, state.recoveryPublicKey);
    const bundle = await invoke({ action: "patient-zero-rotate", statement, signature: await signatureOf(authorizer, statement), successorSignature: await signatureOf(successorSigner, statement) });
    await idb("put", { ...pending, id: "active", activatedAt: Date.now() });
    await idb("delete", "pending");
    return bundle;
  } finally { authorizer.destroy?.(); destroyPrivateKey(successor.privateKey); }
}

export async function createPatientZeroRecoveryFile() {
  const { state } = await loadAuthority();
  const device = currentDeviceSigner();
  if (!device?.publicKey || device.publicKey !== state.responderDevicePublicKey) throw new Error("Only the active Mainframe profile can create recovery authority.");
  const authorizer = await activeSigner(state);
  const recovery = await generateKeyPair();
  try {
    const recoveryPublicKey = await publicKeyOf(recovery);
    const recoverySigner = { sign: (bytes) => sign(recovery.privateKey, ALG_ED25519, bytes) };
    const statement = statementFor(state, "set_recovery", "active", state.activeAuthorityPublicKey, state.responderDevicePublicKey, recoveryPublicKey);
    await invoke({ action: "patient-zero-set-recovery", statement, signature: await signatureOf(authorizer, statement), recoveryProofSignature: await signatureOf(recoverySigner, statement) });
    return {
      kind: "themeshvault-patient-zero-offline-recovery", version: 1,
      deploymentId: PATIENT_ZERO_DEPLOYMENT_ID, recoveryPublicKey,
      privateKeyJwk: await exportPrivateKeyJwk(recovery.privateKey), createdAt: new Date().toISOString(),
    };
  } finally { authorizer.destroy?.(); destroyPrivateKey(recovery.privateKey); }
}

export async function recoverPatientZeroAuthority(recoveryFile) {
  const file = recoveryFile && typeof recoveryFile === "object" ? recoveryFile : {};
  const { state } = await loadAuthority();
  if (file.kind !== "themeshvault-patient-zero-offline-recovery" || file.deploymentId !== PATIENT_ZERO_DEPLOYMENT_ID || file.recoveryPublicKey !== state.recoveryPublicKey) {
    throw new Error("This is not the registered Patient Zero recovery file.");
  }
  const recoveryKey = await importPrivateKeyJwk(file.privateKeyJwk, ALG_ED25519);
  const successor = await generateKeyPair();
  const device = currentDeviceSigner();
  if (!device?.publicKey) throw new Error("The local device identity is unavailable.");
  try {
    const nextPublicKey = await publicKeyOf(successor);
    const pending = { id: "pending", publicKey: nextPublicKey, privateKeyJwk: await exportPrivateKeyJwk(successor.privateKey), savedAt: Date.now() };
    await idb("put", pending);
    const statement = statementFor(state, "rotate", "recovery", nextPublicKey, device.publicKey, state.recoveryPublicKey);
    const recoverySigner = { sign: (bytes) => sign(recoveryKey, ALG_ED25519, bytes) };
    const successorSigner = { sign: (bytes) => sign(successor.privateKey, ALG_ED25519, bytes) };
    const bundle = await invoke({ action: "patient-zero-rotate", statement, signature: await signatureOf(recoverySigner, statement), successorSignature: await signatureOf(successorSigner, statement) });
    await idb("put", { ...pending, id: "active", activatedAt: Date.now() });
    await idb("delete", "pending");
    return bundle;
  } finally { destroyPrivateKey(recoveryKey); destroyPrivateKey(successor.privateKey); }
}
