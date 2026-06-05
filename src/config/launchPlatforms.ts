import type { ChainKey } from "./chains.js";

export type LaunchPlatform = {
  key: string;
  chain: ChainKey;
  name: string;
  /**
   * Addresses that appear as tx.from when this platform creates a DEX pool.
   * All lowercase for fast comparison.
   */
  factoryAddresses: string[];
  matcher: "deployer" | "metadata" | "factory";
  confidence: "low" | "medium" | "high";
};

export const launchPlatforms: LaunchPlatform[] = [
  {
    key: "clanker",
    chain: "base",
    name: "Clanker",
    matcher: "deployer",
    confidence: "high",
    // Source: https://clanker.gitbook.io/clanker-documentation/references/deployed-contracts
    factoryAddresses: [
      "0x250c9fb2b411b48273f69879007803790a6aea47", // v0 SocialDexDeployer
      "0x9b84fce5dcd9a38d2d01d5d72373f6b6b067c3e1", // v1
      "0x732560fa1d1a76350b1a500155ba978031b53833", // v2
      "0x375c15db32d28cecdcab5c03ab889bf15cbd2c5e", // v3
      "0xd9acd656a5f1b519c9e76a2a6092265a74186e58", // v3.1
      "0xe85a59c628f7d27878aceb4bf3b35733630083a9", // v4
    ],
  },
  {
    key: "bankr",
    chain: "base",
    name: "Bankr",
    matcher: "deployer",
    confidence: "medium",
    // TODO: verify Bankr factory address on BaseScan — update if incorrect
    factoryAddresses: [
      "0x532f27101965dd16442e59d40670faf5ebb142e4",
    ],
  },
  {
    key: "four-meme",
    chain: "bsc",
    name: "Four.Meme",
    matcher: "factory",
    confidence: "medium",
    factoryAddresses: [],
  },
  {
    key: "springboard",
    chain: "bsc",
    name: "PancakeSwap Springboard",
    matcher: "factory",
    confidence: "medium",
    factoryAddresses: [],
  },
];

/**
 * Build a fast lookup map: `${chain}:${address}` → platformKey
 * Used in pool discovery to tag tokens without iterating the full array.
 */
export function buildPlatformLookup(): Map<string, string> {
  const map = new Map<string, string>();
  for (const platform of launchPlatforms) {
    for (const addr of platform.factoryAddresses) {
      map.set(`${platform.chain}:${addr.toLowerCase()}`, platform.key);
    }
  }
  return map;
}
