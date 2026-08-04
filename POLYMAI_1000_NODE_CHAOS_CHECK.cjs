const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, "test-artifacts", "scale-chaos");
const MiB = 1024 * 1024;
const INITIAL_NODE_COUNT = 1000;
const JOINING_NODE_COUNT = 250;
const JOINING_ANCHOR_COUNT = 20;
const TEST_FILE_BYTES = 17 * MiB;
const SIMULATION_START = Date.parse("2026-07-25T08:00:00.000Z");
const ACTIVE_STATUSES = new Set(["stored", "verified", "surplus"]);

function loadRuntime() {
  const sandbox = { window: { __POLYMAI_SUPABASE_CONFIG__: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "data", "runtime-config.js"), "utf8"), sandbox);
  return sandbox.window.__DATA__;
}

function seededRandom(seed = 0x717c0de) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function shuffled(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function xml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ["B", "KiB", "MiB", "GiB"];
  let unit = 0;
  let amount = bytes;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 100 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function markdownTable(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, rule, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

async function main() {
  const startedAt = performance.now();
  const runtime = loadRuntime();
  const placement = await import(pathToFileURL(path.join(ROOT, "js", "network", "placement-engine.js")).href);
  const lifecycle = await import(pathToFileURL(path.join(ROOT, "js", "network", "shard-lifecycle.js")).href);
  const resilience = await import(pathToFileURL(path.join(ROOT, "js", "network", "resilience.js")).href);
  const compression = await import(pathToFileURL(path.join(ROOT, "js", "security", "compression.js")).href);
  const keyring = await import(pathToFileURL(path.join(ROOT, "js", "security", "keyring.js")).href);
  const reedSolomon = await import(pathToFileURL(path.join(ROOT, "js", "vendor", "reed-solomon.js")).href);
  const random = seededRandom();
  const nodes = new Map();
  const snapshots = [];
  const events = [];
  const counters = {
    shardRepairs: 0,
    repairBytes: 0,
    blockedRepairs: 0,
    surplusMarked: 0,
    surplusRetired: 0,
    anchorRepairs: 0,
    anchorRetirements: 0,
  };
  let placementSequence = 0;
  let now = SIMULATION_START;

  const initialCountries = ["SE", "NO", "DK", "FI", "DE", "NL", "BE", "FR", "ES", "PT", "IT", "AT", "CH", "PL", "CZ", "SK", "IE", "GB", "HR", "GR"];
  const joiningCountries = ["IS", "EE", "LV", "LT", "SI", "LU", "MT", "CY"];
  const capacityOptions = [512 * MiB, 1024 * MiB, 2 * 1024 * MiB, 4 * 1024 * MiB, 8 * 1024 * MiB, 16 * 1024 * MiB];

  function makeNode(index, { prefix = "node", joined = false, forceAnchor = false } = {}) {
    const countries = joined ? joiningCountries : initialCountries;
    const country = countries[index % countries.length];
    const capacityBytes = joined ? capacityOptions[4 + (index % 2)] : capacityOptions[index % capacityOptions.length];
    const baselineUsed = Math.floor(capacityBytes * (joined ? 0.08 + random() * 0.12 : 0.08 + random() * 0.58));
    const reliability = joined ? 0.94 + random() * 0.055 : 0.57 + random() * 0.425;
    const successfulTransfers = 8 + Math.floor(random() * 90);
    const failedTransfers = Math.floor(random() * 4);
    const successfulProofs = 8 + Math.floor(random() * 90);
    const failedProofs = Math.floor(random() * 3);
    const node = {
      id: `${prefix}-${String(index).padStart(4, "0")}`,
      failure_domain_id: `${prefix}-device-${String(index).padStart(4, "0")}`,
      browser_profile_domain: `${prefix}-profile-${String(index).padStart(4, "0")}`,
      country_code: country,
      region_code: `${country}-${1 + (index % 4)}`,
      network_domain_hash: `${prefix}-network-${index % 240}`,
      capacity_bytes: capacityBytes,
      used_bytes: baselineUsed,
      baseline_used_bytes: baselineUsed,
      reliability_score: reliability,
      is_anchor: forceAnchor || index % 10 === 0,
      generation: joined ? "joined" : "initial",
      online: true,
      store: new Map(),
      peer: {
        protocol: {
          metrics: () => ({
            successfulTransfers,
            failedTransfers,
            successfulProofs,
            failedProofs,
            rttEwmaMs: joined ? 18 + random() * 12 : 22 + random() * 130,
            throughputEwmaBps: joined ? 18 * MiB + random() * 10 * MiB : 2 * MiB + random() * 18 * MiB,
          }),
        },
      },
    };
    nodes.set(node.id, node);
    return node;
  }

  for (let index = 0; index < INITIAL_NODE_COUNT; index += 1) makeNode(index);
  assert.equal(nodes.size, INITIAL_NODE_COUNT);
  assert.equal([...nodes.values()].filter((node) => node.is_anchor).length, 100);

  const profile = lifecycle.selectErasureProfile(runtime.erasureProfiles, INITIAL_NODE_COUNT, "standard");
  assert.deepEqual(
    {
      dataShards: profile.dataShards,
      parityShards: profile.parityShards,
      repairThreshold: profile.repairThreshold,
      totalShards: profile.totalShards,
    },
    { dataShards: 12, parityShards: 4, repairThreshold: 14, totalShards: 16 },
  );

  const original = new Uint8Array(TEST_FILE_BYTES);
  const phrase = new TextEncoder().encode("TheMeshVault scale test keeps readable bytes local. ");
  for (let index = 0; index < 8 * MiB; index += 1) original[index] = phrase[index % phrase.length];
  for (let index = 8 * MiB; index < 16 * MiB; index += 1) original[index] = Math.floor(random() * 256);
  for (let index = 16 * MiB; index < original.length; index += 1) original[index] = (index * 31 + 17) & 255;
  const originalHash = await keyring.hashBytes(original);
  const masterKey = Uint8Array.from({ length: 32 }, (_, index) => (index * 19 + 7) & 255);
  await keyring.initializeKeyring(masterKey);

  const segments = [];
  const originalHolderSets = [];
  const uploadFileContext = placement.createFilePlacementContext([], {
    expectedPlacements: Math.ceil(original.length / runtime.segments.targetBytes) * profile.totalShards,
    candidateCount: INITIAL_NODE_COUNT,
  });

  function onlineCandidates() {
    return [...nodes.values()].filter((node) => node.online);
  }

  function addPlacement(shard, node, bytes, { status = "verified", role = "durable", repaired = false } = {}) {
    if (node.store.has(shard.id)) throw new Error(`${node.id} already holds ${shard.id}`);
    const stored = new Uint8Array(bytes);
    node.store.set(shard.id, stored);
    node.used_bytes += stored.byteLength;
    const row = {
      id: `placement-${++placementSequence}`,
      shard_id: shard.id,
      node_id: node.id,
      failure_domain_id: node.failure_domain_id,
      country_code: node.country_code,
      region_code: node.region_code,
      network_domain_hash: node.network_domain_hash,
      role,
      status,
      live: node.online,
      repaired,
      created_at: new Date(now).toISOString(),
      last_proof_at: new Date(now).toISOString(),
      node: { reliability_score: node.reliability_score },
    };
    shard.shard_placements.push(row);
    return row;
  }

  for (let offset = 0, segmentIndex = 0; offset < original.length; offset += runtime.segments.targetBytes, segmentIndex += 1) {
    const plain = original.slice(offset, Math.min(original.length, offset + runtime.segments.targetBytes));
    const plainHash = await keyring.hashBytes(plain);
    const compressed = await compression.compressAdaptive(plain, {
      name: "scale-chaos.bin",
      mime: "application/octet-stream",
      minimumSavings: runtime.segments.minimumSavings,
    });
    const rawKey = Uint8Array.from({ length: 32 }, (_, index) => (segmentIndex * 47 + index * 13 + 11) & 255);
    const aad = `meshvault-scale-chaos:${segmentIndex}:${plainHash}`;
    const cipher = await keyring.encryptBytes(compressed.bytes, rawKey, aad);
    const cipherHash = await keyring.hashBytes(cipher);
    const layout = reedSolomon.encode(cipher, profile.dataShards, profile.parityShards);
    const shardRows = [];
    for (let shardIndex = 0; shardIndex < layout.shards.length; shardIndex += 1) {
      const bytes = new Uint8Array(layout.shards[shardIndex]);
      shardRows.push({
        id: `segment-${segmentIndex}-shard-${shardIndex}`,
        shard_index: shardIndex,
        shard_hash: await keyring.hashBytes(bytes),
        size_bytes: bytes.byteLength,
        expected_bytes: bytes,
        shard_placements: [],
      });
    }
    const segment = {
      id: `segment-${segmentIndex}`,
      segment_index: segmentIndex,
      original_size_bytes: plain.byteLength,
      stored_size_bytes: compressed.bytes.byteLength,
      cipher_size_bytes: cipher.byteLength,
      compression_method: compressed.method,
      compression_savings: compressed.savings,
      plain_hash: plainHash,
      cipher_hash: cipherHash,
      aad,
      raw_key: rawKey,
      data_shards: profile.dataShards,
      parity_shards: profile.parityShards,
      required_shards: profile.requiredShards,
      repair_threshold: profile.repairThreshold,
      total_shards: profile.totalShards,
      segment_shards: shardRows,
    };
    const placementContext = placement.createPlacementContext();
    for (const shard of shardRows) {
      const ranked = placement.rankPlacementCandidates(onlineCandidates(), {
        context: placementContext,
        fileContext: uploadFileContext,
        placementKey: `scale-file-v1:${segmentIndex}:${shard.shard_index}`,
        shardBytes: shard.size_bytes,
        config: runtime.placement,
      });
      assert(ranked.length, `No placement candidate for ${shard.id}`);
      const target = ranked[0];
      addPlacement(shard, target, shard.expected_bytes);
      placement.recordPlacementChoice(placementContext, target);
      placement.recordFilePlacementChoice(uploadFileContext, target, shard.size_bytes, `${segment.id}:${shard.id}:${target.id}`);
    }
    assert.equal(placementContext.domains.size, profile.totalShards, "A shard group reused a device failure domain.");
    originalHolderSets.push(new Set(shardRows.map((shard) => shard.shard_placements[0].node_id)));
    segments.push(segment);
  }

  function activePlacement(shard) {
    return (shard.shard_placements || []).find((row) => {
      const node = nodes.get(row.node_id);
      return node?.online && row.role === "durable" && ACTIVE_STATUSES.has(row.status) && node.store.has(shard.id);
    }) || null;
  }

  function activeShardIds(segment) {
    return new Set(segment.segment_shards.filter((shard) => activePlacement(shard)).map((shard) => shard.id));
  }

  function activeFileHolderIds() {
    return new Set(segments.flatMap((segment) => segment.segment_shards.flatMap((shard) => {
      const active = activePlacement(shard);
      return active ? [active.node_id] : [];
    })));
  }

  function activeHoldersPerSegment(count, preferred = []) {
    return segments.flatMap((segment) => {
      const holders = segment.segment_shards.map((shard) => activePlacement(shard)?.node_id).filter(Boolean);
      return [...new Set([...preferred.filter((id) => holders.includes(id)), ...holders])].slice(0, count);
    });
  }

  function physicalShardCopies() {
    let count = 0;
    let bytes = 0;
    for (const node of nodes.values()) {
      count += node.store.size;
      for (const shardBytes of node.store.values()) bytes += shardBytes.byteLength;
    }
    return { count, bytes };
  }

  function reachablePlacementCopies() {
    let count = 0;
    for (const segment of segments) for (const shard of segment.segment_shards) {
      for (const row of shard.shard_placements) {
        const node = nodes.get(row.node_id);
        if (node?.online && ACTIVE_STATUSES.has(row.status) && node.store.has(shard.id)) count += 1;
      }
    }
    return count;
  }

  function currentFileResilience() {
    return resilience.calculateFileResilience(segments);
  }

  async function recoverFile() {
    const chunks = [];
    for (const segment of segments) {
      const available = [];
      for (const shard of segment.segment_shards) {
        const row = activePlacement(shard);
        if (!row) continue;
        const bytes = nodes.get(row.node_id).store.get(shard.id);
        if ((await keyring.hashBytes(bytes)) !== shard.shard_hash) continue;
        available.push({ index: shard.shard_index, bytes });
      }
      if (available.length < segment.required_shards) {
        return {
          verified: false,
          reason: `Segment ${segment.segment_index} has ${available.length} of ${segment.required_shards} required shards.`,
        };
      }
      const cipher = reedSolomon.reconstruct(available, segment.cipher_size_bytes, segment.data_shards);
      assert.equal(await keyring.hashBytes(cipher), segment.cipher_hash, "Reconstructed cipher hash mismatch.");
      const representation = await keyring.decryptBytes(cipher, segment.raw_key, segment.aad);
      const plain = await compression.decompressSegment(representation, segment.compression_method);
      assert.equal(await keyring.hashBytes(plain), segment.plain_hash, "Recovered segment hash mismatch.");
      chunks.push(plain);
    }
    const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let writeOffset = 0;
    for (const chunk of chunks) {
      output.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }
    const outputHash = await keyring.hashBytes(output);
    return {
      verified: output.byteLength === original.byteLength
        && outputHash === originalHash
        && Buffer.compare(Buffer.from(output), Buffer.from(original)) === 0,
      outputBytes: output.byteLength,
      outputHash,
    };
  }

  const anchorCopies = new Set();
  function onlineAnchors() {
    return [...nodes.values()].filter((node) => node.online && node.is_anchor)
      .sort((left, right) => right.reliability_score - left.reliability_score || left.id.localeCompare(right.id));
  }

  function reconcileAnchors({ retireSurplus = false } = {}) {
    const target = runtime.anchor.replicationTarget;
    let liveCopies = [...anchorCopies].filter((id) => nodes.get(id)?.online);
    for (const candidate of onlineAnchors()) {
      if (liveCopies.length >= target) break;
      if (anchorCopies.has(candidate.id)) continue;
      anchorCopies.add(candidate.id);
      liveCopies.push(candidate.id);
      counters.anchorRepairs += 1;
    }
    if (retireSurplus && liveCopies.length > target) {
      const keep = new Set(liveCopies
        .sort((left, right) => nodes.get(right).reliability_score - nodes.get(left).reliability_score)
        .slice(0, target));
      for (const id of liveCopies) {
        if (keep.has(id)) continue;
        anchorCopies.delete(id);
        counters.anchorRetirements += 1;
      }
      liveCopies = [...keep];
    }
    assert(liveCopies.length >= Math.min(target, onlineAnchors().length), "Anchor replica target was not restored.");
    return liveCopies.length;
  }

  function setOffline(ids, { immediate = false } = {}) {
    for (const id of ids) {
      const node = nodes.get(id);
      if (!node || !node.online) continue;
      node.online = false;
      for (const segment of segments) for (const shard of segment.segment_shards) {
        for (const row of shard.shard_placements.filter((item) => item.node_id === id && !["retired", "deleted"].includes(item.status))) {
          const next = lifecycle.nextOfflinePlacementState(row, immediate ? now + runtime.resilience.repairGraceMs : now, immediate ? 0 : runtime.resilience.repairGraceMs);
          if (!next) continue;
          row.status = next.status;
          row.unavailable_since = next.unavailableSince;
          row.live = false;
        }
      }
    }
  }

  function ageOfflinePlacements() {
    for (const segment of segments) for (const shard of segment.segment_shards) {
      for (const row of shard.shard_placements.filter((item) => item.status === "suspect")) {
        const next = lifecycle.nextOfflinePlacementState(row, now, runtime.resilience.repairGraceMs);
        row.status = next.status;
        row.unavailable_since = next.unavailableSince;
      }
    }
  }

  function setOnline(ids) {
    for (const id of ids) {
      const node = nodes.get(id);
      if (!node || node.online) continue;
      node.online = true;
      for (const segment of segments) for (const shard of segment.segment_shards) {
        for (const row of shard.shard_placements.filter((item) => item.node_id === id && node.store.has(shard.id) && !["retired", "deleted"].includes(item.status))) {
          row.status = "verified";
          row.unavailable_since = null;
          row.last_proof_at = new Date(now).toISOString();
          row.live = true;
        }
      }
    }
  }

  async function repairSegment(segment, fileContext) {
    const activeIds = activeShardIds(segment);
    const planned = lifecycle.planShardRepairs(segment, activeIds);
    if (!planned.length) return { planned: 0, repaired: 0, blocked: false, joinedPlacements: 0 };
    const available = segment.segment_shards.flatMap((shard) => {
      const row = activePlacement(shard);
      return row ? [{ index: shard.shard_index, bytes: nodes.get(row.node_id).store.get(shard.id) }] : [];
    });
    if (available.length < segment.required_shards) {
      counters.blockedRepairs += planned.length;
      return { planned: planned.length, repaired: 0, blocked: true, joinedPlacements: 0 };
    }
    const cipher = reedSolomon.reconstruct(available, segment.cipher_size_bytes, segment.data_shards);
    assert.equal(await keyring.hashBytes(cipher), segment.cipher_hash);
    const rebuilt = reedSolomon.encode(cipher, segment.data_shards, segment.parity_shards);
    const existing = segment.segment_shards.flatMap((shard) => {
      const row = activePlacement(shard);
      return row ? [row] : [];
    });
    const context = placement.createPlacementContext(existing);
    let repaired = 0;
    let joinedPlacements = 0;
    for (const shardId of planned) {
      const shard = segment.segment_shards.find((item) => item.id === shardId);
      const bytes = new Uint8Array(rebuilt.shards[shard.shard_index]);
      assert.equal(await keyring.hashBytes(bytes), shard.shard_hash, "A repair produced a different shard hash.");
      const ranked = placement.rankPlacementCandidates(onlineCandidates(), {
        context,
        fileContext,
        placementKey: `scale-file-v1:${segment.segment_index}:${shard.shard_index}:repair`,
        shardBytes: bytes.byteLength,
        config: runtime.placement,
      });
      assert(ranked.length, `No repair target for ${shard.id}`);
      const target = ranked[0];
      addPlacement(shard, target, bytes, { repaired: true });
      placement.recordPlacementChoice(context, target);
      placement.recordFilePlacementChoice(fileContext, target, bytes.byteLength, `${segment.id}:${shard.id}:${target.id}:repair`);
      counters.shardRepairs += 1;
      counters.repairBytes += bytes.byteLength;
      repaired += 1;
      if (target.generation === "joined") joinedPlacements += 1;
    }
    return { planned: planned.length, repaired, blocked: false, joinedPlacements };
  }

  async function repairFile() {
    const existingFilePlacements = segments.flatMap((segment) => segment.segment_shards.flatMap((shard) => {
      const row = activePlacement(shard);
      return row ? [{ ...row, size_bytes: shard.size_bytes }] : [];
    }));
    const fileContext = placement.createFilePlacementContext(existingFilePlacements, {
      expectedPlacements: segments.length * profile.totalShards,
      candidateCount: onlineCandidates().length,
    });
    const results = [];
    for (const segment of segments) results.push(await repairSegment(segment, fileContext));
    return {
      planned: results.reduce((sum, row) => sum + row.planned, 0),
      repaired: results.reduce((sum, row) => sum + row.repaired, 0),
      blocked: results.some((row) => row.blocked),
      joinedPlacements: results.reduce((sum, row) => sum + row.joinedPlacements, 0),
    };
  }

  function reconcileShardCopies() {
    const firstPass = [];
    for (const segment of segments) {
      firstPass.push(...lifecycle.planReplicaReconciliation(segment.segment_shards, {
        now,
        surplusGraceMs: runtime.resilience.surplusGraceMs,
      }));
    }
    for (const action of firstPass) {
      if (action.type === "mark-surplus") {
        action.placement.status = "surplus";
        action.placement.retire_after = new Date(action.retireAt).toISOString();
        counters.surplusMarked += 1;
      } else if (action.type === "promote") {
        action.placement.status = "verified";
      }
    }
    now += runtime.resilience.surplusGraceMs;
    const secondPass = [];
    for (const segment of segments) {
      secondPass.push(...lifecycle.planReplicaReconciliation(segment.segment_shards, {
        now,
        surplusGraceMs: runtime.resilience.surplusGraceMs,
      }));
    }
    for (const action of secondPass) {
      if (action.type !== "retire") continue;
      const node = nodes.get(action.placement.node_id);
      const stored = node?.store.get(action.shardId);
      if (stored) {
        node.store.delete(action.shardId);
        node.used_bytes = Math.max(node.baseline_used_bytes, node.used_bytes - stored.byteLength);
      }
      action.placement.status = "retired";
      action.placement.live = false;
      counters.surplusRetired += 1;
    }
    return {
      marked: firstPass.filter((action) => action.type === "mark-surplus").length,
      retired: secondPass.filter((action) => action.type === "retire").length,
    };
  }

  function chooseOfflineSet(targetCount, required = [], excluded = new Set()) {
    const selected = new Set(required.filter((id) => nodes.get(id)?.online));
    for (const node of shuffled(onlineCandidates(), random)) {
      if (selected.size >= targetCount) break;
      if (excluded.has(node.id) && !selected.has(node.id)) continue;
      selected.add(node.id);
    }
    return selected;
  }

  function shortLabel(label) {
    return label.replace(/^\d+\.\s*/, "").slice(0, 18);
  }

  function capture(label, exactRecovery = "not run", note = "") {
    const status = currentFileResilience();
    const segmentRows = segments.map((segment) => resilience.calculateSegmentResilience(segment));
    const physical = physicalShardCopies();
    const holders = activeFileHolderIds();
    const countryCount = new Set([...holders].map((id) => nodes.get(id)?.country_code).filter(Boolean)).size;
    const onlineAnchorCount = onlineAnchors().length;
    const activeAnchorCopies = [...anchorCopies].filter((id) => nodes.get(id)?.online).length;
    const snapshot = {
      step: snapshots.length + 1,
      label,
      shortLabel: shortLabel(label),
      timestamp: new Date(now).toISOString(),
      totalNodes: nodes.size,
      onlineNodes: onlineCandidates().length,
      offlineNodes: nodes.size - onlineCandidates().length,
      onlineAnchors: onlineAnchorCount,
      anchorCopies: anchorCopies.size,
      activeAnchorCopies,
      fileState: status.state,
      recoverable: status.recoverable,
      repairNeeded: status.repairNeeded,
      weakestHealthyShards: Math.min(...segmentRows.map((row) => row.healthyShards)),
      strongestHealthyShards: Math.max(...segmentRows.map((row) => row.healthyShards)),
      activeShardCopies: reachablePlacementCopies(),
      physicalShardCopies: physical.count,
      physicalShardBytes: physical.bytes,
      independentActiveFileHolders: holders.size,
      placementCountries: countryCount,
      exactRecovery,
      note,
    };
    snapshots.push(snapshot);
    return snapshot;
  }

  function event(type, detail) {
    events.push({ at: new Date(now).toISOString(), type, ...detail });
  }

  reconcileAnchors();
  counters.anchorRepairs = 0;
  const initialRecovery = await recoverFile();
  assert(initialRecovery.verified, "Initial exact recovery failed.");
  capture("1. Upload complete", "verified", "1,000 candidates; 12+4 placements complete.");

  const initialHolderUnion = new Set(originalHolderSets.flatMap((set) => [...set]));
  const initialHolderIntersection = [...originalHolderSets[0]].filter((id) => originalHolderSets.every((set) => set.has(id)));
  for (const set of originalHolderSets) assert.equal(set.size, 16);
  assert.equal(initialHolderUnion.size, segments.length * profile.totalShards, "File-wide placement did not use every available fresh device.");
  assert.equal(initialHolderIntersection.length, 0);

  const firstAnchorCopies = [...anchorCopies];
  const waveOneHolderLosses = activeHoldersPerSegment(3, firstAnchorCopies);
  const protectedHolders = new Set([...initialHolderUnion].filter((id) => !waveOneHolderLosses.includes(id)));
  const waveOneOffline = chooseOfflineSet(200, [...waveOneHolderLosses, ...firstAnchorCopies], protectedHolders);
  now += 60_000;
  setOffline(waveOneOffline);
  reconcileAnchors();
  const graceSnapshot = capture("2. 200 nodes offline", "not run", "Three holders per segment are suspect during repair grace.");
  assert.equal(graceSnapshot.weakestHealthyShards, 13);
  assert(graceSnapshot.recoverable);
  event("node-outage", { count: waveOneOffline.size, holderLosses: waveOneHolderLosses.length, anchorReplicaLosses: firstAnchorCopies.length });

  now += runtime.resilience.repairGraceMs;
  ageOfflinePlacements();
  const waveOneRepair = await repairFile();
  assert.equal(waveOneRepair.repaired, segments.length * 3);
  assert.equal(currentFileResilience().state, "resilient");
  assert((await recoverFile()).verified);
  capture("3. Grace expired; repaired", "verified", `${waveOneRepair.repaired} shard placements recreated.`);
  event("repair", waveOneRepair);

  for (let index = 0; index < JOINING_NODE_COUNT; index += 1) makeNode(index, { prefix: "join", joined: true });
  now += 5 * 60_000;
  reconcileAnchors();
  capture("4. 250 new nodes join", "not run", "New high-capacity countries become eligible.");
  event("node-join", { count: JOINING_NODE_COUNT, anchors: [...nodes.values()].filter((node) => node.generation === "joined" && node.is_anchor).length });

  const fourHolderLosses = activeHoldersPerSegment(4);
  now += runtime.resilience.repairGraceMs;
  setOffline(fourHolderLosses, { immediate: true });
  reconcileAnchors();
  const thresholdRecovery = await recoverFile();
  assert(thresholdRecovery.verified, "12-of-16 threshold recovery failed.");
  const thresholdSnapshot = capture("5. Four holders lost", "verified", "Exactly 12 of 16 shards remain per segment.");
  assert.equal(thresholdSnapshot.weakestHealthyShards, 12);
  assert(thresholdSnapshot.recoverable);
  event("holder-outage", { count: fourHolderLosses.length, remainingPerSegment: thresholdSnapshot.weakestHealthyShards });

  const waveTwoRepair = await repairFile();
  assert.equal(waveTwoRepair.repaired, segments.length * 4);
  assert(waveTwoRepair.joinedPlacements > 0, "Newly joined nodes were not used for rebalancing repairs.");
  assert.equal(currentFileResilience().state, "resilient");
  capture("6. Rebalanced to newcomers", "verified", `${waveTwoRepair.joinedPlacements} repaired placements landed on newly joined nodes.`);
  event("repair-to-new-nodes", waveTwoRepair);

  const anchorLosses = onlineAnchors().slice(0, 30).map((node) => node.id);
  const activeAnchorBeforeChurn = [...anchorCopies].filter((id) => nodes.get(id)?.online);
  for (let index = 0; index < JOINING_ANCHOR_COUNT; index += 1) makeNode(index, { prefix: "anchor-join", joined: true, forceAnchor: true });
  now += 2 * 60_000;
  setOffline(new Set([...anchorLosses, ...activeAnchorBeforeChurn]), { immediate: true });
  const anchorRepairsBefore = counters.anchorRepairs;
  reconcileAnchors();
  const anchorRepairDelta = counters.anchorRepairs - anchorRepairsBefore;
  assert.equal([...anchorCopies].filter((id) => nodes.get(id)?.online).length, runtime.anchor.replicationTarget);
  capture("7. Anchors churn", "not run", `${anchorRepairDelta} live control replicas replaced.`);
  event("anchor-churn", { offline: new Set([...anchorLosses, ...activeAnchorBeforeChurn]).size, joined: JOINING_ANCHOR_COUNT, replacementCopies: anchorRepairDelta });

  const returnable = new Set([...waveOneOffline, ...fourHolderLosses, ...anchorLosses, ...activeAnchorBeforeChurn].filter((id) => !nodes.get(id).online));
  now += 10 * 60_000;
  setOnline(returnable);
  reconcileAnchors({ retireSurplus: true });
  const peakCopies = physicalShardCopies().count;
  assert(peakCopies > segments.length * profile.totalShards, "Returning nodes did not create temporary surplus copies.");
  capture("8. Old holders return", "verified", `${peakCopies} physical copies exist before reconciliation.`);
  event("node-return", { count: returnable.size, peakPhysicalCopies: peakCopies });

  const firstReconciliation = reconcileShardCopies();
  assert(firstReconciliation.marked > 0 && firstReconciliation.retired > 0);
  assert.equal(reachablePlacementCopies(), segments.length * profile.totalShards);
  capture("9. Surplus retired", "verified", `${firstReconciliation.retired} duplicate copies retired after grace.`);
  event("surplus-reconciliation", firstReconciliation);

  const severeLosses = activeHoldersPerSegment(5);
  now += runtime.resilience.repairGraceMs;
  setOffline(severeLosses, { immediate: true });
  reconcileAnchors();
  const blockedRecovery = await recoverFile();
  assert(!blockedRecovery.verified, "Recovery incorrectly succeeded with 11 of 12 required shards.");
  const blockedRepair = await repairFile();
  assert(blockedRepair.blocked && blockedRepair.repaired === 0, "Repair should block below K.");
  const severeSnapshot = capture("10. Five holders lost", "blocked", blockedRecovery.reason);
  assert.equal(severeSnapshot.weakestHealthyShards, 11);
  assert(!severeSnapshot.recoverable);
  event("threshold-breach", { offlineHolders: severeLosses.length, reason: blockedRecovery.reason, plannedRepairs: blockedRepair.planned });

  const firstReturns = segments.map((_, index) => severeLosses[index * 5]);
  now += 4 * 60_000;
  setOnline(firstReturns);
  const marginRecovery = await recoverFile();
  assert(marginRecovery.verified, "Recovery did not resume at exactly K.");
  const marginSnapshot = capture("11. One holder per segment returns", "verified", "12 of 16 shards are reachable again.");
  assert.equal(marginSnapshot.weakestHealthyShards, 12);
  event("minimum-recovery", { returned: firstReturns.length, healthyPerSegment: marginSnapshot.weakestHealthyShards });

  const finalRepair = await repairFile();
  assert.equal(finalRepair.repaired, segments.length * 4);
  assert.equal(currentFileResilience().state, "resilient");
  assert((await recoverFile()).verified);
  capture("12. Final repair", "verified", `${finalRepair.repaired} placements restored the 12+4 target.`);
  event("final-repair", finalRepair);

  const lateReturns = severeLosses.filter((id) => !firstReturns.includes(id));
  now += 12 * 60_000;
  setOnline(lateReturns);
  const finalPeakCopies = physicalShardCopies().count;
  capture("13. Late holders return", "verified", `${finalPeakCopies} copies exist until surplus grace ends.`);
  const finalReconciliation = reconcileShardCopies();
  reconcileAnchors({ retireSurplus: true });
  assert.equal(reachablePlacementCopies(), segments.length * profile.totalShards);
  const finalRecovery = await recoverFile();
  assert(finalRecovery.verified);
  const finalSnapshot = capture("14. Final clean state", "verified", "Logical and reachable physical shard counts match again.");
  assert.equal(finalSnapshot.activeShardCopies, segments.length * profile.totalShards);
  assert.equal(finalSnapshot.physicalShardCopies, segments.length * profile.totalShards);
  event("final-reconciliation", finalReconciliation);

  for (const segment of segments) {
    const activeDomains = new Set();
    for (const shard of segment.segment_shards) {
      const row = activePlacement(shard);
      assert(row, `Missing final placement for ${shard.id}`);
      assert(!activeDomains.has(row.failure_domain_id), `Final group duplicates failure domain ${row.failure_domain_id}`);
      activeDomains.add(row.failure_domain_id);
    }
    assert.equal(activeDomains.size, profile.totalShards);
  }

  const segmentMetrics = segments.map((segment) => ({
    segment: segment.segment_index + 1,
    originalBytes: segment.original_size_bytes,
    storedBytes: segment.stored_size_bytes,
    cipherBytes: segment.cipher_size_bytes,
    compression: segment.compression_method,
    compressionSavingsPercent: Number((segment.compression_savings * 100).toFixed(2)),
    shardBytes: segment.segment_shards[0].size_bytes,
    originalHolderCount: originalHolderSets[segment.segment_index].size,
  }));
  const originalBytes = segmentMetrics.reduce((sum, row) => sum + row.originalBytes, 0);
  const storedBytes = segmentMetrics.reduce((sum, row) => sum + row.storedBytes, 0);
  const initialPhysicalBytes = segmentMetrics.reduce((sum, row) => sum + row.shardBytes * profile.totalShards, 0);
  const holderReliability = [...initialHolderUnion].map((id) => nodes.get(id).reliability_score);
  const allInitialReliability = [...nodes.values()].filter((node) => node.generation === "initial").map((node) => node.reliability_score);
  const findings = [
    {
      severity: "verified",
      title: "File-wide placement spreads segments beyond one device cohort",
      evidence: `${segments.length} segments each used 16 independent devices and their union used ${initialHolderUnion.size} devices from 1,000 eligible nodes.`,
      cause: "A shared file placement context applies a soft per-node cap and a stable segment/shard-specific weighted rendezvous score.",
      recommendation: "Keep this file-wide context in upload, profile-upgrade and repair paths while preserving per-group failure-domain uniqueness.",
    },
    {
      severity: "expected",
      title: "Returning nodes temporarily create extra physical copies",
      evidence: `Physical copies peaked at ${Math.max(peakCopies, finalPeakCopies)} for ${segments.length * profile.totalShards} logical shards.`,
      cause: "Repairs create replacements while an unreachable node may still retain its old encrypted copy.",
      recommendation: "Keep the existing surplus grace and deterministic retirement path; expose physical surplus separately from logical shard count.",
    },
  ];

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const results = {
    schema: "TheMeshVaultScaleChaosV1",
    generatedAt: new Date().toISOString(),
    result: "PASS",
    mode: "1,000 logical mobile nodes using production storage algorithms; Anchor transport modeled",
    runtime: {
      nodeVersion: process.version,
      initialNodes: INITIAL_NODE_COUNT,
      joinedStorageNodes: JOINING_NODE_COUNT,
      joinedAnchors: JOINING_ANCHOR_COUNT,
      segmentTargetBytes: runtime.segments.targetBytes,
      repairGraceMs: runtime.resilience.repairGraceMs,
      surplusGraceMs: runtime.resilience.surplusGraceMs,
      anchorReplicationTarget: runtime.anchor.replicationTarget,
      profile: {
        dataShards: profile.dataShards,
        parityShards: profile.parityShards,
        repairThreshold: profile.repairThreshold,
        totalShards: profile.totalShards,
      },
    },
    file: {
      name: "scale-chaos.bin",
      originalBytes,
      originalHash,
      recoveredBytes: finalRecovery.outputBytes,
      recoveredHash: finalRecovery.outputHash,
      exactByteComparison: finalRecovery.verified,
      segmentCount: segments.length,
      representationBytes: storedBytes,
      compressionSavingsPercent: Number(((1 - storedBytes / originalBytes) * 100).toFixed(2)),
      initialPhysicalShardBytes: initialPhysicalBytes,
      segments: segmentMetrics,
    },
    placement: {
      eligibleInitialNodes: INITIAL_NODE_COUNT,
      originalUniqueFileHolders: initialHolderUnion.size,
      originalHolderIntersectionAcrossSegments: initialHolderIntersection.length,
      originalCountries: new Set([...initialHolderUnion].map((id) => nodes.get(id).country_code)).size,
      averageInitialHolderReliability: Number((holderReliability.reduce((sum, value) => sum + value, 0) / holderReliability.length).toFixed(4)),
      averageInitialNodeReliability: Number((allInitialReliability.reduce((sum, value) => sum + value, 0) / allInitialReliability.length).toFixed(4)),
    },
    counters,
    snapshots,
    events,
    findings,
    assertions: {
      exactInitialRecovery: initialRecovery.verified,
      exactAtMaximumFourShardLoss: thresholdRecovery.verified,
      blockedAtElevenOfTwelve: !blockedRecovery.verified,
      exactAtMinimumTwelveOfSixteen: marginRecovery.verified,
      exactFinalRecovery: finalRecovery.verified,
      fileWideInitialHolderSpread: initialHolderUnion.size === segments.length * profile.totalShards,
      noInitialHolderIntersectionAcrossSegments: initialHolderIntersection.length === 0,
      finalUniqueFailureDomainsPerSegment: profile.totalShards,
      finalActiveShardCopies: finalSnapshot.activeShardCopies,
      anchorTargetRestoredAfterChurn: finalSnapshot.activeAnchorCopies === runtime.anchor.replicationTarget,
    },
    durationMs: Number((performance.now() - startedAt).toFixed(1)),
    limitations: [
      "The 1,000 mobiles are logical nodes in one Node.js process, not 1,000 browser or phone processes.",
      "Shard bytes, compression, AES-GCM, SHA-256 and Reed-Solomon are real; WebRTC packet delivery, NAT traversal, radio use, battery and mobile background suspension are not exercised here.",
      "Anchor membership, outages and the configured two-copy target are modeled; 1,000 live Anchor peer connections are not opened.",
      "Supabase throughput, Realtime fan-out, RLS contention and anonymous-auth rate limits are not load-tested.",
      "The harness retains validation fixtures centrally so it cannot be used as evidence that production never stores file bytes centrally; the separate Golden Recovery Test covers that boundary.",
    ],
  };

  function networkChurnSvg() {
    const width = 1280;
    const height = 560;
    const left = 76;
    const right = 38;
    const top = 72;
    const nodesBottom = 295;
    const anchorTop = 345;
    const anchorBottom = 430;
    const maxNodes = Math.max(...snapshots.map((row) => row.totalNodes));
    const maxAnchors = Math.max(...snapshots.map((row) => row.onlineAnchors));
    const x = (index) => left + index * ((width - left - right) / Math.max(1, snapshots.length - 1));
    const yNodes = (value) => nodesBottom - value / maxNodes * (nodesBottom - top);
    const yAnchors = (value) => anchorBottom - value / maxAnchors * (anchorBottom - anchorTop);
    const nodePath = snapshots.map((row, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${yNodes(row.onlineNodes).toFixed(1)}`).join(" ");
    const anchorPath = snapshots.map((row, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${yAnchors(row.onlineAnchors).toFixed(1)}`).join(" ");
    const labels = snapshots.map((row, index) => `<text x="${x(index)}" y="468" text-anchor="end" transform="rotate(-38 ${x(index)} 468)">${xml(row.shortLabel)}</text>`).join("");
    const nodePoints = snapshots.map((row, index) => `<circle cx="${x(index)}" cy="${yNodes(row.onlineNodes)}" r="5"/><text x="${x(index)}" y="${yNodes(row.onlineNodes) - 10}" text-anchor="middle">${row.onlineNodes}</text>`).join("");
    const anchorPoints = snapshots.map((row, index) => `<circle cx="${x(index)}" cy="${yAnchors(row.onlineAnchors)}" r="4"/><text x="${x(index)}" y="${yAnchors(row.onlineAnchors) - 8}" text-anchor="middle">${row.onlineAnchors}</text>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
      <title id="title">Node and Anchor churn during the 1,000-node test</title><desc id="desc">Online nodes and online Anchors across fourteen chaos-test stages.</desc>
      <style>text{font-family:Arial,sans-serif;fill:#38525d;font-size:11px}.title{font-size:22px;font-weight:700;fill:#071726}.label{font-size:12px;font-weight:700}.nodes{fill:none;stroke:#0aaab7;stroke-width:4}.anchors{fill:none;stroke:#8173e6;stroke-width:3}.node-points circle{fill:#0aaab7}.anchor-points circle{fill:#8173e6}.grid{stroke:#d8e5e8;stroke-width:1}.legend{font-size:12px}</style>
      <rect width="100%" height="100%" fill="#f5fafb"/><text class="title" x="${left}" y="35">Network churn: 1,000 initial logical mobiles</text>
      <line class="grid" x1="${left}" y1="${nodesBottom}" x2="${width - right}" y2="${nodesBottom}"/><line class="grid" x1="${left}" y1="${top}" x2="${left}" y2="${nodesBottom}"/>
      <text class="label" x="18" y="${top + 4}">Online</text><text class="label" x="18" y="${top + 20}">nodes</text><path class="nodes" d="${nodePath}"/><g class="node-points">${nodePoints}</g>
      <line class="grid" x1="${left}" y1="${anchorBottom}" x2="${width - right}" y2="${anchorBottom}"/><line class="grid" x1="${left}" y1="${anchorTop}" x2="${left}" y2="${anchorBottom}"/>
      <text class="label" x="18" y="${anchorTop + 4}">Online</text><text class="label" x="18" y="${anchorTop + 20}">Anchors</text><path class="anchors" d="${anchorPath}"/><g class="anchor-points">${anchorPoints}</g>${labels}
      <circle cx="${width - 245}" cy="32" r="5" fill="#0aaab7"/><text class="legend" x="${width - 232}" y="36">Online nodes</text><circle cx="${width - 130}" cy="32" r="5" fill="#8173e6"/><text class="legend" x="${width - 117}" y="36">Anchors</text>
    </svg>`;
  }

  function shardHealthSvg() {
    const width = 1280;
    const height = 560;
    const left = 72;
    const right = 32;
    const top = 60;
    const bottom = 365;
    const plotHeight = bottom - top;
    const cell = (width - left - right) / snapshots.length;
    const y = (value) => bottom - value / profile.totalShards * plotHeight;
    const bars = snapshots.map((row, index) => {
      const color = row.weakestHealthyShards >= profile.repairThreshold ? "#2bc8ad" : row.weakestHealthyShards >= profile.requiredShards ? "#e6ad23" : "#df5a62";
      const barWidth = Math.max(18, cell * .58);
      const x = left + index * cell + (cell - barWidth) / 2;
      return `<rect x="${x}" y="${y(row.weakestHealthyShards)}" width="${barWidth}" height="${bottom - y(row.weakestHealthyShards)}" rx="5" fill="${color}"/><text x="${x + barWidth / 2}" y="${y(row.weakestHealthyShards) - 9}" text-anchor="middle">${row.weakestHealthyShards}</text><text x="${x + barWidth / 2}" y="405" text-anchor="end" transform="rotate(-38 ${x + barWidth / 2} 405)">${xml(row.shortLabel)}</text>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
      <title id="title">Weakest segment shard health</title><desc id="desc">Healthy shards in the weakest segment, with required and repair threshold lines.</desc>
      <style>text{font-family:Arial,sans-serif;fill:#38525d;font-size:11px}.title{font-size:22px;font-weight:700;fill:#071726}.axis{stroke:#cbdde1}.required{stroke:#df5a62;stroke-width:2;stroke-dasharray:7 5}.repair{stroke:#e6ad23;stroke-width:2;stroke-dasharray:7 5}.legend{font-size:12px;font-weight:700}</style>
      <rect width="100%" height="100%" fill="#f5fafb"/><text class="title" x="${left}" y="34">File health through loss, repair and return</text>
      <line class="axis" x1="${left}" y1="${bottom}" x2="${width - right}" y2="${bottom}"/><line class="axis" x1="${left}" y1="${top}" x2="${left}" y2="${bottom}"/>
      <line class="repair" x1="${left}" y1="${y(profile.repairThreshold)}" x2="${width - right}" y2="${y(profile.repairThreshold)}"/>
      <line class="required" x1="${left}" y1="${y(profile.requiredShards)}" x2="${width - right}" y2="${y(profile.requiredShards)}"/>
      ${bars}<text x="18" y="${top + 10}">16</text><text x="23" y="${bottom + 4}">0</text>
      <rect x="${width - right - 184}" y="${y(profile.repairThreshold) - 24}" width="180" height="20" rx="4" fill="#f5fafb" opacity=".94"/><text class="legend" x="${width - right - 10}" y="${y(profile.repairThreshold) - 10}" text-anchor="end">Repair threshold ${profile.repairThreshold}</text>
      <rect x="${width - right - 184}" y="${y(profile.requiredShards) + 4}" width="180" height="20" rx="4" fill="#f5fafb" opacity=".94"/><text class="legend" x="${width - right - 10}" y="${y(profile.requiredShards) + 18}" text-anchor="end">Recovery requires ${profile.requiredShards}</text>
      <rect x="${left}" y="520" width="12" height="12" rx="3" fill="#2bc8ad"/><text x="${left + 18}" y="530">Resilient</text><rect x="${left + 100}" y="520" width="12" height="12" rx="3" fill="#e6ad23"/><text x="${left + 118}" y="530">Recoverable / repair needed</text><rect x="${left + 310}" y="520" width="12" height="12" rx="3" fill="#df5a62"/><text x="${left + 328}" y="530">Below recovery threshold</text>
    </svg>`;
  }

  function cohortSvg() {
    const finalHolders = activeFileHolderIds();
    const allNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
    const columns = 50;
    const gap = 14;
    const left = 42;
    const top = 100;
    const rows = Math.ceil(allNodes.length / columns);
    const width = left * 2 + (columns - 1) * gap;
    const height = top + rows * gap + 80;
    const circles = allNodes.map((node, index) => {
      const x = left + (index % columns) * gap;
      const y = top + Math.floor(index / columns) * gap;
      const kind = !node.online ? "offline" : finalHolders.has(node.id) ? "holder" : node.is_anchor ? "anchor" : "online";
      return `<circle class="${kind}" cx="${x}" cy="${y}" r="${kind === "holder" ? 4.2 : 3.3}"><title>${xml(node.id)} · ${kind}</title></circle>`;
    }).join("");
    const counts = {
      online: allNodes.filter((node) => node.online).length,
      offline: allNodes.filter((node) => !node.online).length,
      anchors: allNodes.filter((node) => node.online && node.is_anchor).length,
      holders: finalHolders.size,
    };
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
      <title id="title">Final 1,270-node cohort</title><desc id="desc">One dot per logical mobile, highlighting online nodes, offline nodes, Anchors and current file holders.</desc>
      <style>text{font-family:Arial,sans-serif;fill:#38525d;font-size:11px}.title{font-size:22px;font-weight:700;fill:#071726}.online{fill:#b7e8e6}.offline{fill:#8c9ca3}.anchor{fill:#8173e6}.holder{fill:#f0b323;stroke:#735300;stroke-width:1}.legend{font-size:12px}</style>
      <rect width="100%" height="100%" fill="#f5fafb"/><text class="title" x="${left}" y="36">Final cohort: one dot per logical mobile</text><text x="${left}" y="60">${allNodes.length} total · ${counts.online} online · ${counts.offline} offline · ${counts.anchors} online Anchors · ${counts.holders} active file holders</text>
      ${circles}
      <circle class="online" cx="${left}" cy="${height - 28}" r="5"/><text class="legend" x="${left + 12}" y="${height - 24}">Online</text><circle class="anchor" cx="${left + 90}" cy="${height - 28}" r="5"/><text class="legend" x="${left + 102}" y="${height - 24}">Anchor</text><circle class="holder" cx="${left + 180}" cy="${height - 28}" r="5"/><text class="legend" x="${left + 192}" y="${height - 24}">Stores this file</text><circle class="offline" cx="${left + 320}" cy="${height - 28}" r="5"/><text class="legend" x="${left + 332}" y="${height - 24}">Offline</text>
    </svg>`;
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(OUTPUT_DIR, "network-churn.svg"), networkChurnSvg());
  fs.writeFileSync(path.join(OUTPUT_DIR, "shard-health.svg"), shardHealthSvg());
  fs.writeFileSync(path.join(OUTPUT_DIR, "final-node-cohort.svg"), cohortSvg());

  const reportRows = snapshots.map((row) => [
    row.step,
    row.label.replace(/^\d+\.\s*/, ""),
    `${row.onlineNodes}/${row.totalNodes}`,
    row.onlineAnchors,
    `${row.activeAnchorCopies}/${runtime.anchor.replicationTarget}`,
    `${row.weakestHealthyShards}/${profile.totalShards}`,
    row.fileState,
    row.exactRecovery,
    row.physicalShardCopies,
  ]);
  const report = `# TheMeshVault 1,000-node chaos and scale test

Date: ${results.generatedAt.slice(0, 10)}  
Result: **PASS**  
Machine-readable evidence: [results.json](test-artifacts/scale-chaos/results.json)

## Executive result

The test started with **1,000 logical mobile nodes**, uploaded and cryptographically processed a real ${formatBytes(originalBytes)} file, removed nodes in several waves, introduced ${JOINING_NODE_COUNT} new storage nodes and ${JOINING_ANCHOR_COUNT} additional Anchors, repaired lost shard placements, reconciled copies when old nodes returned, deliberately crossed the recovery threshold, and finally returned to a clean 12+4 state.

- Original SHA-256: \`${originalHash}\`
- Final recovered SHA-256: \`${finalRecovery.outputHash}\`
- Exact byte comparison: **${finalRecovery.verified ? "PASS" : "FAIL"}**
- Recovery with four missing shards per segment: **PASS**
- Recovery with five missing shards per segment: **correctly blocked at 11/12**
- Recovery after one holder per segment returned: **PASS at exactly 12/16**
- Final active shard copies: **${finalSnapshot.activeShardCopies} for ${segments.length * profile.totalShards} logical shards**
- Final live Anchor replicas: **${finalSnapshot.activeAnchorCopies}/${runtime.anchor.replicationTarget}**
- Test runtime: **${results.durationMs} ms**

![Node and Anchor churn](test-artifacts/scale-chaos/network-churn.svg)

![Shard health through the scenario](test-artifacts/scale-chaos/shard-health.svg)

![Final logical mobile cohort](test-artifacts/scale-chaos/final-node-cohort.svg)

## What was exercised with real production code

- Adaptive gzip with the current 5% threshold.
- AES-GCM encryption and decryption.
- SHA-256 for original, segment, ciphertext and shard verification.
- Production Reed–Solomon 12+4 encoding and reconstruction.
- Production erasure-profile selection.
- Production placement ranking using failure domain, geography, capacity, reliability, observed quality, throughput and RTT.
- Production resilience calculation.
- Production offline grace, repair planning and replica reconciliation.

The Anchor portion used the production two-copy target and real churn data, but modeled control-record replication in the harness. It did not open 1,000 browser tabs or WebRTC connections.

## Scenario log

${markdownTable(
    ["#", "Event", "Nodes online", "Anchors", "Anchor copies", "Weakest segment", "File state", "Exact recovery", "Physical copies"],
    reportRows,
  )}

## File and storage data

${markdownTable(
    ["Segment", "Original", "Stored before encryption", "Compression", "Saving", "Shard size", "Original holders"],
    segmentMetrics.map((row) => [
      row.segment,
      formatBytes(row.originalBytes),
      formatBytes(row.storedBytes),
      row.compression,
      `${row.compressionSavingsPercent}%`,
      formatBytes(row.shardBytes),
      row.originalHolderCount,
    ]),
  )}

- Original file: **${formatBytes(originalBytes)}**
- Compressed representation: **${formatBytes(storedBytes)}**
- Overall compression saving: **${results.file.compressionSavingsPercent}%**
- Initial 12+4 physical shard storage: **${formatBytes(initialPhysicalBytes)}**
- Repair placements created: **${counters.shardRepairs}**
- Repair traffic represented by rebuilt shards: **${formatBytes(counters.repairBytes)}**
- Repairs correctly blocked below K: **${counters.blockedRepairs} planned shard copies**
- Surplus copies marked/retired: **${counters.surplusMarked}/${counters.surplusRetired}**
- Anchor replicas recreated/retired: **${counters.anchorRepairs}/${counters.anchorRetirements}**

## File-wide placement result

All three segment groups used 16 different failure domains and the complete file used **${initialHolderUnion.size} distinct devices** from the 1,000 eligible nodes. No device appeared in all three initial segment groups.

The production placement path now carries a shared file-level context across segments. It prefers devices that do not yet store part of the file, applies a soft per-node cap derived from file size and eligible-node count, and uses a stable file/segment/shard-specific weighted rendezvous score. Small meshes may reuse devices, but the load is kept balanced while every individual coding group remains on distinct failure domains.

## Returning nodes and temporary extra copies

Repairs created replacement copies while offline nodes still physically retained unreadable old shards. When those nodes returned, the test observed up to **${Math.max(peakCopies, finalPeakCopies)} physical copies for ${segments.length * profile.totalShards} logical shards**. Production reconciliation marked the duplicates as surplus, waited the configured five-minute grace period, and retired them deterministically. The final state returned to ${segments.length * profile.totalShards} active and physical copies.

This confirms the UI should distinguish:

- logical profile size;
- currently active/reachable copies;
- temporary or offline physical surplus.

## Placement observations

- Eligible initial nodes: **${INITIAL_NODE_COUNT}**
- Original unique file holders: **${initialHolderUnion.size}**
- Countries represented by original holders: **${results.placement.originalCountries}**
- Average reliability, selected holders: **${results.placement.averageInitialHolderReliability}**
- Average reliability, all initial nodes: **${results.placement.averageInitialNodeReliability}**
- Newly joined nodes used by the second repair wave: **${waveTwoRepair.joinedPlacements} placements**
- Final independent failure domains per segment: **${profile.totalShards}**

## What this test does not prove

${results.limitations.map((item) => `- ${item}`).join("\n")}

Running 1,000 real mobile browsers on one workstation would mostly test that workstation's RAM, process, WebRTC socket and operating-system limits. The useful next physical tier is approximately 20–50 real phones across several networks, with long-running background/screen-off tests, while this 1,000-node logical test remains the fast reproducible chaos gate.
`;
  fs.writeFileSync(path.join(ROOT, "SCALE_CHAOS_TEST_REPORT.md"), report);

  console.log(`PASS: ${INITIAL_NODE_COUNT} initial logical mobiles, ${nodes.size} final logical nodes`);
  console.log(`PASS: exact SHA-256 ${originalHash}`);
  console.log(`PASS: 12+4 recovery at four losses; blocked at five; recovered again at K`);
  console.log(`PASS: ${counters.shardRepairs} shard repairs and ${counters.surplusRetired} surplus retirements`);
  console.log(`PASS: Anchor target ${runtime.anchor.replicationTarget} restored through churn`);
  console.log(`PASS: ${segments.length} segment groups spread across ${initialHolderUnion.size} initial devices`);
  console.log(`REPORT: ${path.join(ROOT, "SCALE_CHAOS_TEST_REPORT.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
