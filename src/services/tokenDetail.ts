import type { ChainKey } from "../config/chains.js";
import { getDb } from "../db/postgres.js";

// Average block times per chain — mirrors aggregateMarket.ts
const BLOCK_TIME_MS: Partial<Record<ChainKey, number>> = {
  base: 2_000,
  eth:  12_000,
  bsc:  3_000,
};

// Stablecoins are always worth ~$1 — their price never appears in token_market_stats
// because that table tracks the *base* token, not the quote.
const STABLECOIN_ADDRESSES = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC Base
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC Base
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI Base
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC Ethereum
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT Ethereum
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI Ethereum
  "0x55d398326f99059ff775485246999027b3197955", // USDT BSC
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC BSC
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD BSC
]);

function stablePrice(address: string | null, fallback: number): number {
  if (address && STABLECOIN_ADDRESSES.has(address.toLowerCase())) return 1.0;
  return fallback;
}

export type TokenDetail = {
  chain: ChainKey;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: string | null;
  marketCapUsd: number;
  priceUsd: number;
  priceChange24h: number;
  volume24hUsd: number;
  liquidityUsd: number;
  swaps24h: number;
  buys24h: number;
  sells24h: number;
  lastActivityAt: string;
  // Enriched fields
  launchPlatform: string | null;
  launchSource: string;
  dex: string;
  riskScore: number;
  riskLevel: "Low" | "Medium" | "High" | "Extreme";
  lifecycle: "hot" | "warm" | "cold";
  ageMinutes: number;
};

export type TokenSwap = {
  chain: ChainKey;
  dexName: string;
  protocolVersion: string;
  poolAddress: string | null;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  token0PriceUsd: number;
  token1PriceUsd: number;
  amount0Raw: string;
  amount1Raw: string;
  sender: string | null;
  txHash: string;
  blockNumber: number;
  observedAt: string;
};

