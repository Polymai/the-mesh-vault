const EXP = new Uint8Array(512); const LOG = new Uint8Array(256);
let x = 1;
for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (!a || !b ? 0 : EXP[LOG[a] + LOG[b]]);
const inv = (a) => { if (!a) throw new Error("Singular shard matrix"); return EXP[255 - LOG[a]]; };
const pow = (a, n) => n === 0 ? 1 : EXP[(LOG[a] * n) % 255];
function rowFor(index, dataShards) {
  if (index < dataShards) return Array.from({ length: dataShards }, (_, i) => i === index ? 1 : 0);
  const base = index - dataShards + 1; return Array.from({ length: dataShards }, (_, col) => pow(base, col));
}
function invert(matrix) {
  const n = matrix.length; const aug = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let col = 0; col < n; col++) {
    let pivot = col; while (pivot < n && aug[pivot][col] === 0) pivot++; if (pivot === n) throw new Error("Not enough independent shards");
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]]; const scale = inv(aug[col][col]);
    for (let j = 0; j < 2 * n; j++) aug[col][j] = mul(aug[col][j], scale);
    for (let row = 0; row < n; row++) if (row !== col && aug[row][col]) { const factor = aug[row][col]; for (let j = 0; j < 2 * n; j++) aug[row][j] ^= mul(factor, aug[col][j]); }
  }
  return aug.map((row) => row.slice(n));
}
function combine(matrixRow, shards, size) {
  const out = new Uint8Array(size);
  for (let col = 0; col < shards.length; col++) { const coefficient = matrixRow[col]; if (!coefficient) continue; const shard = shards[col]; for (let i = 0; i < size; i++) out[i] ^= mul(coefficient, shard[i]); }
  return out;
}
export function encode(bytes, dataShards = 4, parityShards = 2) {
  const input = new Uint8Array(bytes); const shardSize = Math.ceil(input.length / dataShards); const shards = Array.from({ length: dataShards }, (_, i) => { const out = new Uint8Array(shardSize); out.set(input.slice(i * shardSize, (i + 1) * shardSize)); return out; });
  for (let row = dataShards; row < dataShards + parityShards; row++) shards.push(combine(rowFor(row, dataShards), shards.slice(0, dataShards), shardSize));
  return { shards, originalLength: input.length, dataShards, parityShards };
}
export function reconstruct(available, originalLength, dataShards = 4) {
  const picked = available.filter((entry) => entry?.bytes).slice(0, dataShards); if (picked.length < dataShards) throw new Error(`Need ${dataShards} healthy fragments to recover this file.`);
  const size = picked[0].bytes.byteLength; const inverse = invert(picked.map((entry) => rowFor(entry.index, dataShards))); const selected = picked.map((entry) => new Uint8Array(entry.bytes));
  const output = new Uint8Array(size * dataShards); inverse.forEach((row, index) => output.set(combine(row, selected, size), index * size)); return output.slice(0, originalLength);
}
