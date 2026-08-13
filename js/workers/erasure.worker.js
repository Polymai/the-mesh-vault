import { encode, reconstruct } from "../vendor/reed-solomon.js";
self.onmessage = ({ data }) => {
  const { id, operation, payload } = data;
  try {
    const result = operation === "encode" ? encode(payload.bytes, payload.dataShards, payload.parityShards) : reconstruct(payload.available, payload.originalLength, payload.dataShards);
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message || "Erasure operation failed" }); }
};
