import type { ChainKey } from "./chains.js";

export type LaunchPlatform = {
  key: string;
  chain: ChainKey;
  name: string;
  matcher: "deployer" | "metadata" | "factory";
  confidence: "low" | "medium" | "high";
};

export const launchPlatforms: LaunchPlatform[] = [
  { key: "clanker", chain: "base", name: "Clanker", matcher: "deployer", confidence: "medium" },
  { key: "bankr", chain: "base", name: "Bankr", matcher: "metadata", confidence: "medium" },
  { key: "proof", chain: "eth", name: "PROOF", matcher: "factory", confidence: "medium" },
  { key: "four-meme", chain: "bsc", name: "Four.Meme", matcher: "factory", confidence: "medium" },
  { key: "springboard", chain: "bsc", name: "PancakeSwap Springboard", matcher: "factory", confidence: "medium" },
];
