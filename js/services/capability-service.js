import { appTable, supabase } from "./supabase.js";

export async function publishCapability(capabilityId, manifestId, encryptedCapabilityMetadata, signature, expiresAt, singleUse, downloadLimit) {
  const { error } = await appTable("capability_links").insert({
    capability_id: capabilityId, manifest_id: manifestId, encrypted_capability_metadata: encryptedCapabilityMetadata,
    signature, expires_at: new Date(expiresAt).toISOString(), single_use: !!singleUse, download_limit: downloadLimit || null,
  });
  if (error) throw new Error("Could not publish this share link.");
}
export async function fetchCapability(capabilityId) {
  const { data, error } = await appTable("capability_links").select("*").eq("capability_id", capabilityId).maybeSingle();
  if (error || !data) return null; return data;
}
export async function redeemCapability(capabilityId) {
  const { data, error } = await supabase.schema("app717_meshvault").rpc("redeem_capability_link", { p_capability_id: capabilityId });
  if (error) throw new Error("This link is no longer available.");
  return data;
}
export async function revokeCapability(capabilityId) {
  const { error } = await appTable("capability_links").update({ revoked: true }).eq("capability_id", capabilityId);
  if (error) throw new Error("Could not revoke this share link.");
}
