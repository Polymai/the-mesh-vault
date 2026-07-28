(function () {
  const supabase = window.__POLYMAI_SUPABASE_CONFIG__ || {};
  window.__DATA__ = Object.freeze({
    appId: "app717",
    appName: "TheMeshVault",
    schema: "app717_meshvault",
    authStorageKey: supabase.authStorageKey || "polymai:app717:auth",
    appStoragePrefix: supabase.appStoragePrefix || "polymai:app717:",
    functionsBaseUrl: supabase.functionsBaseUrl || "",
    turn: Object.freeze({ credentialAction: "turn-credentials", ttlSeconds: 900 }),
    storageFormatVersion: 2,
    segments: Object.freeze({ targetBytes: 8388608, compression: "gzip", minimumSavings: 0.05 }),
    transport: Object.freeze({ packetBytes: 32768, bufferedAmountLimit: 1048576 }),
    resilience: Object.freeze({
      nodeStaleMs: 120000,
      proofFreshMs: 1800000,
      proofTimeoutMs: 45000,
      repairGraceMs: 1800000,
      surplusGraceMs: 300000,
      defaultErasureClass: "standard"
    }),
    placement: Object.freeze({ reserveRatio: 0.05, minimumReserveBytes: 33554432, shardHeadroomRatio: 1.2, qualityRejectAfterSamples: 3, minimumObservedQuality: 0.5 }),
    anchor: Object.freeze({ protocolVersion: 2, defaultCacheBytes: 104857600, minimumCacheBytes: 26214400, maximumCacheBytes: 1073741824, replicationTarget: 3, heartbeatMs: 60000, controlObjectMaxBytes: 4194304 }),
    coordination: Object.freeze({
      targetAnchors: 3,
      minimumMeshAnchors: 2,
      reserveAnchors: 2,
      anchorStableMs: 120000,
      maximumPeerConnections: 12,
      minimumPeerCandidates: 8,
      supabaseHeartbeatMs: 90000,
      anchorPrimaryHeartbeatMs: 120000,
      anchorHeartbeatMs: 60000,
      heartbeatJitterRatio: 0.15
    }),
    survival: Object.freeze({ leaseMs: 90000, renewMs: 30000, buddyCount: 2, handoffTtlMs: 600000, wakeCooldownMs: 120000 }),
    erasureProfiles: Object.freeze([
      Object.freeze({ resilienceClass: "high", minimumIndependentNodes: 16, dataShards: 10, parityShards: 6, repairThreshold: 13 }),
      Object.freeze({ resilienceClass: "standard", minimumIndependentNodes: 16, dataShards: 12, parityShards: 4, repairThreshold: 14 }),
      Object.freeze({ resilienceClass: "standard", minimumIndependentNodes: 10, dataShards: 7, parityShards: 3, repairThreshold: 9 }),
      Object.freeze({ resilienceClass: "standard", minimumIndependentNodes: 8, dataShards: 6, parityShards: 2, repairThreshold: 7 }),
      Object.freeze({ resilienceClass: "standard", minimumIndependentNodes: 6, dataShards: 4, parityShards: 2, repairThreshold: 5 }),
      Object.freeze({ resilienceClass: "standard", minimumIndependentNodes: 5, dataShards: 3, parityShards: 2, repairThreshold: 4 })
    ]),
    limits: Object.freeze({ maxUploadBytes: 100000000, defaultContributionBytes: 1073741824, maxContributionBytes: 10737418240 })
  });
})();
