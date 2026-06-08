import { getRecentDiscoveredPools, getRecentIndexedSwaps } from "./indexerStatus.js";
import { listMarketTokens } from "./market.js";

export type LiveFeedSnapshot = {
  type: "snapshot";
  emittedAt: string;
  tokens: Awaited<ReturnType<typeof listMarketTokens>>;
  livePools: Awaited<ReturnType<typeof getRecentDiscoveredPools>>;
  liveSwaps: Awaited<ReturnType<typeof getRecentIndexedSwaps>>;
};

export async function getLiveFeedSnapshot(): Promise<LiveFeedSnapshot> {
  const [tokens, livePools, liveSwaps] = await Promise.all([
    listMarketTokens("all", "volume"),
    getRecentDiscoveredPools(12),
    getRecentIndexedSwaps(12),
  ]);

  return {
    type: "snapshot",
    emittedAt: new Date().toISOString(),
    tokens,
    livePools,
    liveSwaps,
  };
}
