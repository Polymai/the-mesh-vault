const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));

export function computeAvailabilityScore({
  uptimeSeconds = 0,
  leaseRemainingMs = 0,
  leaseDurationMs = 1,
  wakeLockActive = false,
  persistentStorage = false,
  visible = true,
  successfulTransfers = 0,
  failedTransfers = 0,
  successfulProofs = 0,
  failedProofs = 0,
} = {}) {
  const transferSamples = Number(successfulTransfers) + Number(failedTransfers);
  const proofSamples = Number(successfulProofs) + Number(failedProofs);
  const transferRate = transferSamples ? Number(successfulTransfers) / transferSamples : 0.7;
  const proofRate = proofSamples ? Number(successfulProofs) / proofSamples : 0.7;
  const maturity = clamp(Number(uptimeSeconds) / (24 * 60 * 60));
  const leaseHealth = clamp(Number(leaseRemainingMs) / Math.max(1, Number(leaseDurationMs)));
  const runtimeReadiness = (wakeLockActive ? 0.55 : 0) + (persistentStorage ? 0.3 : 0) + (visible ? 0.15 : 0);
  return clamp(
    leaseHealth * 0.24
      + maturity * 0.2
      + transferRate * 0.2
      + proofRate * 0.2
      + runtimeReadiness * 0.16,
  );
}

export function availabilityLabel(score, leaseActive = true) {
  if (!leaseActive) return "lease expired";
  if (score >= 0.85) return "excellent";
  if (score >= 0.68) return "steady";
  if (score >= 0.5) return "warming up";
  return "unproven";
}
