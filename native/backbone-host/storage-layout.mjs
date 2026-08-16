import { existsSync, mkdirSync, realpathSync, statfsSync } from "node:fs";
import { resolve, parse } from "node:path";
import { execFileSync } from "node:child_process";

function windowsPhysicalDevice(path) {
  if (process.platform !== "win32") return null;
  const drive = parse(resolve(path)).root.slice(0, 2);
  if (!/^[A-Za-z]:$/.test(drive)) return null;
  try {
    const script = `$p=Get-Partition -DriveLetter '${drive[0]}' -ErrorAction Stop; [Console]::Out.Write($p.DiskNumber)`;
    const number = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5000 }).trim();
    return /^\d+$/.test(number) ? `windows-disk:${number}` : null;
  } catch { return null; }
}

export function inspectStoragePath(inputPath) {
  const absolutePath = resolve(inputPath);
  if (!existsSync(absolutePath)) mkdirSync(absolutePath, { recursive: true });
  const canonicalPath = realpathSync.native(absolutePath);
  const stats = statfsSync(canonicalPath, { bigint: true });
  const freeBytes = Number(stats.bavail * stats.bsize);
  const totalBytes = Number(stats.blocks * stats.bsize);
  const volumeId = process.platform === "win32" ? parse(canonicalPath).root.toUpperCase() : String(stats.type);
  return {
    path: canonicalPath, freeBytes, totalBytes, volumeId,
    physicalDeviceId: windowsPhysicalDevice(canonicalPath) || `volume:${volumeId}`,
  };
}

export function validateStorageLayout(config) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{5,127}$/.test(String(config.physicalHostId || ""))) {
    throw new Error("A stable physicalHostId is required so logical instances cannot masquerade as independent devices.");
  }
  const pools = new Map();
  for (const raw of config.storagePools || []) {
    if (!raw?.id || !raw?.path || pools.has(raw.id)) throw new Error("Every storage pool needs a unique id and path.");
    const detected = inspectStoragePath(raw.path);
    pools.set(raw.id, { ...raw, ...detected, physicalDeviceId: raw.physicalDeviceId && raw.physicalDeviceId !== "auto" ? raw.physicalDeviceId : detected.physicalDeviceId });
  }
  if (!pools.size) throw new Error("At least one storage pool is required.");
  const instances = [];
  const allocated = new Map();
  for (const raw of config.instances || []) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(raw?.id || "")) throw new Error("Every Backbone instance needs a stable UUID node id.");
    if (instances.some((entry) => entry.id === raw.id)) throw new Error(`Duplicate Backbone instance: ${raw.id}`);
    const pool = pools.get(raw.poolId);
    if (!pool) throw new Error(`Unknown storage pool: ${raw.poolId}`);
    const quotaBytes = Math.max(0, Math.trunc(Number(raw.quotaBytes) || 0));
    if (!quotaBytes) throw new Error(`Backbone instance ${raw.id} needs a positive quota.`);
    allocated.set(pool.id, (allocated.get(pool.id) || 0) + quotaBytes);
    instances.push({ ...raw, quotaBytes, pool, failureDomainId: `physical-host:${config.physicalHostId}`, storageDeviceId: pool.physicalDeviceId });
  }
  if (!instances.length) throw new Error("At least one Backbone instance is required.");
  const reserve = Math.max(268435456, Number(config.reserveBytesPerPool) || 1073741824);
  for (const pool of pools.values()) {
    if ((allocated.get(pool.id) || 0) > Math.max(0, pool.freeBytes - reserve)) {
      throw new Error(`Configured quotas exceed safe free space on ${pool.path}.`);
    }
  }
  const physical = new Map();
  for (const pool of pools.values()) {
    const current = physical.get(pool.physicalDeviceId) || { allocated: 0, freeBytes: 0, paths: [] };
    current.allocated += allocated.get(pool.id) || 0;
    // Two paths/partitions on the same physical disk are not two independent
    // supplies of free space. Use the largest observed free figure once.
    current.freeBytes = Math.max(current.freeBytes, pool.freeBytes);
    current.paths.push(pool.path);
    physical.set(pool.physicalDeviceId, current);
  }
  for (const [deviceId, value] of physical) {
    if (value.allocated > Math.max(0, value.freeBytes - reserve)) {
      throw new Error(`Configured quotas overcommit physical device ${deviceId} (${value.paths.join(", ")}).`);
    }
  }
  return { physicalHostId: config.physicalHostId, pools: [...pools.values()], instances };
}
