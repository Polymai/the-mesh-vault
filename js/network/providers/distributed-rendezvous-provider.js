import { finalizeEvent, verifyEvent, nip44v2 } from "../../vendor/nostr-tools.bundle.js";
import { loadOrCreateRendezvousIdentity } from "../rendezvous/transport-identity.js";
import { RelayPool } from "../rendezvous/relay-pool.js";
import {
  RENDEZVOUS_DESCRIPTOR_KIND, RENDEZVOUS_DESCRIPTOR_TAG, RENDEZVOUS_EVENT_KIND, RENDEZVOUS_TAG,
  normalizeDescriptorPayload, normalizeDirectoryPayload, safePresence, signAuthorityObject, signPresenceObject,
  verifyAuthorityObject, verifyPresenceObject,
} from "../rendezvous/bootstrap-protocol.js";

const DESCRIPTOR_TYPE = "tmv-responder-directory-v1";
const DIRECTORY_TYPE = "tmv-peer-directory-v1";
const DIRECTORY_TTL_MS = 5 * 60 * 1000;
const DESCRIPTOR_TTL_MS = 60 * 60 * 1000;
const REQUEST_COOLDOWN_MS = 3000;
const MAX_KNOWN_PEERS = 200;

let context = { nodeId: null, signer: null, getPresencePayload: () => null };
let transport = null;
let pool = null;
let readyPromise = null;
let unsubscribeMessages = null;
let presenceListeners = new Set();
let signalListeners = new Set();
let responders = [];
let knownPeers = new Map();
let nodeTransportKeys = new Map();
let pendingRequests = new Map();
let lastRequestAt = 0;
let lastDescriptorAt = 0;
let presenceRefreshTimer = null;

function config() { return window.__POLYMAI_RENDEZVOUS_CONFIG__ || {}; }
function runtime() { return window.__DATA__?.rendezvous || {}; }
function allowedAuthorities() { return [...new Set((config().authorityPublicKeys || []).map(String))]; }
function isAuthority() { return !!context.signer?.publicKey && allowedAuthorities().includes(context.signer.publicKey); }
function unixSeconds() { return Math.floor(Date.now() / 1000); }

function statusSnapshot(error = null) {
  return {
    enabled: config().enabled !== false,
    trustedAuthorities: allowedAuthorities().length,
    authority: isAuthority(),
    transportPublicKey: transport?.publicKey || null,
    responders: responders.length,
    peers: knownPeers.size,
    relays: pool?.status() || { configured: (config().relayUrls || []).length, connected: 0 },
    error: error ? String(error.message || error) : null,
  };
}

function notifyStatus(error = null) {
  const detail = statusSnapshot(error);
  window.__TMV_RENDEZVOUS_STATUS__ = detail;
  window.dispatchEvent(new CustomEvent("meshvault:rendezvous-status", { detail }));
}

async function rememberPeer(transportPublicKey, presenceEnvelope) {
  if (!/^[0-9a-f]{64}$/i.test(transportPublicKey || "")) return null;
  const verified = await verifyPresenceObject(presenceEnvelope, transportPublicKey);
  if (!verified) return null;
  const entry = {
    transportPublicKey: transportPublicKey.toLowerCase(),
    presence: verified.presence,
    presenceEnvelope: verified,
    observedAt: Date.now(),
  };
  knownPeers.set(verified.presence.nodeId, entry);
  nodeTransportKeys.set(verified.presence.nodeId, entry.transportPublicKey);
  while (knownPeers.size > MAX_KNOWN_PEERS) knownPeers.delete(knownPeers.keys().next().value);
  return entry;
}

async function signedOwnPresence() {
  const presence = safePresence(context.getPresencePayload?.());
  if (!presence || !transport || !context.signer) return null;
  return signPresenceObject(context.signer, transport.publicKey, presence, DIRECTORY_TTL_MS);
}

function presenceResult(entry) {
  const value = entry.presence;
  return { ...value, peerId: value.nodeId, source: "distributed-rendezvous" };
}

async function encryptFor(recipientPublicKey, value) {
  const conversationKey = nip44v2.utils.getConversationKey(transport.secretKey, recipientPublicKey);
  return nip44v2.encrypt(JSON.stringify(value), conversationKey);
}

async function decryptFrom(senderPublicKey, value) {
  const conversationKey = nip44v2.utils.getConversationKey(transport.secretKey, senderPublicKey);
  return JSON.parse(nip44v2.decrypt(value, conversationKey));
}

async function publishEncrypted(recipientPublicKey, message) {
  if (!pool || !transport || !/^[0-9a-f]{64}$/i.test(recipientPublicKey || "")) return false;
  const content = await encryptFor(recipientPublicKey, message);
  const event = finalizeEvent({
    kind: RENDEZVOUS_EVENT_KIND,
    created_at: unixSeconds(),
    tags: [["p", recipientPublicKey], ["t", RENDEZVOUS_TAG]],
    content,
  }, transport.secretKey);
  return (await pool.publish(event, Number(runtime().publishTimeoutMs || 2500))) > 0;
}

