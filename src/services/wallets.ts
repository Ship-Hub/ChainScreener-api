import { seedTokens } from "../data/seedTokens.js";
import { isChainKey } from "../config/chains.js";
import { getWalletTrackingPolicy, type WalletTrackingTier } from "./retention.js";

export function getWallet(chain: string, address: string) {
  if (!isChainKey(chain)) return undefined;
  const walletTier = inferWalletTier(address);

  return {
    chain,
    address,
    trackingTier: walletTier,
    watched: walletTier === "watched_wallet",
    firstSeenAt: seedTokens[0]?.lastActivityAt,
    positions: seedTokens
      .filter((token) => token.chain === chain)
      .slice(0, 5)
      .map((token, index) => {
        const tier = index === 0 ? walletTier : index < 3 ? "active_wallet" : "cold_wallet";
        const trackingPolicy = getWalletTrackingPolicy(tier, token.lifecycle);

        return {
          token: token.symbol,
          tokenAddress: token.address,
          tokenLifecycle: token.lifecycle,
          trackingTier: tier,
          trackingMode: trackingPolicy.mode,
          retentionReason: trackingPolicy.reason,
          detailedHistoryRetained: trackingPolicy.mode === "full",
          currentHoldings: Math.round(12_000 + index * 8_400),
          realizedPnlUsd: Math.round(900 + index * 1_150),
          unrealizedPnlUsd: Math.round(1_400 - index * 430),
          roiPct: Number((0.18 + index * 0.07).toFixed(2)),
        };
      }),
  };
}

function inferWalletTier(address: string): WalletTrackingTier {
  const normalized = address.toLowerCase();
  if (normalized.includes("smart")) return "smart_wallet";
  if (normalized.includes("watch")) return "watched_wallet";
  if (normalized.endsWith("50")) return "top_holder";
  return "active_wallet";
}
