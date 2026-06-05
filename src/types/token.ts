import type { ChainKey } from "../config/chains.js";

export type RiskLevel = "Low" | "Medium" | "High" | "Extreme";
export type TokenLifecycle = "hot" | "warm" | "cold";

export type TokenSummary = {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  logoUrl?: string;
  launchSource: string;
  /** Platform key if launched via a known launchpad (e.g. "clanker", "bankr") */
  launchPlatform: string | null;
  dex: string;
  ageMinutes: number;
  lifecycle: TokenLifecycle;
  priceUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  volume24hUsd: number;
  buys: number;
  sells: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  holders: number;
  newHolders24h: number;
  smartWalletBuys: number;
  devWalletActivity: string;
  topHolderConcentration: number;
  riskScore: number;
  riskLevel: RiskLevel;
  trendingScore: number;
  lastActivityAt: string;
};

export type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Swap = {
  id: string;
  time: string;
  side: "buy" | "sell";
  wallet: string;
  amountToken: number;
  amountUsd: number;
  priceUsd: number;
};

export type Holder = {
  wallet: string;
  balance: number;
  sharePct: number;
  pnlUsd: number;
};
