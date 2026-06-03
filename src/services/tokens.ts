import { isChainKey, type ChainKey } from "../config/chains.js";
import { seedCandles, seedHolders, seedSwaps, seedTokens } from "../data/seedTokens.js";
import type { TokenSummary } from "../types/token.js";

export type TokenFilters = {
  chain?: string;
  q?: string;
  risk?: string;
  launchSource?: string;
};

export function listTokens(filters: TokenFilters = {}) {
  return seedTokens
    .filter((token) => !filters.chain || filters.chain === "all" || token.chain === filters.chain)
    .filter((token) => !filters.risk || token.riskLevel.toLowerCase() === filters.risk.toLowerCase())
    .filter((token) => !filters.launchSource || token.launchSource.toLowerCase() === filters.launchSource.toLowerCase())
    .filter((token) => {
      if (!filters.q) return true;
      const needle = filters.q.toLowerCase();
      return token.symbol.toLowerCase().includes(needle) || token.name.toLowerCase().includes(needle) || token.address.toLowerCase().includes(needle);
    })
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

export function getToken(chain: string, address: string): TokenSummary | undefined {
  if (!isChainKey(chain)) return undefined;
  return seedTokens.find((token) => token.chain === chain && token.address.toLowerCase() === address.toLowerCase());
}

export function getTokenChart(chain: string, address: string) {
  return getToken(chain, address) ? seedCandles : undefined;
}

export function getTokenSwaps(chain: string, address: string) {
  return getToken(chain, address) ? seedSwaps : undefined;
}

export function getTokenHolders(chain: string, address: string) {
  return getToken(chain, address) ? seedHolders : undefined;
}

export function getTokenRisk(chain: string, address: string) {
  const token = getToken(chain, address);
  if (!token) return undefined;

  return {
    score: token.riskScore,
    level: token.riskLevel,
    reasons: [
      `${token.topHolderConcentration}% supply held by the top wallets`,
      token.devWalletActivity === "quiet" ? "No significant deployer selling detected" : `Developer wallet activity: ${token.devWalletActivity}`,
      token.smartWalletBuys > 10 ? `${token.smartWalletBuys} smart wallet buys detected` : "Limited smart wallet confirmation",
      token.liquidityUsd < 50_000 ? "Liquidity is still thin" : "Liquidity depth is acceptable for age",
    ],
  };
}

export function getTokenPnl(chain: string, address: string) {
  if (!getToken(chain, address)) return undefined;
  return seedHolders.slice(0, 8).map((holder, index) => ({
    wallet: holder.wallet,
    totalBoughtUsd: Math.round(4_000 + index * 1_850),
    totalSoldUsd: Math.round(900 + index * 920),
    currentHoldings: holder.balance,
    realizedPnlUsd: Math.round(holder.pnlUsd * 0.45),
    unrealizedPnlUsd: Math.round(holder.pnlUsd * 0.55),
    roiPct: Number((holder.pnlUsd / 10_000).toFixed(2)),
  }));
}

export function listLaunches(chain?: ChainKey | "all") {
  return listTokens({ chain }).map((token) => ({
    chain: token.chain,
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    launchSource: token.launchSource,
    dex: token.dex,
    ageMinutes: token.ageMinutes,
    liquidityUsd: token.liquidityUsd,
    riskLevel: token.riskLevel,
  }));
}