export async function getTokenDetail(chain: ChainKey, address: string): Promise<TokenDetail | null> {
  const sql = getDb();

  // Fetch current ingested block for this chain so we can estimate pool age from
  // block_number when block_timestamp hasn't been backfilled yet.
  const cursorRows = await sql`
    SELECT MAX(last_block::bigint) AS last_block
    FROM indexer_cursors
    WHERE chain_key = ${chain} AND worker_name = 'swap-ingestion'
  `;
  const currentBlock = Number(cursorRows[0]?.last_block ?? 0);
  const blockTimeMs = BLOCK_TIME_MS[chain] ?? 6_000;
  const now = Date.now();

  const rows = await sql`
    SELECT
      chains."key"                          AS chain,
      tms.token_address                     AS address,
      COALESCE(t.symbol, 'UNKNOWN')         AS symbol,
      COALESCE(t.name, 'Unknown Token')     AS name,
      COALESCE(t.decimals, 18)              AS decimals,
      t.total_supply                        AS "totalSupply",
      t.launch_platform                     AS "launchPlatform",
      tms.price_usd                         AS "priceUsd",
      tms.price_change_24h_pct              AS "priceChange24h",
      tms.volume_24h_usd                    AS "volume24hUsd",
      tms.liquidity_usd                     AS "liquidityUsd",
      tms.swaps_24h                         AS "swaps24h",
      tms.buys_24h                          AS "buys24h",
      tms.sells_24h                         AS "sells24h",
      tms.updated_at                        AS "lastActivityAt",
      (
        SELECT d.name FROM pools p
        JOIN dexes d ON d.id = p.dex_id
        WHERE p.chain_id = tms.chain_id
          AND (p.token0_address = tms.token_address OR p.token1_address = tms.token_address)
        ORDER BY p.created_at DESC LIMIT 1
      ) AS "dexName",
      (
        SELECT MIN(p2.block_timestamp) FROM pools p2
        WHERE p2.chain_id = tms.chain_id
          AND (p2.token0_address = tms.token_address OR p2.token1_address = tms.token_address)
      ) AS "poolCreatedAt",
      (
        SELECT MIN(p2.block_number) FROM pools p2
        WHERE p2.chain_id = tms.chain_id
          AND (p2.token0_address = tms.token_address OR p2.token1_address = tms.token_address)
      ) AS "poolBlockNumber"
    FROM token_market_stats tms
    JOIN chains ON chains.id = tms.chain_id
    LEFT JOIN tokens t ON t.chain_id = tms.chain_id AND t.address = tms.token_address
    WHERE chains."key" = ${chain}
      AND tms.token_address = ${address.toLowerCase()}
  `;

  if (!rows[0]) return null;
  const row = rows[0];
  const priceUsd    = Number(row.priceUsd);
  const decimals    = Number(row.decimals);
  const volume24h   = Number(row.volume24hUsd);
  const liquidityUsd = Number(row.liquidityUsd) || 0;

  let marketCapUsd = 0;
  if (row.totalSupply && priceUsd > 0) {
    try {
      marketCapUsd = (Number(BigInt(row.totalSupply as string)) / 10 ** decimals) * priceUsd;
    } catch {
      marketCapUsd = 0;
    }
  }

  // Compute age from pool creation time, with fallback to block-number estimation.
  // block_timestamp is NULL for pools discovered before the feature was added;
  // in that case we estimate from block_number + cursor block (immediate, no backfill needed).
  const updatedAt = row.lastActivityAt instanceof Date ? row.lastActivityAt : new Date(String(row.lastActivityAt));
  const poolCreatedAt = row.poolCreatedAt
    ? (row.poolCreatedAt instanceof Date ? row.poolCreatedAt : new Date(String(row.poolCreatedAt)))
    : null;
  const poolBlockNumber = row.poolBlockNumber ? Number(row.poolBlockNumber) : null;

  let ageMinutes: number;
  if (poolCreatedAt) {
    ageMinutes = Math.max(1, Math.round((now - poolCreatedAt.getTime()) / 60_000));
  } else if (poolBlockNumber && currentBlock > 0) {
    const blocksAgo = Math.max(0, currentBlock - poolBlockNumber);
    ageMinutes = Math.max(1, Math.round((blocksAgo * blockTimeMs) / 60_000));
  } else {
    ageMinutes = Math.max(1, Math.round((now - updatedAt.getTime()) / 60_000));
  }
  const ageHours = ageMinutes / 60;

  // Risk scoring (matches market service logic)
  const isNew    = ageHours < 24;
  const highVol  = volume24h > 50_000;
  const riskScore = isNew && !highVol ? 65 : highVol ? 35 : 50;
  const riskLevel = riskScore < 40 ? "Low" : riskScore < 60 ? "Medium" : "High";

  const launchPlatform = (row.launchPlatform as string | null) ?? null;

  return {
    chain: row.chain as ChainKey,
    address: row.address as string,
    symbol: row.symbol as string,
    name: row.name as string,
    decimals,
    totalSupply: (row.totalSupply as string | null) ?? null,
    marketCapUsd,
    priceUsd,
    priceChange24h: Number(row.priceChange24h),
    volume24hUsd: volume24h,
    liquidityUsd,
    swaps24h: Number(row.swaps24h),
    buys24h: Number(row.buys24h),
    sells24h: Number(row.sells24h),
    lastActivityAt: updatedAt.toISOString(),
    launchPlatform,
    launchSource: launchPlatform ?? "On-chain",
    dex: (row.dexName as string | null) ?? "Unknown DEX",
    riskScore,
    riskLevel: riskLevel as "Low" | "Medium" | "High" | "Extreme",
    lifecycle: ageHours < 2 ? "hot" : ageHours < 24 ? "warm" : "cold",
    ageMinutes,
  };
}

