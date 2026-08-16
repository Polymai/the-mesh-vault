(function () {
  // Public Patient Zero trust only. Never put a secret key, Mesh Key, file
  // key, credential or private endpoint here.
  window.__POLYMAI_RENDEZVOUS_CONFIG__ = Object.freeze({
    // Public rendezvous relays are intentionally disabled. Supabase is used
    // only as the first-contact signaling gate to Patient Zero.
    enabled: false,
    relayUrls: Object.freeze([]),
    authorityPublicKeys: Object.freeze([
      "8Vuw9FEMaFBiEzm2rUnz1kYjiVhTlp4C8YzL6qEhqqs"
    ]),
    staticResponders: Object.freeze([])
  });
})();
