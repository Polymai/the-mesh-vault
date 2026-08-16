let worker;
const pending = new Map();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("../workers/erasure.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => { const job = pending.get(data.id); if (!job) return; pending.delete(data.id); data.error ? job.reject(new Error(data.error)) : job.resolve(data.result); };
  }
  return worker;
}
function run(operation, payload, signal) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID(); const instance = getWorker(); pending.set(id, { resolve, reject });
    const abort = () => { pending.delete(id); reject(new DOMException("Operation cancelled", "AbortError")); };
    if (signal?.aborted) return abort(); signal?.addEventListener("abort", abort, { once: true }); instance.postMessage({ id, operation, payload });
  });
}
export const encodeShards = (bytes, dataShards = 4, parityShards = 2, signal) => run("encode", { bytes, dataShards, parityShards }, signal);
export const reconstructShards = (available, originalLength, dataShards = 4, signal) => run("reconstruct", { available, originalLength, dataShards }, signal);
export function terminateErasureWorker() { worker?.terminate(); worker = null; pending.clear(); }
