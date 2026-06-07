import { getDb } from "../db/postgres.js";
import { resolveBaseToken, bigIntToFloat, getWalletSwapsRaw } from "./walletService.js";

export type SmFeedItem = {
  id: string;
  action: "BUY" | "SELL";
  timeAgo: string;
  walletAddr: string;
  description: string;
  value: string;
  tokenSymbol: string;
  chain: string;
  txHash: string;
  occurredAt: string;
};

export type SmLeaderEntry = {
  rank: number;
  wallet: string;
  score: number;
  totalTrades: number;
  tokensTraded: number;
  volumeUsd: number;
  winRatePct: number;
  realizedPnlUsd: number;
  earlyEntryPct: number;
  profitableTrades: number;
  totalClosedTrades: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
};

export type SmFlowToken = {
  ticker: string;
  tokenAddress: string;
  chain: string;
  smartWallets: number;
  netFlowUsd: number;
  signal: number;
};

export type SmFlowData = {
  accumulated: SmFlowToken[];
  distributed: SmFlowToken[];
};

export type SmConsensusRow = {
  ticker: string;
  tokenAddress: string;
  chain: string;
  buyWallets: number;
  sellWallets: number;
  totalWallets: number;
  consensus: number;
  strength: "Very Strong" | "Strong" | "Moderate";
};

export type SmMetrics = {
  totalBuys: number;
  totalSells: number;
  netFlowUsd: number;
  activeSmartWallets: number;
  totalVolumeUsd: number;
};

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmtUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

async function getTopSmartWalletAddresses(limit: number): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT address FROM smart_wallets ORDER BY score DESC LIMIT ${limit}
  `;
  return rows.map((r) => r.address as string);
}

export async function getSmartMoneyFeed(hours = 24, limit = 20): Promise<SmFeedItem[]> {
  const wallets = await getTopSmartWalletAddresses(100);
  if (wallets.length === 0) {
    return getRecentSwapsFeed(hours, limit);
  }

  const rows = await getWalletSwapsRaw(wallets, hours, limit * 3);
  const items: SmFeedItem[] = [];

  for (const row of rows) {
    if (items.length >= limit) break;
    const { side, tokenAddress, tokenSymbol, tokenDecimals, tokenPriceUsd, tokenAmountRaw } = resolveBaseToken(row);
    if (!tokenAddress || tokenPriceUsd === 0) continue;

    const amount = bigIntToFloat(tokenAmountRaw, tokenDecimals);
    const valueUsd = amount * tokenPriceUsd;
    if (valueUsd < 1) continue;

    const occurredAt = row.occurredAt instanceof Date
      ? row.occurredAt.toISOString()
      : String(row.occurredAt);
    items.push({
      id: row.txHash as string,
      action: side === "buy" ? "BUY" : "SELL",
      timeAgo: formatTimeAgo(occurredAt),
      walletAddr: shortenAddr((row.walletAddr as string) ?? ""),
      description: `${side === "buy" ? "Bought" : "Sold"} ${tokenSymbol}`,
      value: fmtUsd(valueUsd),
      tokenSymbol,
      chain: row.chain as string,
      txHash: row.txHash as string,
      occurredAt,
    });
  }

  return items;
}

async function getRecentSwapsFeed(hours: number, limit: number): Promise<SmFeedItem[]> {
  const sql = getDb();
  const safeHours = Math.trunc(hours);
  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT
       chains."key"                                        AS chain,
       dexes.name                                          AS "dexName",
       swaps.tx_hash                                       AS "txHash",
       swaps.occurred_at                                   AS "occurredAt",
       swaps.recipient_address                             AS "walletAddr",
       pools.token0_address                                AS token0,
       pools.token1_address                                AS token1,
       COALESCE(t0.symbol,'UNKNOWN')                       AS "token0Symbol",
       COALESCE(t0.decimals,18)                            AS "token0Decimals",
       COALESCE(t1.symbol,'UNKNOWN')                       AS "token1Symbol",
       COALESCE(t1.decimals,18)                            AS "token1Decimals",
       COALESCE(CAST(m0.price_usd AS NUMERIC(36,18)),0)   AS "token0PriceUsd",
       COALESCE(CAST(m1.price_usd AS NUMERIC(36,18)),0)   AS "token1PriceUsd",
       swaps.amount0_raw                                   AS "amount0Raw",
       swaps.amount1_raw                                   AS "amount1Raw"
     FROM swaps
     JOIN chains ON chains.id = swaps.chain_id
     JOIN dexes ON dexes.id = swaps.dex_id
     LEFT JOIN pools ON pools.id = swaps.pool_id
     LEFT JOIN tokens t0 ON t0.chain_id = swaps.chain_id AND t0.address = pools.token0_address
     LEFT JOIN tokens t1 ON t1.chain_id = swaps.chain_id AND t1.address = pools.token1_address
     LEFT JOIN token_market_stats m0 ON m0.chain_id = swaps.chain_id AND m0.token_address = pools.token0_address
     LEFT JOIN token_market_stats m1 ON m1.chain_id = swaps.chain_id AND m1.token_address = pools.token1_address
     WHERE swaps.occurred_at >= NOW() - ($1 * INTERVAL '1 hour')
       AND swaps.pool_id IS NOT NULL
       AND swaps.recipient_address IS NOT NULL
     ORDER BY swaps.block_number DESC
     LIMIT $2`,
    [safeHours, Math.trunc(limit) * 3],
  );

  const items: SmFeedItem[] = [];
  for (const row of rows) {
    if (items.length >= limit) break;
    const { side, tokenAddress, tokenSymbol, tokenDecimals, tokenPriceUsd, tokenAmountRaw } = resolveBaseToken(row);
    if (!tokenAddress || tokenPriceUsd === 0) continue;
    const amount = bigIntToFloat(tokenAmountRaw, tokenDecimals);
    const valueUsd = amount * tokenPriceUsd;
    if (valueUsd < 1) continue;
    const occurredAt = row.occurredAt instanceof Date
      ? row.occurredAt.toISOString()
      : String(row.occurredAt);
    items.push({
      id: row.txHash as string,
      action: side === "buy" ? "BUY" : "SELL",
      timeAgo: formatTimeAgo(occurredAt),
      walletAddr: shortenAddr((row.walletAddr as string) ?? ""),
      description: `${side === "buy" ? "Bought" : "Sold"} ${tokenSymbol}`,
      value: fmtUsd(valueUsd),
      tokenSymbol,
      chain: row.chain as string,
      txHash: row.txHash as string,
      occurredAt,
    });
  }
  return items;
}