async function publishDescriptor(force = false) {
  if (!isAuthority() || !pool || !transport) return false;
  if (!force && Date.now() - lastDescriptorAt < Number(runtime().descriptorRefreshMs || 10 * 60 * 1000)) return true;
  const descriptor = await signAuthorityObject(context.signer, DESCRIPTOR_TYPE, {
    responders: [{ authorityPublicKey: context.signer.publicKey, transportPublicKey: transport.publicKey }],
  }, DESCRIPTOR_TTL_MS);
  const event = finalizeEvent({
    kind: RENDEZVOUS_DESCRIPTOR_KIND,
    created_at: unixSeconds(),
    tags: [["d", RENDEZVOUS_DESCRIPTOR_TAG], ["t", RENDEZVOUS_TAG]],
    content: JSON.stringify(descriptor),
  }, transport.secretKey);
  const sent = await pool.publish(event, Number(runtime().publishTimeoutMs || 2500));
  if (sent) lastDescriptorAt = Date.now();
  return sent > 0;
}

async function loadResponders() {
  const authorities = allowedAuthorities();
  const found = [];
  if (isAuthority() && transport?.publicKey) {
    found.push({ authorityPublicKey: context.signer.publicKey, transportPublicKey: transport.publicKey });
  }
  for (const staticEntry of config().staticResponders || []) {
    if (authorities.includes(staticEntry?.authorityPublicKey) && /^[0-9a-f]{64}$/i.test(staticEntry?.transportPublicKey || "")) {
      found.push({ authorityPublicKey: staticEntry.authorityPublicKey, transportPublicKey: staticEntry.transportPublicKey.toLowerCase() });
    }
  }
  const events = await pool.query({ kinds: [RENDEZVOUS_DESCRIPTOR_KIND], "#d": [RENDEZVOUS_DESCRIPTOR_TAG], "#t": [RENDEZVOUS_TAG], limit: 20 }, Number(runtime().descriptorQueryMs || 1800));
  for (const event of events) {
    if (!verifyEvent(event)) continue;
    let value;
    try { value = JSON.parse(event.content); } catch { continue; }
    const verified = await verifyAuthorityObject(value, authorities, DESCRIPTOR_TYPE);
    if (!verified) continue;
    for (const entry of normalizeDescriptorPayload(verified.payload).responders) {
      if (entry.transportPublicKey === event.pubkey && entry.authorityPublicKey === verified.authorityPublicKey) found.push(entry);
    }
  }
  responders = [...new Map(found.map((entry) => [entry.transportPublicKey, entry])).values()].slice(0, 12);
  notifyStatus();
  return responders;
}

async function sendDirectory(recipientPublicKey, requestId) {
  const own = await signedOwnPresence();
  if (own) await rememberPeer(transport.publicKey, own);
  const peers = [...knownPeers.values()]
    .filter((entry) => Date.now() - entry.observedAt < DIRECTORY_TTL_MS)
    .slice(-50)
    .map((entry) => ({ transportPublicKey: entry.transportPublicKey, presenceEnvelope: entry.presenceEnvelope }));
  const directory = await signAuthorityObject(context.signer, DIRECTORY_TYPE, { peers }, DIRECTORY_TTL_MS);
  await publishEncrypted(recipientPublicKey, { type: "bootstrap-response", requestId, directory });
}

async function acceptMessage(event) {
  if (!transport || !verifyEvent(event) || event.kind !== RENDEZVOUS_EVENT_KIND || !event.tags.some((tag) => tag[0] === "p" && tag[1] === transport.publicKey)) return;
  let message;
  try { message = await decryptFrom(event.pubkey, event.content); } catch { return; }
  if (!message || typeof message.type !== "string") return;
  if (message.type === "bootstrap-request" || message.type === "presence") {
    const entry = await rememberPeer(event.pubkey, message.presenceEnvelope);
    if (entry) presenceListeners.forEach((listener) => { try { listener([presenceResult(entry)]); } catch {} });
    if (entry && isAuthority() && message.type === "bootstrap-request" && typeof message.requestId === "string") await sendDirectory(event.pubkey, message.requestId).catch(() => {});
    return;
  }
  if (message.type === "bootstrap-response" && typeof message.requestId === "string") {
    const verified = await verifyAuthorityObject(message.directory, allowedAuthorities(), DIRECTORY_TYPE);
    if (!verified) return;
    const entries = (await Promise.all(normalizeDirectoryPayload(verified.payload).peers
      .map((entry) => rememberPeer(entry.transportPublicKey, entry.presenceEnvelope)))).filter(Boolean);
    if (entries.length) presenceListeners.forEach((listener) => { try { listener(entries.map(presenceResult)); } catch {} });
    pendingRequests.get(message.requestId)?.(entries);
    pendingRequests.delete(message.requestId);
    notifyStatus();
    return;
  }
  if (message.type === "signal" && message.signal?.toNodeId === context.nodeId && message.signal?.fromNodeId) {
    if (nodeTransportKeys.get(message.signal.fromNodeId) !== event.pubkey) return;
    signalListeners.forEach((listener) => { try { listener(message.signal); } catch {} });
  }
}

