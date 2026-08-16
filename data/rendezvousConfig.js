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
      "8Vuw9FEMaFBiEzm2rUnz1kYjiVhTlp4C8YzL6qEhqqs"
    ]),
    staticResponders: Object.freeze([
      Object.freeze({
        authorityPublicKey: "8Vuw9FEMaFBiEzm2rUnz1kYjiVhTlp4C8YzL6qEhqqs",
        transportPublicKey: "8cbd0813ee9a2ab0f75dd9f378aca29130061ebe79451b45f21ec284c0e355c5"
      })
    ])
  });
})();