export async function getSmartMoneyLeaderboard(limit = 20, hours = 0): Promise<SmLeaderEntry[]> {
  const sql = getDb();
  const rows = hours > 0
    ? await sql`
        SELECT address, score, total_trades, tokens_traded, total_volume_usd, chains_active,
               win_rate_pct, realized_pnl_usd, early_entry_pct,
               profitable_trades, total_closed_trades,
               first_seen_at, last_seen_at
        FROM smart_wallets
        WHERE last_seen_at >= NOW() - (${hours} * INTERVAL '1 hour')
        ORDER BY score DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT address, score, total_trades, tokens_traded, total_volume_usd, chains_active,
               win_rate_pct, realized_pnl_usd, early_entry_pct,
               profitable_trades, total_closed_trades,
               first_seen_at, last_seen_at
        FROM smart_wallets
        ORDER BY score DESC
        LIMIT ${limit}
      `;

  return rows.map((r, i) => ({
    rank: i + 1,
    wallet: shortenAddr(r.address as string),
    score: Number(r.score),
    totalTrades: Number(r.total_trades),
    tokensTraded: Number(r.tokens_traded),
    volumeUsd: Number(r.total_volume_usd),
    winRatePct: Number(r.win_rate_pct ?? 0),
    realizedPnlUsd: Number(r.realized_pnl_usd ?? 0),
    earlyEntryPct: Number(r.early_entry_pct ?? 0),
    profitableTrades: Number(r.profitable_trades ?? 0),
    totalClosedTrades: Number(r.total_closed_trades ?? 0),
    firstSeenAt: r.first_seen_at
      ? (r.first_seen_at instanceof Date ? r.first_seen_at.toISOString() : String(r.first_seen_at))
      : null,
    lastSeenAt: r.last_seen_at
      ? (r.last_seen_at instanceof Date ? r.last_seen_at.toISOString() : String(r.last_seen_at))
      : null,
  }));
}

