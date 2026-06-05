import { getDb } from "../db/postgres.js";

// Known quote asset addresses — stablecoins + wrapped natives across chains
const QUOTE_ADDRESSES = new Set([
  // Base
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
  "0x4200000000000000000000000000000000000006", // WETH
  // Ethereum
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  // BSC
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
]);

export type WalletTrade = {
  chain: string;
  dexName: string;
  txHash: string;
  blockNumber: number;
  occurredAt: string;
  side: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: number;
  priceUsd: number;
  valueUsd: number;
  poolAddress: string | null;
};

export type WalletStats = {
  address: string;
  totalTrades: number;
  tokenCount: number;
  chainCount: number;
  totalVolumeUsd: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  score: number;
  // Quality signals — populated after computeSmartWallets has run
  winRatePct: number;
  realizedPnlUsd: number;
  earlyEntryPct: number;
  profitableTrades: number;
  totalClosedTrades: number;
};

export type WalletHolding = {
  chain: string;
  tokenAddress: string;
  tokenSymbol: string;
  netAmount: number;
  priceUsd: number;
  valueUsd: number;
  priceChange24h: number;
};

function parseBigInt(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

function bigIntToFloat(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const abs = raw < 0n ? -raw : raw;
  const d = Math.min(decimals, 18);
  const divisor = 10n ** BigInt(d);
  const whole = Number(abs / divisor);
  const frac = Number(abs % divisor) / 10 ** d;
  const result = whole + frac;
  return isFinite(result) ? (raw < 0n ? -result : result) : 0;
}

function resolveBaseToken(row: Record<string, unknown>): {
  side: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenPriceUsd: number;
  tokenAmountRaw: bigint;
} {
  const amt0 = parseBigInt(row.amount0Raw as string);
  const amt1 = parseBigInt(row.amount1Raw as string);
  const t0IsQuote = QUOTE_ADDRESSES.has(((row.token0 as string) ?? "").toLowerCase());
  const t1IsQuote = QUOTE_ADDRESSES.has(((row.token1 as string) ?? "").toLowerCase());

  // token0 = base, token1 = quote
  if (!t0IsQuote && t1IsQuote) {
    return {
      side: amt0 < 0n ? "buy" : "sell",
      tokenAddress: row.token0 as string,
      tokenSymbol: row.token0Symbol as string,
      tokenDecimals: Number(row.token0Decimals),
      tokenPriceUsd: Number(row.token0PriceUsd),
      tokenAmountRaw: amt0 < 0n ? -amt0 : amt0,
    };
  }
  // token1 = base, token0 = quote
  if (t0IsQuote && !t1IsQuote) {
    return {
      side: amt1 < 0n ? "buy" : "sell",
      tokenAddress: row.token1 as string,
      tokenSymbol: row.token1Symbol as string,
      tokenDecimals: Number(row.token1Decimals),
      tokenPriceUsd: Number(row.token1PriceUsd),
      tokenAmountRaw: amt1 < 0n ? -amt1 : amt1,
    };
  }
  // Neither or both are quote — use token0 as base
  return {
    side: amt0 < 0n ? "buy" : "sell",
    tokenAddress: row.token0 as string,
    tokenSymbol: row.token0Symbol as string,
    tokenDecimals: Number(row.token0Decimals),
    tokenPriceUsd: Number(row.token0PriceUsd),
    tokenAmountRaw: amt0 < 0n ? -amt0 : amt0,
  };
}

const SWAP_COLS = `
  chains."key"                                        AS chain,
  dexes.name                                          AS "dexName",
  swaps.tx_hash                                       AS "txHash",
  swaps.block_number                                  AS "blockNumber",
  swaps.occurred_at                                   AS "occurredAt",
  swaps.pool_address                                  AS "poolAddress",
  pools.token0_address                                AS token0,
  pools.token1_address                                AS token1,
  COALESCE(t0.symbol, 'UNKNOWN')                      AS "token0Symbol",
  COALESCE(t0.decimals, 18)                           AS "token0Decimals",
  COALESCE(t1.symbol, 'UNKNOWN')                      AS "token1Symbol",
  COALESCE(t1.decimals, 18)                           AS "token1Decimals",
  COALESCE(CAST(m0.price_usd AS NUMERIC(36,18)), 0)  AS "token0PriceUsd",
  COALESCE(CAST(m1.price_usd AS NUMERIC(36,18)), 0)  AS "token1PriceUsd",
  swaps.amount0_raw                                   AS "amount0Raw",
  swaps.amount1_raw                                   AS "amount1Raw"
`;

const SWAP_JOINS = `
  JOIN chains ON chains.id = swaps.chain_id
  JOIN dexes ON dexes.id = swaps.dex_id
  LEFT JOIN pools ON pools.id = swaps.pool_id
  LEFT JOIN tokens t0 ON t0.chain_id = swaps.chain_id AND t0.address = pools.token0_address
  LEFT JOIN tokens t1 ON t1.chain_id = swaps.chain_id AND t1.address = pools.token1_address
  LEFT JOIN token_market_stats m0 ON m0.chain_id = swaps.chain_id AND m0.token_address = pools.token0_address
  LEFT JOIN token_market_stats m1 ON m1.chain_id = swaps.chain_id AND m1.token_address = pools.token1_address
`;

function rowToTrade(row: Record<string, unknown>): WalletTrade {
  const { side, tokenAddress, tokenSymbol, tokenDecimals, tokenPriceUsd, tokenAmountRaw } = resolveBaseToken(row);
  const tokenAmount = bigIntToFloat(tokenAmountRaw, tokenDecimals);
  return {
    chain: row.chain as string,
    dexName: row.dexName as string,
    txHash: row.txHash as string,
    blockNumber: Number(row.blockNumber),
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
    side,
    tokenAddress,
    tokenSymbol,
    tokenAmount,
    priceUsd: tokenPriceUsd,
    valueUsd: tokenAmount * tokenPriceUsd,
    poolAddress: (row.poolAddress as string | null) ?? null,
  };
}

export async function getWalletTrades(address: string, limit = 50): Promise<WalletTrade[]> {
  const sql = getDb();
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const addr = address.toLowerCase();

  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT ${SWAP_COLS}
     FROM swaps
     ${SWAP_JOINS}
     WHERE (swaps.recipient_address = $1 OR swaps.sender_address = $1)
       AND swaps.pool_id IS NOT NULL
     ORDER BY swaps.block_number DESC
     LIMIT $2`,
    [addr, safeLimit],
  );

  return rows.map(rowToTrade);
}

export async function getWalletStats(address: string): Promise<WalletStats> {
  const sql = getDb();
  const addr = address.toLowerCase();

  // Try pre-computed smart_wallets entry first
  const swRows = await sql`
    SELECT score, total_volume_usd, total_trades, tokens_traded, chains_active,
           win_rate_pct, realized_pnl_usd, early_entry_pct,
           profitable_trades, total_closed_trades,
           first_seen_at, last_seen_at
    FROM smart_wallets WHERE address = ${addr}
  `;

  if (swRows[0]) {
    const sw = swRows[0];
    return {
      address: addr,
      totalTrades: Number(sw.total_trades),
      tokenCount: Number(sw.tokens_traded),
      chainCount: Number(sw.chains_active),
      totalVolumeUsd: Number(sw.total_volume_usd),
      firstSeenAt: toIsoOrNull(sw.first_seen_at),
      lastSeenAt: toIsoOrNull(sw.last_seen_at),
      score: Number(sw.score),
      winRatePct: Number(sw.win_rate_pct ?? 0),
      realizedPnlUsd: Number(sw.realized_pnl_usd ?? 0),
      earlyEntryPct: Number(sw.early_entry_pct ?? 0),
      profitableTrades: Number(sw.profitable_trades ?? 0),
      totalClosedTrades: Number(sw.total_closed_trades ?? 0),
    };
  }

  // Compute on the fly for unknown wallets
  const aggRows = await sql`
    SELECT
      COUNT(*) AS trade_count,
      COUNT(DISTINCT COALESCE(p.token0_address, '') || ':' || COALESCE(p.token1_address, '')) AS tokens_traded,
      COUNT(DISTINCT s.chain_id) AS chain_count,
      MIN(s.occurred_at) AS first_seen,
      MAX(s.occurred_at) AS last_seen
    FROM swaps s
    LEFT JOIN pools p ON p.id = s.pool_id
    WHERE s.recipient_address = ${addr} OR s.sender_address = ${addr}
  `;

  const agg = aggRows[0] ?? {};
  const tc = Number(agg.trade_count ?? 0);
  const toks = Number(agg.tokens_traded ?? 0);
  const chainsCount = Number(agg.chain_count ?? 0);
  const score = Math.min(100, Math.floor(Math.log(1 + tc) * 15 + toks * 5 + chainsCount * 10));

  return {
    address: addr,
    totalTrades: tc,
    tokenCount: toks,
    chainCount: chainsCount,
    totalVolumeUsd: 0,
    firstSeenAt: toIsoOrNull(agg.first_seen),
    lastSeenAt: toIsoOrNull(agg.last_seen),
    score,
    winRatePct: 0,
    realizedPnlUsd: 0,
    earlyEntryPct: 0,
    profitableTrades: 0,
    totalClosedTrades: 0,
  };
}

export async function getWalletHoldings(address: string): Promise<WalletHolding[]> {
  const sql = getDb();
  const addr = address.toLowerCase();

  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT ${SWAP_COLS},
       COALESCE(CAST(m0.price_change_24h_pct AS NUMERIC(18,8)), 0) AS "token0Change24h",
       COALESCE(CAST(m1.price_change_24h_pct AS NUMERIC(18,8)), 0) AS "token1Change24h"
     FROM swaps
     ${SWAP_JOINS}
     WHERE (swaps.recipient_address = $1 OR swaps.sender_address = $1)
       AND swaps.pool_id IS NOT NULL
     ORDER BY swaps.block_number DESC
     LIMIT 500`,
    [addr],
  );

  // Aggregate net holdings per chain+token
  const holdings = new Map<string, WalletHolding>();
  for (const row of rows) {
    const { side, tokenAddress, tokenSymbol, tokenDecimals, tokenPriceUsd, tokenAmountRaw } = resolveBaseToken(row);
    if (!tokenAddress || tokenPriceUsd === 0) continue;

    const key = `${row.chain as string}:${tokenAddress}`;
    const amount = bigIntToFloat(tokenAmountRaw, tokenDecimals);
    const delta = side === "buy" ? amount : -amount;
    const change24h = QUOTE_ADDRESSES.has(tokenAddress.toLowerCase())
      ? 0
      : Number(row.token0Symbol === tokenSymbol ? row.token0Change24h : row.token1Change24h);

    if (!holdings.has(key)) {
      holdings.set(key, {
        chain: row.chain as string,
        tokenAddress,
        tokenSymbol,
        netAmount: delta,
        priceUsd: tokenPriceUsd,
        valueUsd: 0,
        priceChange24h: change24h,
      });
    } else {
      holdings.get(key)!.netAmount += delta;
    }
  }

  return Array.from(holdings.values())
    .filter((h) => h.netAmount > 0 && h.priceUsd > 0)
    .map((h) => ({ ...h, valueUsd: h.netAmount * h.priceUsd }))
    .sort((a, b) => b.valueUsd - a.valueUsd)
    .slice(0, 20);
}

export async function getWalletSwapsRaw(
  addresses: string[],
  hourLimit: number,
  limit: number,
): Promise<Record<string, unknown>[]> {
  if (addresses.length === 0) return [];
  const sql = getDb();
  const safeHours = Math.trunc(hourLimit);
  const safeLimit = Math.trunc(limit);

  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT ${SWAP_COLS},
       swaps.recipient_address AS "walletAddr"
     FROM swaps
     ${SWAP_JOINS}
     WHERE swaps.recipient_address = ANY($1)
       AND swaps.pool_id IS NOT NULL
       AND swaps.occurred_at >= NOW() - ($2 * INTERVAL '1 hour')
     ORDER BY swaps.block_number DESC
     LIMIT $3`,
    [addresses, safeHours, safeLimit],
  );
  return rows;
}

function toIsoOrNull(val: unknown): string | null {
  if (!val) return null;
  return val instanceof Date ? val.toISOString() : String(val);
}

export { rowToTrade, resolveBaseToken, parseBigInt, bigIntToFloat, QUOTE_ADDRESSES };
