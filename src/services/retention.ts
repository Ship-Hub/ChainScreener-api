import type { TokenLifecycle } from "../types/token.js";

export type WalletTrackingTier = "smart_wallet" | "top_holder" | "watched_wallet" | "active_wallet" | "cold_wallet";
export type TrackingMode = "full" | "summary";

export type WalletTrackingPolicy = {
  tier: WalletTrackingTier;
  mode: TrackingMode;
  fullPnl: boolean;
  fullTransactionHistory: boolean;
  performanceMetrics: "full" | "summary";
  reason: string;
};

export type RetentionPolicy = {
  lifecycle: TokenLifecycle;
  walletTracking: {
    fullTrackingTiers: WalletTrackingTier[];
    coldSummaryFields: string[];
  };
  transfers: {
    detail: "full" | "recent" | "delete";
    recentDays?: number;
    alwaysRetain: string[];
  };
  swaps: {
    detail: "full" | "recent_then_aggregate" | "delete";
    retainAggregates: string[];
  };
  candles: Array<{
    interval: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
    retainForDays: number | null;
  }>;
};

const coldSummaryFields = [
  "wallet_address",
  "token_address",
  "current_balance",
  "realized_pnl_summary",
  "unrealized_pnl_summary",
  "roi_summary",
  "last_activity_timestamp",
];

const candleRetention = [
  { interval: "1m" as const, retainForDays: 7 },
  { interval: "5m" as const, retainForDays: 30 },
  { interval: "15m" as const, retainForDays: 60 },
  { interval: "1h" as const, retainForDays: 180 },
  { interval: "4h" as const, retainForDays: null },
  { interval: "1d" as const, retainForDays: null },
];

export const walletTierPriority: WalletTrackingTier[] = ["smart_wallet", "top_holder", "watched_wallet", "active_wallet", "cold_wallet"];

export function getWalletTrackingPolicy(tier: WalletTrackingTier, lifecycle: TokenLifecycle): WalletTrackingPolicy {
  if (tier === "smart_wallet") return fullPolicy(tier, "smart_wallet");
  if (tier === "top_holder") return fullPolicy(tier, "top_50_holder");
  if (tier === "watched_wallet") return fullPolicy(tier, "user_watchlist");
  if (tier === "active_wallet" && lifecycle === "hot") return fullPolicy(tier, "hot_token_activity");

  return {
    tier: "cold_wallet",
    mode: "summary",
    fullPnl: false,
    fullTransactionHistory: false,
    performanceMetrics: "summary",
    reason: lifecycle === "cold" ? "cold_token_summary_retention" : "wallet_not_in_priority_tracking_set",
  };
}

export function getRetentionPolicy(lifecycle: TokenLifecycle): RetentionPolicy {
  if (lifecycle === "hot") {
    return {
      lifecycle,
      walletTracking: {
        fullTrackingTiers: ["smart_wallet", "top_holder", "watched_wallet", "active_wallet"],
        coldSummaryFields,
      },
      transfers: {
        detail: "full",
        alwaysRetain: holderRetentionFields(),
      },
      swaps: {
        detail: "full",
        retainAggregates: swapAggregateFields(),
      },
      candles: candleRetention,
    };
  }

  if (lifecycle === "warm") {
    return {
      lifecycle,
      walletTracking: {
        fullTrackingTiers: ["smart_wallet", "top_holder", "watched_wallet"],
        coldSummaryFields,
      },
      transfers: {
        detail: "recent",
        recentDays: 30,
        alwaysRetain: holderRetentionFields(),
      },
      swaps: {
        detail: "recent_then_aggregate",
        retainAggregates: swapAggregateFields(),
      },
      candles: candleRetention,
    };
  }

  return {
    lifecycle,
    walletTracking: {
      fullTrackingTiers: ["smart_wallet", "top_holder", "watched_wallet"],
      coldSummaryFields,
    },
    transfers: {
      detail: "delete",
      alwaysRetain: holderRetentionFields(),
    },
    swaps: {
      detail: "delete",
      retainAggregates: swapAggregateFields(),
    },
    candles: candleRetention,
  };
}

export function shouldRehydrate(reason: string) {
  return ["token_became_active", "wallet_interacted", "top_50_holder", "smart_wallet_promoted", "watchlist_added"].includes(reason);
}

function fullPolicy(tier: WalletTrackingTier, reason: string): WalletTrackingPolicy {
  return {
    tier,
    mode: "full",
    fullPnl: true,
    fullTransactionHistory: true,
    performanceMetrics: "full",
    reason,
  };
}

function holderRetentionFields() {
  return ["current_holder_balances", "daily_holder_snapshots", "top_50_holder_snapshots", "holder_count_history", "holder_growth_metrics"];
}

function swapAggregateFields() {
  return ["total_volume", "total_buys", "total_sells", "ath_volume", "daily_candle_history"];
}
