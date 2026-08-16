export async function recordAudit(vaultId, eventType, outcome = "success", details = {}) {
  const safe = Object.fromEntries(Object.entries(details).filter(([key]) => !/secret|token|key|password/i.test(key)));
  const event = { vaultId: vaultId || null, eventType: eventType.slice(0, 80), outcome, details: safe, createdAt: Date.now() };
  window.dispatchEvent(new CustomEvent("meshvault:audit", { detail: event }));
  return event;
}
