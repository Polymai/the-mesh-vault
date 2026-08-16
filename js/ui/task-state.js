import { setState } from "../state/store.js";

const controllers = new Map();
let unloadProtectionCount = 0;
const warnBeforeUnload = (event) => { event.preventDefault(); event.returnValue = ""; };
function protectUnload() { if (++unloadProtectionCount === 1) window.addEventListener("beforeunload", warnBeforeUnload); }
function releaseUnload() { unloadProtectionCount = Math.max(0, unloadProtectionCount - 1); if (!unloadProtectionCount) window.removeEventListener("beforeunload", warnBeforeUnload); }

export function dismissTask(id) {
  setState((state) => { const activeTasks = { ...state.activeTasks }; delete activeTasks[id]; return { activeTasks }; });
}
export function cancelTask(id) { controllers.get(id)?.abort(new DOMException("Operation cancelled", "AbortError")); }

export function createTask(label, timeoutMs = 120000, metadata = {}) {
  const id = crypto.randomUUID(); const controller = new AbortController(); let timer = window.setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs);
  let protectedUnload = !!metadata.preventUnload; let settled = false;
  if (protectedUnload) protectUnload(); controllers.set(id, controller);
  const release = () => { if (settled) return; settled = true; controllers.delete(id); if (protectedUnload) releaseUnload(); };
  const update = (patch) => setState((state) => ({ activeTasks: { ...state.activeTasks, [id]: { ...(state.activeTasks[id] || { id, label, progress: 0, status: "running", ...metadata }), ...patch } } }));
  update({});
  return {
    id, signal: controller.signal,
    progress(value, message) { update({ progress: Math.max(0, Math.min(1, value)), message }); },
    phase(phase, message, details = {}) { update({ phase, message, ...details }); },
    cancel() { controller.abort(); clearTimeout(timer); release(); update({ status: "cancelled", message: "Upload cancelled" }); },
    cancelled(message = "Operation cancelled") { clearTimeout(timer); release(); update({ status: "cancelled", phase: "cancelled", message }); window.setTimeout(() => dismissTask(id), Number(metadata.autoDismissMs || 3500)); },
    done(message = "Complete") { clearTimeout(timer); release(); update({ progress: 1, phase: "complete", status: "complete", message }); window.setTimeout(() => dismissTask(id), Number(metadata.autoDismissMs || 3500)); },
    fail(error) { clearTimeout(timer); release(); update({ status: "failed", phase: "failed", message: error?.message || "Operation failed" }); },
  };
}

function abortReason(signal, fallback = "Operation cancelled") {
  return signal?.reason || new DOMException(fallback, "AbortError");
}

export function delayWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(done, Math.max(0, Number(ms) || 0));
    function done() { signal?.removeEventListener("abort", cancelled); resolve(); }
    function cancelled() { globalThis.clearTimeout(timer); reject(abortReason(signal)); }
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

export async function withTimeout(operation, { timeoutMs = 0, signal, message = "The operation timed out." } = {}) {
  if (signal?.aborted) throw abortReason(signal);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(abortReason(signal));
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = Number(timeoutMs) > 0
    ? globalThis.setTimeout(() => controller.abort(new DOMException(message, "TimeoutError")), Number(timeoutMs))
    : null;
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(abortReason(controller.signal)), { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), aborted]);
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function withRetry(operation, {
  retries = 2,
  signal,
  timeoutMs = 0,
  baseDelayMs = 500,
  onRetry = () => {},
} = {}) {
  let last;
  for (let attempt = 0; attempt <= Math.max(0, Number(retries) || 0); attempt += 1) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await withTimeout(
        (attemptSignal) => operation(attempt, attemptSignal),
        { timeoutMs, signal, message: "The shard attempt timed out." },
      );
    } catch (error) {
      last = error;
      if (signal?.aborted || error?.name === "AbortError" || attempt >= retries) break;
      onRetry(attempt + 1, error);
      await delayWithSignal(Math.max(0, Number(baseDelayMs) || 0) * (2 ** attempt), signal);
    }
  }
  throw last;
}

export async function runConcurrent(items, concurrency, worker, { signal } = {}) {
  const list = Array.from(items || []);
  if (!list.length) return [];
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(abortReason(signal));
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const results = new Array(list.length);
  let cursor = 0;
  const runWorker = async () => {
    while (!controller.signal.aborted) {
      const index = cursor;
      if (index >= list.length) return;
      cursor += 1;
      try { results[index] = await worker(list[index], index, controller.signal); }
      catch (error) { controller.abort(error); throw error; }
    }
    throw abortReason(controller.signal);
  };
  try {
    const count = Math.max(1, Math.min(list.length, Math.trunc(Number(concurrency) || 1)));
    await Promise.all(Array.from({ length: count }, runWorker));
    return results;
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
}
