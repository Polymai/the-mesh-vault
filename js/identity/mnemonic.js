import { BIP39_ENGLISH_WORDS } from "./bip39-english.js";

const WORD_COUNT = 24;
const ENTROPY_BYTES = 32;
const CHECKSUM_BITS = 8;
const WORD_BITS = 11;
const indexByWord = new Map(BIP39_ENGLISH_WORDS.map((word, index) => [word, index]));

function byteBits(bytes) {
  return Array.from(bytes, (value) => value.toString(2).padStart(8, "0")).join("");
}

function bitsToBytes(bits) {
  const out = new Uint8Array(bits.length / 8);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  return out;
}

async function checksumByte(entropy) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", entropy))[0];
}

function stripPrefix(value) {
  return value.replace(/^themeshvault:mesh-key:v3:/i, "");
}

export function canonicalMnemonicText(value) {
  return stripPrefix(String(value || "").normalize("NFKD").trim())
    .toLowerCase()
    .replace(/[,_;]+/g, " ")
    .replace(/[\u2010-\u2015-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function entropyToMnemonic(entropyInput) {
  const entropy = new Uint8Array(entropyInput);
  if (entropy.byteLength !== ENTROPY_BYTES) throw new Error("A Mesh Key must contain exactly 256 bits of entropy.");
  const bits = byteBits(entropy) + (await checksumByte(entropy)).toString(2).padStart(8, "0").slice(0, CHECKSUM_BITS);
  const words = [];
  for (let offset = 0; offset < bits.length; offset += WORD_BITS) words.push(BIP39_ENGLISH_WORDS[Number.parseInt(bits.slice(offset, offset + WORD_BITS), 2)]);
  return words.join(" ");
}

export async function mnemonicToEntropy(value) {
  const phrase = canonicalMnemonicText(value);
  const words = phrase ? phrase.split(" ") : [];
  if (words.length !== WORD_COUNT) throw new Error("A Mesh Key must contain exactly 24 words.");
  const indexes = words.map((word) => {
    const index = indexByWord.get(word);
    if (index === undefined) throw new Error(`"${word}" is not a valid Mesh Key word.`);
    return index;
  });
  const bits = indexes.map((index) => index.toString(2).padStart(WORD_BITS, "0")).join("");
  const entropy = bitsToBytes(bits.slice(0, ENTROPY_BYTES * 8));
  const suppliedChecksum = Number.parseInt(bits.slice(ENTROPY_BYTES * 8), 2);
  const expectedChecksum = await checksumByte(entropy);
  if (suppliedChecksum !== expectedChecksum) {
    entropy.fill(0);
    throw new Error("The Mesh Key checksum is not valid. Check the words and their order.");
  }
  return entropy;
}

export async function normalizeMnemonic(value) {
  const entropy = await mnemonicToEntropy(value);
  try { return await entropyToMnemonic(entropy); }
  finally { entropy.fill(0); }
}

export function generateEntropy() {
  return crypto.getRandomValues(new Uint8Array(ENTROPY_BYTES));
}

export const MESH_KEY_WORD_COUNT = WORD_COUNT;
export const MESH_KEY_ENTROPY_BITS = ENTROPY_BYTES * 8;
