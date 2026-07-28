import { OP_TYPES } from "../oplog/operation-types.js";

export function reduceDeviceRegistry(envelopes, ownerPublicKey) {
  const devices = new Map();
  devices.set(ownerPublicKey, { deviceId: "owner", devicePublicKey: ownerPublicKey, label: "Owner key", deviceType: "owner", status: "trusted", registeredAt: 0, lastActiveAt: 0 });
  const ordered = [...envelopes].sort((a, b) => a.seq - b.seq);
  for (const envelope of ordered) {
    if (envelope.opType === OP_TYPES.REGISTER_DEVICE) {
      const p = envelope.payload;
      devices.set(p.devicePublicKey, { deviceId: p.deviceId, devicePublicKey: p.devicePublicKey, label: p.label || "Unnamed device", deviceType: p.deviceType || "unknown", status: "trusted", registeredAt: envelope.timestamp, lastActiveAt: envelope.timestamp });
    } else if (envelope.opType === OP_TYPES.REVOKE_DEVICE) {
      for (const device of devices.values()) if (device.deviceId === envelope.payload.deviceId) device.status = "revoked";
    } else {
      const device = devices.get(envelope.actorPublicKey);
      if (device) device.lastActiveAt = Math.max(device.lastActiveAt, envelope.timestamp);
    }
  }
  return devices;
}
export function isActorAuthorized(envelopes, ownerPublicKey, actorPublicKey) {
  if (actorPublicKey === ownerPublicKey) return true;
  return reduceDeviceRegistry(envelopes, ownerPublicKey).get(actorPublicKey)?.status === "trusted";
}
export function listTrustedDevices(envelopes, ownerPublicKey) {
  return Array.from(reduceDeviceRegistry(envelopes, ownerPublicKey).values()).sort((a, b) => a.registeredAt - b.registeredAt);
}
