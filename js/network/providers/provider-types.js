export const PROVIDER_KINDS = Object.freeze({
  PEER_DISCOVERY: "peer-discovery",
  SIGNALING: "signaling",
  PRESENCE: "presence",
  MANIFEST_DISCOVERY: "manifest-discovery",
  FRAGMENT_DISCOVERY: "fragment-discovery",
  NETWORK_STATS: "network-stats",
  ACCOUNT_DISCOVERY: "account-discovery",
});

const REQUIRED_METHODS = Object.freeze({
  [PROVIDER_KINDS.PEER_DISCOVERY]: ["discoverPeers"],
  [PROVIDER_KINDS.SIGNALING]: ["sendSignal", "onSignal"],
  [PROVIDER_KINDS.PRESENCE]: ["publishPresence", "onPresence"],
  [PROVIDER_KINDS.MANIFEST_DISCOVERY]: ["lookupManifest", "announceManifest"],
  [PROVIDER_KINDS.FRAGMENT_DISCOVERY]: ["lookupFragmentLocations", "announceFragmentLocation"],
  [PROVIDER_KINDS.NETWORK_STATS]: ["getNetworkStats"],
  [PROVIDER_KINDS.ACCOUNT_DISCOVERY]: ["discoverAccount"],
});

export function assertImplementsProvider(provider, kind) {
  const methods = REQUIRED_METHODS[kind];
  if (!methods) throw new Error(`Unknown provider kind: ${kind}`);
  if (!provider?.name) throw new Error(`Provider for "${kind}" must declare a unique "name".`);
  const missing = methods.filter((method) => typeof provider[method] !== "function");
  if (missing.length) throw new Error(`Provider "${provider.name}" is missing required method(s) for "${kind}": ${missing.join(", ")}`);
  return true;
}
