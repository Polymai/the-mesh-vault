import { canonicalBytes, bytesToBase64Url, base64UrlToBytes, importPublicKeyRaw, verify as verifySignature } from "../../security/signing.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_EXPIRY_MS = 10 * 60 * 1000;
const usedInvites = new Set();
const enc = new TextEncoder();
const dec = new TextDecoder();

async function waitForIceGathering(pc, timeoutMs = 4000) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener("icegatheringstatechange", function onChange() {
      if (pc.iceGatheringState === "complete") { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", onChange); resolve(); }
    });
  });
}
function defaultIceServers(iceServers) { return iceServers?.length ? iceServers : [{ urls: "stun:stun.l.google.com:19302" }]; }

export async function createInviteOffer(deviceIdentity, { expiresInMs = DEFAULT_EXPIRY_MS, singleUse = true, iceServers } = {}) {
  const pc = new RTCPeerConnection({ iceServers: defaultIceServers(iceServers) });
  const channel = pc.createDataChannel("meshvault");
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIceGathering(pc);
  const core = {
    inviteId: crypto.randomUUID(), protocolVersion: PROTOCOL_VERSION, inviterPeerId: deviceIdentity.deviceId,
    inviterDevicePublicKey: deviceIdentity.devicePublicKey, algorithm: deviceIdentity.algorithm,
    offerSdp: pc.localDescription.sdp, expiresAt: Date.now() + expiresInMs, singleUse,
  };
  const signature = bytesToBase64Url(await deviceIdentity.sign(canonicalBytes(core)));
  const invite = { ...core, signature };
  const fragment = bytesToBase64Url(enc.encode(JSON.stringify(invite)));
  const url = `${location.origin}${location.pathname}#/invite/${fragment}`;
  return { invite, url, pc, channel, applyAnswer: (answerSdp) => pc.setRemoteDescription({ type: "answer", sdp: answerSdp }) };
}

async function verifyInvite(invite) {
  if (!invite || invite.protocolVersion !== PROTOCOL_VERSION) return false;
  if (Date.now() > invite.expiresAt) return false;
  if (invite.singleUse && usedInvites.has(invite.inviteId)) return false;
  const { signature, ...core } = invite;
  try {
    const publicKey = await importPublicKeyRaw(base64UrlToBytes(invite.inviterDevicePublicKey), invite.algorithm);
    return verifySignature(publicKey, invite.algorithm, base64UrlToBytes(signature), canonicalBytes(core));
  } catch { return false; }
}

export async function parseInviteFromUrl(url) {
  const match = /#\/invite\/(.+)$/.exec(url);
  if (!match) throw new Error("This does not look like an invite link from TheMeshVault.");
  const invite = JSON.parse(dec.decode(base64UrlToBytes(match[1])));
  if (!(await verifyInvite(invite))) throw new Error("This invite link is invalid, expired, or already used.");
  return invite;
}

export async function acceptInvite(invite, deviceIdentity, { iceServers } = {}) {
  if (invite.singleUse) usedInvites.add(invite.inviteId);
  const pc = new RTCPeerConnection({ iceServers: defaultIceServers(iceServers) });
  const channelPromise = new Promise((resolve) => { pc.ondatachannel = ({ channel }) => resolve(channel); });
  await pc.setRemoteDescription({ type: "offer", sdp: invite.offerSdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIceGathering(pc);
  const core = { inviteId: invite.inviteId, protocolVersion: PROTOCOL_VERSION, answerSdp: pc.localDescription.sdp, responderDevicePublicKey: deviceIdentity.devicePublicKey, algorithm: deviceIdentity.algorithm };
  const signature = bytesToBase64Url(await deviceIdentity.sign(canonicalBytes(core)));
  const reply = { ...core, signature };
  const replyCode = bytesToBase64Url(enc.encode(JSON.stringify(reply)));
  const channel = await channelPromise;
  return { pc, channel, reply, replyCode };
}

export async function applyInviteReply(pc, replyCode) {
  const reply = JSON.parse(dec.decode(base64UrlToBytes(replyCode)));
  await pc.setRemoteDescription({ type: "answer", sdp: reply.answerSdp });
  return reply;
}

export const inviteLinkBootstrapProvider = {
  name: "invite-link",
  async discoverPeers() { return []; },
};
