import { listMarketTokens } from "./market.js";

export async function listTrending(chain = "all") {
  const tokens = await listMarketTokens(chain === "all" ? "all" : chain as import("../config/chains.js").ChainKey);
  return tokens
    .map((token) => ({
      ...token,
      signals: {
        volumeGrowthScore: Math.min(100, token.volume1hUsd / 2_500),
        holderGrowthScore: Math.min(100, token.newHolders24h / 10),
        buyerPressureScore: Math.min(100, (token.buys / Math.max(token.sells, 1)) * 25),
        smartWalletScore: Math.min(100, token.smartWalletBuys * 5),
        liquidityScore: Math.min(100, token.liquidityUsd / 2_000),
        riskPenalty: token.riskScore,
      },
    }))
    .sort((a, b) => b.trendingScore - a.trendingScore)
    .slice(0, 20);
}
