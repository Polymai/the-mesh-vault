(function () {
  const supabase = window.__POLYMAI_SUPABASE_CONFIG__ || {};
  window.__DATA__ = Object.freeze({
    appId: "app717",
    appName: "TheMeshVault",
    release: Object.freeze({ version: "3.0", build: 62, label: "v3.0.62" }),
    schema: "app717_meshvault",
    authStorageKey: supabase.authStorageKey || "polymai:app717:auth",
    appStoragePrefix: supabase.appStoragePrefix || "polymai:app717:",
    functionsBaseUrl: supabase.functionsBaseUrl || "",
    turn: Object.freeze({ credentialAction: "turn-credentials", ttlSeconds: 900 }),
    protocolVersion: 3,
    minimumProtocolVersion: 3,
    storageFormatVersion: 3,
    segments: Object.freeze({ targetBytes: 8388608, compression: "gzip", minimumSavings: 0.05 }),
    transport: Object.freeze({
      packetBytes: 32768,
      bufferedAmountLimit: 1048576,
      uploadShardConcurrency: 3,
      downloadShardConcurrency: 4,
      peersPerShardRequest: 2,
      uploadPeerProbeTimeoutMs: 2500,
      uploadAttemptTimeoutMs: 30000,
      uploadReceiptTimeoutMs: 30000,
      uploadCandidateAttempts: 2,
      uploadRetryAttempts: 0,
      downloadAttemptTimeoutMs: 120000,
      retryAttempts: 2,
      retryBaseDelayMs: 500,
      hedgedRequestDelayMs: 1200
    }),
    resilience: Object.freeze({
      nodeStaleMs: 720000,
      proofFreshMs: 1800000,
      proofTimeoutMs: 45000,
      repairGraceMs: 1800000,
      surplusGraceMs: 300000,
      maintenanceCycleMs: 900000,
      defaultErasureClass: "auto"
    }),
    placement: Object.freeze({ reserveRatio: 0.05, minimumReserveBytes: 33554432, shardHeadroomRatio: 1.2, qualityRejectAfterSamples: 3, minimumObservedQuality: 0.5 }),
    anchor: Object.freeze({ protocolVersion: 3, minimumProtocolVersion: 3, defaultCacheBytes: 104857600, minimumCacheBytes: 26214400, maximumCacheBytes: 1073741824, replicationTarget: 3, heartbeatMs: 60000, controlObjectMaxBytes: 4194304 }),
    coordination: Object.freeze({
      targetAnchors: 3,
      minimumMeshAnchors: 1,
      reserveAnchors: 2,
      anchorStableMs: 0,
      maximumPeerConnections: 4,
      minimumPeerCandidates: 4,
      discoveryCacheMs: 300000,
      backboneDiscoveryRefreshMs: 600000,
      supabaseHeartbeatMs: 600000,
      anchorPrimaryHeartbeatMs: 120000,
      anchorHeartbeatMs: 120000,
      supabaseBackboneHeartbeatMs: 600000,
      anchorBackboneHeartbeatMs: 600000,
      operationBackboneFlushMs: 300000,
      operationSyncCooldownMs: 1800000,
      operationInitialBatchSize: 200,
      operationDeltaBatchSize: 200,
      operationDeltaMaxBatches: 3,
      liveMeshRefreshMs: 180000,
      networkOverviewRefreshMs: 1800000,
      networkOverviewCacheMs: 1800000,
      foregroundRefreshCooldownMs: 120000,
      heartbeatJitterRatio: 0.15,
      minimumMeshParticipants: 1,
      minimumBackbonePeers: 1,
      participantCacheBytes: 33554432,
      // One bounded cold-start window is allowed per running app lifecycle.
      // It closes after the first verified mesh connection in that lifecycle.
      supabaseAutomaticFallbackEnabled: true,
      supabaseColdStartDelayMs: 2500,
      supabaseFallbackWindowMs: 60000,
      supabaseFallbackCooldownMs: 1800000,
      supabaseBackboneLeaseMs: 900000
    }),
    backbone: Object.freeze({
      protocolVersion: 3,
      seedConnectTimeoutMs: 5000,
      requestTimeoutMs: 15000,
      leaseMs: 120000,
      reconnectMaxMs: 60000,
      seeds: Object.freeze((window.__POLYMAI_BACKBONE_CONFIG__?.seeds || []).filter((value) => {
        const url = typeof value === "string" ? value : value?.url;
        return /^wss:\/\//i.test(String(url || "")) && (typeof value === "string" || !!value?.publicKey);
      }))
    }),
    rendezvous: Object.freeze({
      protocolVersion: 1,
      requestTimeoutMs: 3500,
      descriptorQueryMs: 1800,
      publishTimeoutMs: 2500,
      descriptorRefreshMs: 600000,
      directoryTtlMs: 300000,
      presenceRefreshMs: 120000,
      relayUrls: Object.freeze((window.__POLYMAI_RENDEZVOUS_CONFIG__?.relayUrls || []).filter((value) => /^wss:\/\//i.test(String(value || ""))))
    }),
    survival: Object.freeze({ leaseMs: 180000, renewMs: 30000, buddyCount: 2, handoffTtlMs: 600000, wakeCooldownMs: 120000 }),
    erasureProfiles: Object.freeze([
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "auto", minimumIndependentNodes: 16, dataShards: 10, parityShards: 6, repairThreshold: 13 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "auto", minimumIndependentNodes: 12, dataShards: 8, parityShards: 4, repairThreshold: 10 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "auto", minimumIndependentNodes: 10, dataShards: 7, parityShards: 3, repairThreshold: 9 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "auto", minimumIndependentNodes: 8, dataShards: 6, parityShards: 2, repairThreshold: 7 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "auto", minimumIndependentNodes: 6, dataShards: 4, parityShards: 2, repairThreshold: 5 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "auto", minimumIndependentNodes: 5, dataShards: 3, parityShards: 2, repairThreshold: 4 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "high", minimumIndependentNodes: 16, dataShards: 10, parityShards: 6, repairThreshold: 13 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "standard", minimumIndependentNodes: 16, dataShards: 12, parityShards: 4, repairThreshold: 14 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "standard", minimumIndependentNodes: 12, dataShards: 8, parityShards: 4, repairThreshold: 10 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "standard", minimumIndependentNodes: 10, dataShards: 7, parityShards: 3, repairThreshold: 9 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "standard", minimumIndependentNodes: 8, dataShards: 6, parityShards: 2, repairThreshold: 7 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "standard", minimumIndependentNodes: 6, dataShards: 4, parityShards: 2, repairThreshold: 5 }),
      Object.freeze({ profileVersion: 2, algorithm: "reed-solomon", resilienceClass: "standard", minimumIndependentNodes: 5, dataShards: 3, parityShards: 2, repairThreshold: 4 })
    ]),
    limits: Object.freeze({ maxUploadBytes: 100000000, defaultContributionBytes: 1073741824, maxContributionBytes: 2147483648000 })
  });
})();
