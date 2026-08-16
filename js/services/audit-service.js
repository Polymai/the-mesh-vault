import { supabase } from "./supabase.js";

export async function recordAudit(vaultId, eventType, outcome = "success", details = {}) {
  const safe = Object.fromEntries(Object.entries(details).filter(([key]) => !/secret|token|key|password/i.test(key)));
  const { error } = await supabase.schema("app717_meshvault").rpc("record_audit", { p_vault_id: vaultId || null, p_event_type: eventType.slice(0, 80), p_outcome: outcome, p_details: safe });
  if (error) console.warn("Audit event was not recorded", error.message);
}
