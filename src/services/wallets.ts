import { seedTokens } from "../data/seedTokens.js";
import { isChainKey } from "../config/chains.js";

export function getWallet(chain: string, address: string) {
  if (!isChainKey(chain)) return undefined;

  return {
    chain,
    address,
    watched: false,
    firstSeenAt: seedTokens[0]?.lastActivityAt,
    positions: seedTokens
      .filter((token) => token.chain === chain)
      .slice(0, 5)
      .map((token, index) => ({
        token: token.symbol,
        tokenAddress: token.address,
        currentHoldings: Math.round(12_000 + index * 8_400),
        realizedPnlUsd: Math.round(900 + index * 1_150),
        unrealizedPnlUsd: Math.round(1_400 - index * 430),
        roiPct: Number((0.18 + index * 0.07).toFixed(2)),
      })),
  };
}
