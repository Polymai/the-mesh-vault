const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
self.onmessage = async ({ data }) => {
  const { id, operation, payload = {} } = data;
  try {
    let result;
    if (operation === "derive") {
      const base = await crypto.subtle.importKey("raw", enc.encode(payload.password), "PBKDF2", false, ["deriveBits"]);
      const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new Uint8Array(payload.salt), iterations: 310000, hash: "SHA-256" }, base, 256);
      result = new Uint8Array(bits);
    } else if (operation === "encrypt") {
      const key = await crypto.subtle.importKey("raw", new Uint8Array(payload.key), "AES-GCM", false, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload.bytes);
      result = { iv, cipher: new Uint8Array(cipher) };
    } else if (operation === "decrypt") {
      const key = await crypto.subtle.importKey("raw", new Uint8Array(payload.key), "AES-GCM", false, ["decrypt"]);
      result = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(payload.iv) }, key, payload.bytes));
    } else if (operation === "sha256") {
      result = b64(await crypto.subtle.digest("SHA-256", payload.bytes));
    } else throw new Error("Unknown crypto operation");
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error.message || "Crypto operation failed" }); }
};
