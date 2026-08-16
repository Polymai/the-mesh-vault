import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const sortDeep = (value) => Array.isArray(value) ? value.map(sortDeep) : value && typeof value === "object" ? Object.keys(value).sort().reduce((out, key) => { out[key] = sortDeep(value[key]); return out; }, {}) : value;
export const canonicalBytes = (value) => Buffer.from(JSON.stringify(sortDeep(value)));

export function loadOrCreateIdentity(path) {
  let jwk;
  if (existsSync(path)) jwk = JSON.parse(readFileSync(path, "utf8"));
  else {
    const pair = generateKeyPairSync("ed25519");
    jwk = pair.privateKey.export({ format: "jwk" });
    writeFileSync(path, `${JSON.stringify(jwk, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
  return {
    publicKey: publicJwk.x,
    signObject(value) { return sign(null, canonicalBytes(value), privateKey).toString("base64url"); },
  };
}

export function verifyClientObject(value, publicKey) {
  try {
    const { signature, ...core } = value;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(null, canonicalBytes(core), key, Buffer.from(signature, "base64url"));
  } catch { return false; }
}