async function ensureReady() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (config().enabled === false || !(config().relayUrls || []).length) return statusSnapshot();
    // Do not contact any public relay until a deployment has explicitly pinned
    // at least one Patient Zero public device key. An empty trust set is a
    // deliberate disabled state, not an invitation to perform anonymous scans.
    if (!allowedAuthorities().length) {
      notifyStatus();
      return statusSnapshot();
    }
    transport = await loadOrCreateRendezvousIdentity();
    pool = new RelayPool(config().relayUrls);
    unsubscribeMessages = pool.subscribe({ kinds: [RENDEZVOUS_EVENT_KIND], "#p": [transport.publicKey], "#t": [RENDEZVOUS_TAG], since: unixSeconds() - 60 }, (event) => acceptMessage(event).catch(() => {}));
    if (isAuthority()) await publishDescriptor(true).catch((error) => notifyStatus(error));
    await loadResponders().catch((error) => notifyStatus(error));
    schedulePresenceRefresh();
    notifyStatus();
    return statusSnapshot();
  })();
  return readyPromise;
}

function schedulePresenceRefresh() {
  clearTimeout(presenceRefreshTimer);
  presenceRefreshTimer = null;
  if (!allowedAuthorities().length || config().enabled === false) return;
  presenceRefreshTimer = setTimeout(async () => {
    try { await distributedRendezvousProvider.publishPresence(); }
    catch (error) { notifyStatus(error); }
    finally { schedulePresenceRefresh(); }
  }, Math.max(30000, Number(runtime().presenceRefreshMs || 120000)));
}

async function requestDirectory(force = false) {
  await ensureReady();
  if (!allowedAuthorities().length) return [];
  if (!force && Date.now() - lastRequestAt < REQUEST_COOLDOWN_MS && knownPeers.size) return [...knownPeers.values()];
  lastRequestAt = Date.now();
  if (!responders.length) await loadResponders();
  const requestId = crypto.randomUUID();
  const wait = new Promise((resolve) => {
    const timer = setTimeout(() => { pendingRequests.delete(requestId); resolve([]); }, Number(runtime().requestTimeoutMs || 3500));
    pendingRequests.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
  });
  const presenceEnvelope = await signedOwnPresence();
  await Promise.all(responders.map((entry) => publishEncrypted(entry.transportPublicKey, { type: "bootstrap-request", requestId, presenceEnvelope }).catch(() => false)));
  await wait;
  return [...knownPeers.values()];
}

export function configureDistributedRendezvous({ nodeId, signer, getPresencePayload } = {}) {
  context = { nodeId, signer, getPresencePayload: typeof getPresencePayload === "function" ? getPresencePayload : () => null };
  ensureReady().catch((error) => notifyStatus(error));
}

export async function patientZeroPublicSetup() {
  await ensureReady();
  // Exporting public setup must work before the trust key is deployed, while
  // still avoiding any relay connection. The transport secret remains inside
  // this browser's IndexedDB and is never included in the exported object.
  if (!transport) transport = await loadOrCreateRendezvousIdentity();
  if (!context.signer?.publicKey || !transport?.publicKey) throw new Error("This device's public setup is not ready.");
  return {
    protocol: 1,
    authorityPublicKey: context.signer.publicKey,
    transportPublicKey: transport.publicKey,
    relayUrls: [...(config().relayUrls || [])],
    secretMaterialIncluded: false,
  };
}

export function distributedRendezvousStatus() { return statusSnapshot(); }

export async function disconnectDistributedRendezvous() {
  clearTimeout(presenceRefreshTimer); presenceRefreshTimer = null;
  unsubscribeMessages?.(); unsubscribeMessages = null;
  pool?.close(); pool = null; readyPromise = null; responders = [];
  for (const resolve of pendingRequests.values()) resolve([]);
  pendingRequests.clear();
}

export const distributedRendezvousProvider = {
  name: "distributed-rendezvous",
  async discoverPeers() { return (await requestDirectory()).map(presenceResult).filter((peer) => peer.peerId !== context.nodeId); },
  async publishPresence() {
    await ensureReady();
    const presenceEnvelope = await signedOwnPresence();
    if (!presenceEnvelope) return [];
    const ownEntry = await rememberPeer(transport.publicKey, presenceEnvelope);
    if (!ownEntry) return [];
    if (isAuthority()) await publishDescriptor();
    if (!responders.length) await loadResponders();
    await Promise.all(responders.filter((entry) => entry.transportPublicKey !== transport.publicKey).map((entry) => publishEncrypted(entry.transportPublicKey, { type: "presence", presenceEnvelope }).catch(() => false)));
    return [presenceResult(ownEntry)];
  },
  onPresence(handler) { presenceListeners.add(handler); return () => presenceListeners.delete(handler); },
  async sendSignal(signal) {
    await ensureReady();
    let recipient = nodeTransportKeys.get(signal?.toNodeId);
    if (!recipient) { await requestDirectory(true); recipient = nodeTransportKeys.get(signal?.toNodeId); }
    return recipient ? publishEncrypted(recipient, { type: "signal", signal }) : false;
  },
  onSignal(handler) { signalListeners.add(handler); return () => signalListeners.delete(handler); },
};
