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
    done(message = "Complete") { clearTimeout(timer); release(); update({ progress: 1, phase: "complete", status: "complete", message }); window.setTimeout(() => dismissTask(id), 3500); },
    fail(error) { clearTimeout(timer); release(); update({ status: "failed", phase: "failed", message: error?.message || "Operation failed" }); },
  };
}
export async function withRetry(operation, { retries = 2, signal, onRetry = () => {} } = {}) { let last; for (let attempt = 0; attempt <= retries; attempt++) { if (signal?.aborted) throw signal.reason || new DOMException("Cancelled", "AbortError"); try { return await operation(attempt); } catch (error) { last = error; if (attempt === retries) break; onRetry(attempt + 1, error); await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt)); } } throw last; }
