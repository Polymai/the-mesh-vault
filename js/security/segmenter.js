export async function* streamFileSegments(file, targetBytes = 8 * 1024 * 1024, onRead = null) {
  if (!file?.stream) throw new Error("This browser cannot stream files safely.");
  const size = Math.max(1024 * 1024, Number(targetBytes) || 8 * 1024 * 1024);
  const reader = file.stream().getReader(); let buffer = new Uint8Array(size); let used = 0; let index = 0; let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value); let cursor = 0;
      while (cursor < chunk.length) {
        const take = Math.min(size - used, chunk.length - cursor); buffer.set(chunk.subarray(cursor, cursor + take), used); used += take; cursor += take;
        onRead?.({ segmentIndex: index, segmentBytes: used, totalBytes: offset + used });
        if (used === size) { yield { index, offset, bytes: buffer }; index++; offset += used; buffer = new Uint8Array(size); used = 0; }
      }
    }
    if (used || !index) yield { index, offset, bytes: buffer.slice(0, used) };
  } finally { reader.releaseLock(); }
}
