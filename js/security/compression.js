const ALREADY_COMPRESSED = /\.(?:jpe?g|webp|avif|heic|heif|png|gif|mp4|m4v|mov|webm|mp3|m4a|aac|ogg|opus|flac|zip|gz|gzip|7z|rar|bz2|xz|pdf|docx|xlsx|pptx)$/i;
const COMPRESSED_MIME = /^(?:image\/(?:jpeg|webp|avif|heic|heif|png|gif)|video\/|audio\/|application\/(?:zip|gzip|x-7z-compressed|x-rar-compressed|pdf))/i;

async function collect(stream) {
  const reader = stream.getReader(); const chunks = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; const bytes = new Uint8Array(value); chunks.push(bytes); size += bytes.length; }
  const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}
export function compressionLikelyUseful(name = "", mime = "") { return !ALREADY_COMPRESSED.test(name) && !COMPRESSED_MIME.test(mime); }
export async function compressAdaptive(bytes, { name = "", mime = "", minimumSavings = .05 } = {}) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!input.length || !compressionLikelyUseful(name, mime) || typeof CompressionStream === "undefined") return { bytes: input, method: "none", savings: 0 };
  const compressed = await collect(new Blob([input]).stream().pipeThrough(new CompressionStream("gzip")));
  const savings = 1 - compressed.length / input.length;
  return savings >= minimumSavings ? { bytes: compressed, method: "gzip", savings } : { bytes: input, method: "none", savings: 0 };
}
export async function decompressSegment(bytes, method) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!method || method === "none") return input;
  if (method !== "gzip" || typeof DecompressionStream === "undefined") throw new Error(`Compression method ${method} is not available in this browser.`);
  return collect(new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip")));
}
