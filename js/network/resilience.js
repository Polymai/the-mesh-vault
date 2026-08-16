import { ACTIVE_PLACEMENT_STATUSES } from "./shard-lifecycle.js";

export function calculateFileHealth(fileMetadata = {}, availableShardIndexes = []) {
  const erasure = fileMetadata.erasureCoding || {};
  const required = Number(erasure.requiredShards ?? fileMetadata.requiredShards ?? fileMetadata.required_shards ?? erasure.dataShards ?? fileMetadata.dataShards ?? fileMetadata.data_shards ?? 4);
  const total = Number(erasure.totalShards ?? fileMetadata.totalShards ?? fileMetadata.total_shards ?? ((erasure.parityShards ?? fileMetadata.parityShards ?? fileMetadata.parity_shards) != null ? required + Number(erasure.parityShards ?? fileMetadata.parityShards ?? fileMetadata.parity_shards) : 6));
  const available = new Set(
    Array.from(availableShardIndexes || [])
      .map(Number)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < total),
  ).size;
  const status = available < required
    ? "unavailable"
    : available < required + 1
      ? "critical"
      : available < Math.max(required + 1, total - 1)
        ? "degraded"
        : "healthy";
  return {
    status,
    availableShards: available,
    requiredShards: required,
    totalShards: total,
    missingShards: Math.max(0, total - available),
    recoverable: available >= required,
    repairNeeded: available < total - 1,
  };
}

export function calculateSegmentResilience(segment){
  const domains=new Set();let healthyShards=0;
  for(const shard of segment.segment_shards||[]){const placement=(shard.shard_placements||[]).find((item)=>item.role==="durable"&&ACTIVE_PLACEMENT_STATUSES.includes(item.status)&&!domains.has(item.failure_domain_id));if(placement){domains.add(placement.failure_domain_id);healthyShards++;}}
  const required=Number(segment.required_shards||0),total=Number(segment.total_shards||0),repairThreshold=Number(segment.repair_threshold||Math.min(total,required+Math.ceil((total-required)/2)));const repairNeeded=healthyShards<repairThreshold;const health=calculateFileHealth(segment,Array.from({length:healthyShards},(_item,index)=>index));return{healthyShards,independentDevices:domains.size,recoverable:healthyShards>=required,repairThreshold,repairNeeded,healthStatus:health.status,missingPlacements:Math.max(0,total-healthyShards),repairDemand:repairNeeded?Math.max(0,total-healthyShards):0,state:healthyShards>=total?"resilient":healthyShards>=required?"recoverable":healthyShards?"degraded":"local_pending"};
}
export function calculateFileResilience(segments=[]){const results=segments.map((item)=>calculateSegmentResilience(item.content_segments||item));return{resilient:!!results.length&&results.every((row)=>row.state==="resilient"),recoverable:!!results.length&&results.every((row)=>row.recoverable),repairNeeded:results.some((row)=>row.repairNeeded),repairDemand:results.reduce((sum,row)=>sum+row.repairDemand,0),missingPlacements:results.reduce((sum,row)=>sum+row.missingPlacements,0),state:!results.length?"local_pending":results.every((row)=>row.state==="resilient")?"resilient":results.every((row)=>row.recoverable)?"recoverable":"degraded"};}
export function calculateNetworkResilience(files=[]){return{resilient:files.filter((file)=>file.version?.recovery_status==="resilient").length,atRisk:files.filter((file)=>!["resilient","recoverable"].includes(file.version?.recovery_status)).length,recoverable:files.filter((file)=>["resilient","recoverable"].includes(file.version?.recovery_status)).length};}
