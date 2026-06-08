import type { ChainKey } from "../config/chains.js";
import { getDb } from "../db/postgres.js";
import type { Candle, TokenSummary } from "../types/token.js";

// Average block times per chain (ms) — mirrors aggregateMarket.ts / tokenDetail.ts
const BLOCK_TIME_MS: Partial<Record<ChainKey, number>> = {
  base: 2_000,
  eth:  12_000,
  bsc:  3_000,
};

type MarketTokenRow = {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  decimals: string | number;
  totalSupply: string | null;
  launchPlatform: string | null;
  priceUsd: string;
  priceChange24h: string;
  volume24hUsd: string;
  swaps24h: string | number;
  buys24h: string | number;
  sells24h: string | number;
  liquidityUsd: string;
  updatedAt: Date | string;
  dexName: string | null;
  /** Set only when pools.block_timestamp has been backfilled; NULL otherwise. */
  poolCreatedAt: Date | string | null;
  /** Always available — used for age estimation when poolCreatedAt is NULL. */
  poolBlockNumber: string | number | null;
  candle1hNow: string | null;
  candle1hPrev: string | null;
  candle5mNow: string | null;
  candle5mPrev: string | null;
};

/** Return the highest ingested block per chain (from the swap-ingestion cursor). */
async function getCurrentBlocksByChain(): Promise<Map<ChainKey, number>> {
  const sql = getDb();
  try {
    const rows = await sql`
      SELECT chain_key, MAX(last_block::bigint) AS last_block
      FROM indexer_cursors
      WHERE worker_name = 'swap-ingestion'
      GROUP BY chain_key
    `;
    const map = new Map<ChainKey, number>();
    for (const row of rows) {
      if (row.chain_key && row.last_block) {
        map.set(row.chain_key as ChainKey, Number(row.last_block));
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

type CandleRow = {
  openedAt: Date | string;
  openUsd: string;
  highUsd: string;
  lowUsd: string;
  closeUsd: string;
  volumeUsd: string;
};

export type TokenSortOrder = "volume" | "gainers" | "losers" | "newest";

export async function listMarketTokens(
  chain?: ChainKey | "all",
  sort: TokenSortOrder = "volume",
  platform?: string,
): Promise<TokenSummary[]> {
  const sql = getDb();

  const chainCondition = chain && chain !== "all"
    ? sql`AND chains."key" = ${chain}`
    : sql``;
  const platformCondition = platform
    ? sql`AND tokens.launch_platform = ${platform}`
    : sql``;

  const orderBy =
    sort === "gainers" ? sql`tms.price_change_24h_pct DESC`
    : sort === "losers"  ? sql`tms.price_change_24h_pct ASC`
    : sort === "newest"  ? sql`tms.updated_at DESC`
    : sql`tms.volume_24h_usd DESC, tms.updated_at DESC`;

  const rows = await sql<MarketTokenRow[]>`
    SELECT
      chains."key"                          AS chain,
      tms.token_address                     AS address,
      COALESCE(tokens.symbol, 'UNKNOWN')    AS symbol,
      COALESCE(tokens.name, 'Unknown Token') AS name,
      COALESCE(tokens.decimals, 18)         AS decimals,
      tokens.total_supply                   AS "totalSupply",
      tokens.launch_platform                AS "launchPlatform",
      tms.price_usd                         AS "priceUsd",
      tms.price_change_24h_pct              AS "priceChange24h",
      tms.volume_24h_usd                    AS "volume24hUsd",
      tms.swaps_24h                         AS "swaps24h",
      tms.buys_24h                          AS "buys24h",
      tms.sells_24h                         AS "sells24h",
      tms.liquidity_usd                     AS "liquidityUsd",
      tms.updated_at                        AS "updatedAt",

      (
        SELECT d.name
        FROM   pools p
        JOIN   dexes d ON d.id = p.dex_id
        WHERE  p.chain_id = tms.chain_id
          AND  (p.token0_address = tms.token_address OR p.token1_address = tms.token_address)
        ORDER  BY p.created_at DESC
        LIMIT  1
      ) AS "dexName",

      (
        SELECT MIN(p2.block_timestamp)
        FROM   pools p2
        WHERE  p2.chain_id = tms.chain_id
          AND  (p2.token0_address = tms.token_address OR p2.token1_address = tms.token_address)
      ) AS "poolCreatedAt",

      (
        SELECT MIN(p2.block_number)
        FROM   pools p2
        WHERE  p2.chain_id = tms.chain_id
          AND  (p2.token0_address = tms.token_address OR p2.token1_address = tms.token_address)
      ) AS "poolBlockNumber",

      (
        SELECT close_usd FROM token_candles_1h
        WHERE  chain_id      = tms.chain_id
          AND  token_address = tms.token_address
        ORDER  BY bucket DESC
        LIMIT  1
      ) AS "candle1hNow",
      (
        SELECT close_usd FROM token_candles_1h
        WHERE  chain_id      = tms.chain_id
          AND  token_address = tms.token_address
        ORDER  BY bucket DESC
        LIMIT  1 OFFSET 1
      ) AS "candle1hPrev",

      (
        SELECT close_usd FROM token_candles_5m
        WHERE  chain_id      = tms.chain_id
          AND  token_address = tms.token_address
        ORDER  BY bucket DESC
        LIMIT  1
      ) AS "candle5mNow",
      (
        SELECT close_usd FROM token_candles_5m
        WHERE  chain_id      = tms.chain_id
          AND  token_address = tms.token_address
        ORDER  BY bucket DESC
        LIMIT  1 OFFSET 1
      ) AS "candle5mPrev"

    FROM  token_market_stats tms
    JOIN  chains ON chains.id = tms.chain_id
    LEFT JOIN tokens
            ON tokens.chain_id = tms.chain_id
           AND tokens.address  = tms.token_address
    WHERE TRUE
      ${chainCondition}
      ${platformCondition}
    ORDER BY ${orderBy}
    LIMIT 50
  `;

  const currentBlocks = await getCurrentBlocksByChain();
  const now = Date.now();
  return rows.map((row) => marketRowToTokenSummary(row, currentBlocks, now));
}

export async function getMarketCandles(chain: ChainKey, address: string, interval = "5m"): Promise<Candle[]> {
  const sql = getDb();
  const addr = address.toLowerCase();

  const view = interval === "1h" ? "token_candles_1h" : "token_candles_5m";

  const rows = await sql<CandleRow[]>`
    SELECT
      tc.bucket     AS "openedAt",
      tc.open_usd   AS "openUsd",
      tc.high_usd   AS "highUsd",
      tc.low_usd    AS "lowUsd",
      tc.close_usd  AS "closeUsd",
      tc.volume_usd AS "volumeUsd"
    FROM ${sql(view)} tc
    JOIN chains ON chains."key" = ${chain}
             AND chains.id = tc.chain_id
    WHERE tc.token_address = ${addr}
    ORDER BY tc.bucket ASC
    LIMIT 500
  `;

  // If requested interval has no data and it's not 5m, fall back to 5m
  if (rows.length === 0 && interval !== "5m") {
    const fallback = await sql<CandleRow[]>`
      SELECT
        tc.bucket     AS "openedAt",
        tc.open_usd   AS "openUsd",
        tc.high_usd   AS "highUsd",
        tc.low_usd    AS "lowUsd",
        tc.close_usd  AS "closeUsd",
        tc.volume_usd AS "volumeUsd"
      FROM token_candles_5m tc
      JOIN chains ON chains."key" = ${chain}
               AND chains.id = tc.chain_id
      WHERE tc.token_address = ${addr}
      ORDER BY tc.bucket ASC
      LIMIT 500
    `;
    return fallback.map(candleRowToCandle);
  }

  return rows.map(candleRowToCandle);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function candleRowToCandle(row: CandleRow): Candle {
  const t = row.openedAt instanceof Date ? row.openedAt : new Date(row.openedAt as string);
  return {
    time:   t.toISOString(),
    open:   Number(row.openUsd),
    high:   Number(row.highUsd),
    low:    Number(row.lowUsd),
    close:  Number(row.closeUsd),
    volume: Number(row.volumeUsd),
  };
}

function candlePctChange(now: string | null, prev: string | null): number | null {
  const n = Number(now);
  const p = Number(prev);
  if (!now || !prev || p === 0) return null;
  return ((n - p) / p) * 100;
}

function marketRowToTokenSummary(
  row: MarketTokenRow,
  currentBlocks: Map<ChainKey, number>,
  now: number,
): TokenSummary {
  const addressTail    = row.address.slice(-4).toUpperCase();
  const priceChange24h = Number(row.priceChange24h);
  const volume24hUsd   = Number(row.volume24hUsd);
  const priceUsd       = Number(row.priceUsd);
  const swaps          = Number(row.swaps24h);

  const hasRealSymbol = row.symbol && row.symbol !== "UNKNOWN";
  const hasRealName   = row.name   && row.name   !== "Unknown Token";

  const poolCreatedAt = row.poolCreatedAt
    ? (row.poolCreatedAt instanceof Date ? row.poolCreatedAt : new Date(row.poolCreatedAt as string))
    : null;
  const poolBlockNumber = row.poolBlockNumber ? Number(row.poolBlockNumber) : null;
  const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt as string);

  // Compute age: prefer on-chain block_timestamp; fall back to block-number estimation
  // (uses cursor block so it's immediately accurate without waiting for the slow backfill);
  // last resort is the DB insertion time stored in updated_at.
  let ageMinutes: number;
  if (poolCreatedAt) {
    ageMinutes = Math.max(1, Math.round((now - poolCreatedAt.getTime()) / 60_000));
  } else if (poolBlockNumber) {
    const currentBlock = currentBlocks.get(row.chain) ?? 0;
    if (currentBlock > 0) {
      const blockTimeMs = BLOCK_TIME_MS[row.chain] ?? 6_000;
      const blocksAgo = Math.max(0, currentBlock - poolBlockNumber);
      ageMinutes = Math.max(1, Math.round((blocksAgo * blockTimeMs) / 60_000));
    } else {
      ageMinutes = Math.max(1, Math.round((now - updatedAt.getTime()) / 60_000));
    }
  } else {
    ageMinutes = Math.max(1, Math.round((now - updatedAt.getTime()) / 60_000));
  }

  const ageHours = ageMinutes / 60;

  const priceChange1h = candlePctChange(row.candle1hNow, row.candle1hPrev) ?? priceChange24h;
  const priceChange5m = candlePctChange(row.candle5mNow, row.candle5mPrev) ?? priceChange24h;

  let marketCapUsd = 0;
  if (row.totalSupply && priceUsd > 0) {
    try {
      const supply = Number(BigInt(row.totalSupply)) / 10 ** Number(row.decimals);
      marketCapUsd = supply * priceUsd;
    } catch {
      marketCapUsd = 0;
    }
  }

  const isNew      = ageHours < 24;
  const highVolume = volume24hUsd > 50_000;
  const riskScore  = isNew && !highVolume ? 65 : highVolume ? 35 : 50;
  const riskLevel: TokenSummary["riskLevel"] =
    riskScore < 40 ? "Low" : riskScore < 60 ? "Medium" : "High";

  return {
    chain:   row.chain,
    address: row.address,
    symbol:  hasRealSymbol ? row.symbol : `TKN${addressTail}`,
    name:    hasRealName   ? row.name   : `${row.address.slice(0, 6)}...${row.address.slice(-4)}`,
    launchSource: row.launchPlatform ?? "On-chain",
    launchPlatform: row.launchPlatform ?? null,
    dex:     row.dexName ?? "Unknown DEX",
    ageMinutes,
    lifecycle: ageHours < 2 ? "hot" : ageHours < 24 ? "warm" : "cold",
    priceUsd,
    priceChange5m,
    priceChange1h,
    priceChange24h,
    marketCapUsd,
    fdvUsd:       0,
    liquidityUsd: Number(row.liquidityUsd) || 0,
    volume5mUsd:  volume24hUsd / 288,
    volume1hUsd:  volume24hUsd / 24,
    volume24hUsd,
    buys:          Number(row.buys24h),
    sells:         Number(row.sells24h),
    uniqueBuyers:  Math.max(1, Math.round(swaps * 0.65)),
    uniqueSellers: Math.max(1, Math.round(swaps * 0.35)),
    holders:            0,
    newHolders24h:      0,
    smartWalletBuys:    0,
    devWalletActivity:  "unknown",
    topHolderConcentration: 0,
    riskScore,
    riskLevel,
    trendingScore: Math.max(20, Math.min(98, Math.round(Math.log10(volume24hUsd + 10) * 18 + swaps * 0.1))),
    lastActivityAt: updatedAt.toISOString(),
  };
}