export async function getTokenSwapHistory(chain: ChainKey, address: string, limit = 100): Promise<TokenSwap[]> {
  const sql = getDb();
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const addr = address.toLowerCase();

  // Fetch the latest ingested block for this chain so we can compute real swap times
  // from block numbers.  The DB stores observed_at = insertion time (wrong for backfilled
  // swaps), but block_number is always accurate.
  const cursorRows = await sql`
    SELECT MAX(last_block::bigint) AS last_block
    FROM indexer_cursors
    WHERE chain_key = ${chain} AND worker_name = 'swap-ingestion'
  `;
  const currentBlock = Number(cursorRows[0]?.last_block ?? 0);
  const blockTimeMs = BLOCK_TIME_MS[chain] ?? 6_000;
  const now = Date.now();

  const rows = await sql`
    SELECT
      chains."key"                                          AS chain,
      dexes.name                                            AS "dexName",
      swaps.protocol_version                                AS "protocolVersion",
      swaps.pool_address                                    AS "poolAddress",
      pools.token0_address                                  AS token0,
      pools.token1_address                                  AS token1,
      COALESCE(t0.symbol, 'UNKNOWN')                        AS "token0Symbol",
      COALESCE(t0.decimals, 18)                             AS "token0Decimals",
      COALESCE(t1.symbol, 'UNKNOWN')                        AS "token1Symbol",
      COALESCE(t1.decimals, 18)                             AS "token1Decimals",
      COALESCE(CAST(m0.price_usd AS NUMERIC(36,18)), 0)    AS "token0PriceUsd",
      COALESCE(CAST(m1.price_usd AS NUMERIC(36,18)), 0)    AS "token1PriceUsd",
      swaps.amount0_raw                                     AS "amount0Raw",
      swaps.amount1_raw                                     AS "amount1Raw",
      swaps.sender_address                                  AS sender,
      swaps.tx_hash                                         AS "txHash",
      swaps.block_number                                    AS "blockNumber",
      swaps.observed_at                                     AS "observedAt"
    FROM swaps
    JOIN chains ON chains.id = swaps.chain_id
    JOIN dexes ON dexes.id = swaps.dex_id
    LEFT JOIN pools ON pools.id = swaps.pool_id
    LEFT JOIN tokens t0 ON t0.chain_id = swaps.chain_id AND t0.address = pools.token0_address
    LEFT JOIN tokens t1 ON t1.chain_id = swaps.chain_id AND t1.address = pools.token1_address
    LEFT JOIN token_market_stats m0 ON m0.chain_id = swaps.chain_id AND m0.token_address = pools.token0_address
    LEFT JOIN token_market_stats m1 ON m1.chain_id = swaps.chain_id AND m1.token_address = pools.token1_address
    WHERE chains."key" = ${chain}
      AND (pools.token0_address = ${addr} OR pools.token1_address = ${addr})
    ORDER BY swaps.block_number DESC, swaps.id DESC
    LIMIT ${safeLimit}
  `;

  return rows.map((row) => ({
    chain: row.chain as ChainKey,
    dexName: row.dexName as string,
    protocolVersion: row.protocolVersion as string,
    poolAddress: (row.poolAddress as string | null) ?? null,
    token0: row.token0 as string,
    token1: row.token1 as string,
    token0Symbol: row.token0Symbol as string,
    token0Decimals: Number(row.token0Decimals),
    token1Symbol: row.token1Symbol as string,
    token1Decimals: Number(row.token1Decimals),
    token0PriceUsd: stablePrice(row.token0 as string, Number(row.token0PriceUsd)),
    token1PriceUsd: stablePrice(row.token1 as string, Number(row.token1PriceUsd)),
    amount0Raw: row.amount0Raw as string,
    amount1Raw: row.amount1Raw as string,
    sender: (row.sender as string | null) ?? null,
    txHash: row.txHash as string,
    blockNumber: Number(row.blockNumber),
    // Estimate real-world time from block number so backfilled swaps show the correct
    // age ("7h ago") instead of the DB insertion time ("55m ago").
    observedAt: (() => {
      const swapBlock = Number(row.blockNumber);
      if (currentBlock > 0 && swapBlock > 0) {
        const blocksAgo = Math.max(0, currentBlock - swapBlock);
        return new Date(now - blocksAgo * blockTimeMs).toISOString();
      }
      return row.observedAt instanceof Date ? row.observedAt.toISOString() : String(row.observedAt);
    })(),
  }));
}
