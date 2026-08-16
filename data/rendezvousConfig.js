(function () {
  // Public trust anchors and public relay addresses only. Never put a secret
  // key, Mesh Key, file key, relay credential or private endpoint here.
  window.__POLYMAI_RENDEZVOUS_CONFIG__ = Object.freeze({
    enabled: true,
    relayUrls: Object.freeze([
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.primal.net"
    ]),
    authorityPublicKeys: Object.freeze([
      // Paste Patient Zero's exported Ed25519 public authority key here.
    ]),
    staticResponders: Object.freeze([
      // Optional public fallback: { authorityPublicKey, transportPublicKey }.
    ])
  });
})();
