export const OP_TYPES = Object.freeze({
  CREATE_FILE: "create_file",
  CREATE_FOLDER: "create_folder",
  UPDATE_METADATA: "update_encrypted_metadata",
  PUBLISH_MANIFEST: "publish_manifest",
  DELETE_FILE: "delete_file",
  DELETE_FOLDER: "delete_folder",
  ADD_MANIFEST_REPLICA: "add_manifest_replica",
  REMOVE_FRAGMENT_LOCATION: "remove_stale_fragment_location",
  REGISTER_DEVICE: "register_trusted_device",
  REVOKE_DEVICE: "revoke_trusted_device",
  CREATE_CAPABILITY: "create_sharing_capability",
  REVOKE_CAPABILITY: "revoke_sharing_capability",
  CHANGE_RECOVERY: "change_recovery_material",
});

const REQUIRED_FIELDS = {
  [OP_TYPES.CREATE_FILE]: ["fileId"],
  [OP_TYPES.CREATE_FOLDER]: ["folderId"],
  [OP_TYPES.UPDATE_METADATA]: ["fileId"],
  [OP_TYPES.PUBLISH_MANIFEST]: ["fileId", "fileVersionId", "manifestId", "manifestHash"],
  [OP_TYPES.DELETE_FILE]: ["fileId"],
  [OP_TYPES.DELETE_FOLDER]: ["folderId"],
  [OP_TYPES.ADD_MANIFEST_REPLICA]: ["manifestId", "nodeId"],
  [OP_TYPES.REMOVE_FRAGMENT_LOCATION]: ["shardHash", "nodeId"],
  [OP_TYPES.REGISTER_DEVICE]: ["deviceId", "devicePublicKey", "algorithm"],
  [OP_TYPES.REVOKE_DEVICE]: ["deviceId"],
  [OP_TYPES.CREATE_CAPABILITY]: ["capabilityId", "manifestId"],
  [OP_TYPES.REVOKE_CAPABILITY]: ["capabilityId"],
  [OP_TYPES.CHANGE_RECOVERY]: ["recoveryLookupId"],
};

export function isKnownOpType(opType) { return Object.prototype.hasOwnProperty.call(REQUIRED_FIELDS, opType); }
export function validatePayload(opType, payload) {
  const required = REQUIRED_FIELDS[opType];
  if (!required || !payload || typeof payload !== "object") return false;
  return required.every((field) => payload[field] !== undefined && payload[field] !== null && payload[field] !== "");
}
