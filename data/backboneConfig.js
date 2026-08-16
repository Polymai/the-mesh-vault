(function () {
  // Public WSS endpoints only. Credentials and private keys never belong here.
  window.__POLYMAI_BACKBONE_CONFIG__ = Object.freeze({
    seeds: Object.freeze([
      // Object.freeze({ url: "wss://seed.example.net/mesh", publicKey: "base64url-ed25519-public-key" })
    ])
  });
})();