export async function getSmartMoneyFlow(hours = 24): Promise<SmFlowData> {
  const wallets = await getTopSmartWalletAddresses(100);
  const rows = await getWalletSwapsRaw(wallets, hours, 2000);

  const byToken = new Map<string, {
    ticker: string;
    tokenAddress: string;
    chain: string;
    wallets: Set<string>;
    netFlowUsd: number;
  }>();

  for (const row of rows) {
    const { side, tokenAddress, tokenSymbol, tokenDecimals, tokenPriceUsd, tokenAmountRaw } = resolveBaseToken(row);
    if (!tokenAddress || tokenPriceUsd === 0) continue;

    const amount = bigIntToFloat(tokenAmountRaw, tokenDecimals);
    const valueUsd = amount * tokenPriceUsd;
    const key = `${row.chain as string}:${tokenAddress}`;
    const walletAddr = (row.walletAddr as string) ?? "";

    if (!byToken.has(key)) {
      byToken.set(key, { ticker: tokenSymbol, tokenAddress, chain: row.chain as string, wallets: new Set(), netFlowUsd: 0 });
    }
    const entry = byToken.get(key)!;
    entry.wallets.add(walletAddr);
    entry.netFlowUsd += side === "buy" ? valueUsd : -valueUsd;
  }

  const all = Array.from(byToken.values()).map((e) => ({
    ticker: e.ticker,
    tokenAddress: e.tokenAddress,
    chain: e.chain,
    smartWallets: e.wallets.size,
    netFlowUsd: e.netFlowUsd,
    signal: Math.min(100, Math.max(0, Math.round(50 + e.netFlowUsd / Math.max(1, Math.abs(e.netFlowUsd)) * 45))),
  }));

  const accumulated = all.filter((t) => t.netFlowUsd > 0).sort((a, b) => b.netFlowUsd - a.netFlowUsd).slice(0, 5);
  const distributed = all.filter((t) => t.netFlowUsd < 0).sort((a, b) => a.netFlowUsd - b.netFlowUsd).slice(0, 5);

  return { accumulated, distributed };
}

export async function getSmartMoneyConsensus(hours = 24): Promise<SmConsensusRow[]> {
  const wallets = await getTopSmartWalletAddresses(100);
  const rows = await getWalletSwapsRaw(wallets, hours, 2000);

  const byToken = new Map<string, {
    ticker: string;
    tokenAddress: string;
    chain: string;
    buyWallets: Set<string>;
    sellWallets: Set<string>;
  }>();

  for (const row of rows) {
    const { side, tokenAddress, tokenSymbol } = resolveBaseToken(row);
    if (!tokenAddress) continue;
    const key = `${row.chain as string}:${tokenAddress}`;
    const walletAddr = (row.walletAddr as string) ?? "";

    if (!byToken.has(key)) {
      byToken.set(key, { ticker: tokenSymbol, tokenAddress, chain: row.chain as string, buyWallets: new Set(), sellWallets: new Set() });
    }
    const e = byToken.get(key)!;
    if (side === "buy") e.buyWallets.add(walletAddr);
    else e.sellWallets.add(walletAddr);
  }

  return Array.from(byToken.values())
    .filter((e) => e.buyWallets.size + e.sellWallets.size >= 2)
    .map((e) => {
      const total = e.buyWallets.size + e.sellWallets.size;
      const consensus = Math.round((e.buyWallets.size / total) * 100);
      const strength: SmConsensusRow["strength"] =
        consensus >= 85 ? "Very Strong" : consensus >= 70 ? "Strong" : "Moderate";
      return {
        ticker: e.ticker,
        tokenAddress: e.tokenAddress,
        chain: e.chain,
        buyWallets: e.buyWallets.size,
        sellWallets: e.sellWallets.size,
        totalWallets: total,
        consensus,
        strength,
      };
    })
    .sort((a, b) => b.totalWallets - a.totalWallets)
    .slice(0, 10);
}

export async function getSmartMoneyMetrics(hours = 24): Promise<SmMetrics> {
  const wallets = await getTopSmartWalletAddresses(100);
  if (wallets.length === 0) {
    return { totalBuys: 0, totalSells: 0, netFlowUsd: 0, activeSmartWallets: 0, totalVolumeUsd: 0 };
  }

  const rows = await getWalletSwapsRaw(wallets, hours, 5000);

  let totalBuys = 0;
  let totalSells = 0;
  let netFlowUsd = 0;
  let totalVolumeUsd = 0;
  const activeWallets = new Set<string>();

  for (const row of rows) {
    const { side, tokenDecimals, tokenPriceUsd, tokenAmountRaw } = resolveBaseToken(row);
    if (tokenPriceUsd === 0) continue;
    const amount = bigIntToFloat(tokenAmountRaw, tokenDecimals);
    const valueUsd = amount * tokenPriceUsd;
    totalVolumeUsd += valueUsd;
    if (side === "buy") { totalBuys++; netFlowUsd += valueUsd; }
    else { totalSells++; netFlowUsd -= valueUsd; }
    if (row.walletAddr) activeWallets.add(row.walletAddr as string);
  }

  return { totalBuys, totalSells, netFlowUsd, activeSmartWallets: activeWallets.size, totalVolumeUsd };
}

function shortenAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
