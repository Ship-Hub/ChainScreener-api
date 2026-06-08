import { chains, type ChainKey } from "../config/chains.js";
import { closeDb, getDb } from "../db/postgres.js";
import { runMigration } from "../db/migrate.js";
import { type QuoteAsset, stablecoins, wrappedNatives, getQuoteAsset } from "./quoteAssets.js";

type SwapRow = {
  id: string | number;
  chainId: number | string;
  chainKey: ChainKey;
  token0: string | null;
  token1: string | null;
  amount0Raw: string;
  amount1Raw: string;
  protocolVersion: string;
  blockNumber: number | string;
  txHash: string;
  observedAt: Date | string;
};

type PricedSwapBase = {
  chainId: number;
  chainKey: ChainKey;
  tokenAddress: string;
  quoteAddress: string;
  priceUsd: number;
  volumeUsd: number;
  isBuy: boolean;
  blockNumber: number;
  txHash: string;
  observedAt: Date;
  swapId: number | null;
};

// PricedSwap adds estimatedAt, which is derived from block numbers after pricing.
// estimatedAt is used for candle bucketing so historical swaps land in the right time bucket
// even when observedAt is the DB insertion time (which collapses to a single bucket on backfill).
type PricedSwap = PricedSwapBase & { estimatedAt: Date };

// Average block times in ms per chain — used to estimate block timestamps from block numbers.
const BLOCK_TIME_MS: Partial<Record<ChainKey, number>> = {
  base: 2_000,
  eth:  12_000,
  bsc:  3_000,
};

// ─── External price feed (Binance public API, no key required) ─────────────────
// Used as a fallback when we can't derive WETH/BNB price from our own pool index
// (e.g. major WETH/USDC pools were created before our discovery window).

interface ExternalPriceCache {
  prices: Map<string, number>;
  fetchedAt: number;
}
let _externalPricesCache: ExternalPriceCache | null = null;
const EXTERNAL_PRICE_TTL_MS = 60_000; // refresh once per minute

async function fetchExternalNativePrices(): Promise<Map<string, number>> {
  const now = Date.now();
  if (_externalPricesCache && now - _externalPricesCache.fetchedAt < EXTERNAL_PRICE_TTL_MS) {
    return _externalPricesCache.prices;
  }

  const prices = new Map<string, number>();
  try {
    // CoinGecko free API — no key needed, single call for ETH + BNB
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin&vs_currencies=usd",
      { signal: AbortSignal.timeout(8_000) },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        ethereum?: { usd: number };
        binancecoin?: { usd: number };
      };

      const ethPrice = data.ethereum?.usd ?? 0;
      if (ethPrice > 0) {
        const wethBase = WRAPPED_NATIVE_BY_CHAIN["base"]!;
        const wethEth  = WRAPPED_NATIVE_BY_CHAIN["eth"]!;
        prices.set(`base:${wethBase}`, ethPrice);
        prices.set(`base:${NATIVE_ETH}`, ethPrice);
        prices.set(`eth:${wethEth}`, ethPrice);
        prices.set(`eth:${NATIVE_ETH}`, ethPrice);
        console.log(`[aggregateMarket] External ETH price: $${ethPrice.toFixed(2)}`);
      }

      const bnbPrice = data.binancecoin?.usd ?? 0;
      if (bnbPrice > 0) {
        const wbnb = WRAPPED_NATIVE_BY_CHAIN["bsc"]!;
        prices.set(`bsc:${wbnb}`, bnbPrice);
        prices.set(`bsc:${NATIVE_ETH}`, bnbPrice);
      }
    }
  } catch (err) {
    console.warn(
      "[aggregateMarket] External price fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  _externalPricesCache = { prices, fetchedAt: now };
  return prices;
}

// Native ETH address (used by Uniswap V4 instead of WETH ERC-20)
const NATIVE_ETH = "0x0000000000000000000000000000000000000000";

// WETH / WBNB addresses per chain
const WRAPPED_NATIVE_BY_CHAIN: Partial<Record<ChainKey, string>> = {
  base: "0x4200000000000000000000000000000000000006",
  eth:  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  bsc:  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
};

// Shared SQL for swap rows — includes protocol_version to fix isBuy direction
const SWAP_SQL_COLS = `
  swaps.id,
  swaps.chain_id     AS "chainId",
  chains."key"       AS "chainKey",
  pools.token0_address AS token0,
  pools.token1_address AS token1,
  swaps.amount0_raw  AS "amount0Raw",
  swaps.amount1_raw  AS "amount1Raw",
  swaps.protocol_version AS "protocolVersion",
  swaps.block_number AS "blockNumber",
  swaps.tx_hash      AS "txHash",
  swaps.observed_at  AS "observedAt"
`;

const SWAP_SQL_JOINS = `
  FROM swaps
  JOIN chains ON chains.id = swaps.chain_id
  LEFT JOIN pools ON pools.id = swaps.pool_id
  WHERE pools.token0_address IS NOT NULL
    AND pools.token1_address IS NOT NULL
`;

function priceRows(
  rows: SwapRow[],
  nativePriceOverrides?: Map<string, number>,
  externalFallback?: Map<string, number>,
): {
  priced: PricedSwapBase[];
  derivedNativePrices: Map<string, number>;
} {
  const stablePriced = rows.map((r) => priceSwapWith(r, stablecoins)).filter((s): s is PricedSwapBase => Boolean(s));
  const derivedNativePrices = nativePriceOverrides ?? deriveWrappedNativePrices(stablePriced);

  // Fill any missing chain native prices from the external fallback (Binance API).
  // On-chain derivation takes precedence; external price only fills gaps.
  if (externalFallback) {
    for (const [key, price] of externalFallback) {
      if (!derivedNativePrices.has(key)) {
        derivedNativePrices.set(key, price);
      }
    }
  }

  const stableKeys = new Set(stablePriced.map((s) => `${s.chainKey}:${s.tokenAddress}`));
  const effectiveNatives = wrappedNatives
    .map((wn) => ({ ...wn, usdPrice: derivedNativePrices.get(`${wn.chain}:${wn.address.toLowerCase()}`) ?? 0 }))
    .filter((wn) => wn.usdPrice > 0);
  const nativePriced: PricedSwapBase[] = effectiveNatives.length > 0
    ? rows
        .map((r) => priceSwapWith(r, effectiveNatives))
        .filter((s): s is PricedSwapBase => s !== undefined && !stableKeys.has(`${s.chainKey}:${s.tokenAddress}`))
    : [];
  return { priced: [...stablePriced, ...nativePriced], derivedNativePrices };
}

/**
 * Query the latest processed block per chain from the swap-ingestion cursor.
 * Used to anchor swap timestamps to real wall-clock time, not DB insertion time.
 * Falls back to an empty map (which triggers a per-batch fallback below).
 */
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

/**
 * Estimate real-world timestamps for each swap using block-number arithmetic.
 *
 * The old approach used `observedAt` (DB insertion time) of the latest swap as anchor.
 * This was wrong for backfilled swaps: a swap indexed today that happened 7h ago would
 * show `observedAt = now` and all estimated times would be compressed to the last few
 * minutes.
 *
 * The fix: anchor to `Date.now()` + the current chain head from the swap-ingestion cursor.
 * estimatedAt = now − (currentBlock − swapBlock) × blockTimeMs
 * This is accurate for any swap regardless of when it was inserted into the DB.
 */
function addEstimatedTimes(base: PricedSwapBase[], currentBlocks: Map<ChainKey, number>): PricedSwap[] {
  const now = Date.now();

  // Fallback per chain: if cursor not in DB yet, use the max block from this batch
  const batchMaxBlock = new Map<ChainKey, number>();
  for (const s of base) {
    const cur = batchMaxBlock.get(s.chainKey) ?? 0;
    if (s.blockNumber > cur) batchMaxBlock.set(s.chainKey, s.blockNumber);
  }

  return base.map((s) => {
    const currentBlock = currentBlocks.get(s.chainKey) ?? batchMaxBlock.get(s.chainKey) ?? s.blockNumber;
    const blockTimeMs = BLOCK_TIME_MS[s.chainKey] ?? 6_000;
    const blocksAgo = Math.max(0, currentBlock - s.blockNumber);
    return { ...s, estimatedAt: new Date(now - blocksAgo * blockTimeMs) };
  });
}

// ─── Candle-agg cursor ────────────────────────────────────────────────────────
const CANDLE_AGG_CURSOR = { chain_key: "_", dex_key: "_", worker_name: "candle-agg" };

async function getCandleAggCursor(): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    SELECT last_block FROM indexer_cursors
    WHERE chain_key = ${CANDLE_AGG_CURSOR.chain_key}
      AND dex_key   = ${CANDLE_AGG_CURSOR.dex_key}
      AND worker_name = ${CANDLE_AGG_CURSOR.worker_name}
  `;
  return Number(rows[0]?.last_block ?? 0);
}

async function setCandleAggCursor(maxSwapId: number): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO indexer_cursors (chain_key, dex_key, worker_name, last_block)
    VALUES (${CANDLE_AGG_CURSOR.chain_key}, ${CANDLE_AGG_CURSOR.dex_key}, ${CANDLE_AGG_CURSOR.worker_name}, ${maxSwapId})
    ON CONFLICT (chain_key, dex_key, worker_name)
    DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = NOW()
  `;
}

// ─── Candle aggregation (plain SQL, no TimescaleDB) ───────────────────────────

/**
 * Rebuild 5m and 1h candles for all tokens that had new swap_prices inserted.
 * Uses a window-function approach to get correct OHLCV without TimescaleDB.
 */
async function rebuildCandlesForTokens(tokenKeys: Array<{ chainId: number; tokenAddress: string }>): Promise<void> {
  if (tokenKeys.length === 0) return;
  const sql = getDb();

  for (const { chainId, tokenAddress } of tokenKeys) {
    // ── 5-minute candles ───────────────────────────────────────────────────
    await sql.unsafe(`
      INSERT INTO token_candles_5m
        (bucket, chain_id, chain_key, token_address, quote_address,
         open_usd, high_usd, low_usd, close_usd, volume_usd, swap_count)
      WITH bucketed AS (
        SELECT
          date_trunc('hour', occurred_at)
            + (EXTRACT(MINUTE FROM occurred_at)::int / 5 * 5) * INTERVAL '1 minute' AS bucket,
          chain_id,
          MAX(chain_key) OVER (PARTITION BY chain_id, token_address) AS chain_key,
          token_address,
          MAX(quote_address) OVER (PARTITION BY chain_id, token_address) AS quote_address,
          price_usd,
          volume_usd,
          occurred_at,
          ROW_NUMBER() OVER (
            PARTITION BY chain_id, token_address,
              date_trunc('hour', occurred_at)
                + (EXTRACT(MINUTE FROM occurred_at)::int / 5 * 5) * INTERVAL '1 minute'
            ORDER BY occurred_at ASC
          ) AS rn_asc,
          ROW_NUMBER() OVER (
            PARTITION BY chain_id, token_address,
              date_trunc('hour', occurred_at)
                + (EXTRACT(MINUTE FROM occurred_at)::int / 5 * 5) * INTERVAL '1 minute'
            ORDER BY occurred_at DESC
          ) AS rn_desc
        FROM swap_prices
        WHERE chain_id = $1
          AND token_address = $2
      )
      SELECT
        bucket,
        chain_id,
        MAX(chain_key)    AS chain_key,
        token_address,
        MAX(quote_address) AS quote_address,
        MAX(price_usd) FILTER (WHERE rn_asc  = 1) AS open_usd,
        MAX(price_usd)                             AS high_usd,
        MIN(price_usd)                             AS low_usd,
        MAX(price_usd) FILTER (WHERE rn_desc = 1) AS close_usd,
        SUM(volume_usd)                            AS volume_usd,
        COUNT(*)::int                              AS swap_count
      FROM bucketed
      GROUP BY bucket, chain_id, token_address
      ON CONFLICT (chain_id, token_address, bucket) DO UPDATE SET
        open_usd   = EXCLUDED.open_usd,
        high_usd   = EXCLUDED.high_usd,
        low_usd    = EXCLUDED.low_usd,
        close_usd  = EXCLUDED.close_usd,
        volume_usd = EXCLUDED.volume_usd,
        swap_count = EXCLUDED.swap_count
    `, [chainId, tokenAddress]);

    // ── 1-hour candles ─────────────────────────────────────────────────────
    await sql.unsafe(`
      INSERT INTO token_candles_1h
        (bucket, chain_id, chain_key, token_address, quote_address,
         open_usd, high_usd, low_usd, close_usd, volume_usd, swap_count)
      WITH bucketed AS (
        SELECT
          date_trunc('hour', bucket) AS hour_bucket,
          chain_id,
          chain_key,
          token_address,
          quote_address,
          open_usd,
          high_usd,
          low_usd,
          close_usd,
          volume_usd,
          swap_count,
          ROW_NUMBER() OVER (
            PARTITION BY chain_id, token_address, date_trunc('hour', bucket)
            ORDER BY bucket ASC
          ) AS rn_asc,
          ROW_NUMBER() OVER (
            PARTITION BY chain_id, token_address, date_trunc('hour', bucket)
            ORDER BY bucket DESC
          ) AS rn_desc
        FROM token_candles_5m
        WHERE chain_id = $1
          AND token_address = $2
      )
      SELECT
        hour_bucket                                AS bucket,
        chain_id,
        MAX(chain_key)    AS chain_key,
        token_address,
        MAX(quote_address) AS quote_address,
        MAX(open_usd)  FILTER (WHERE rn_asc  = 1) AS open_usd,
        MAX(high_usd)                              AS high_usd,
        MIN(low_usd)                               AS low_usd,
        MAX(close_usd) FILTER (WHERE rn_desc = 1) AS close_usd,
        SUM(volume_usd)                            AS volume_usd,
        SUM(swap_count)::int                       AS swap_count
      FROM bucketed
      GROUP BY hour_bucket, chain_id, token_address
      ON CONFLICT (chain_id, token_address, bucket) DO UPDATE SET
        open_usd   = EXCLUDED.open_usd,
        high_usd   = EXCLUDED.high_usd,
        low_usd    = EXCLUDED.low_usd,
        close_usd  = EXCLUDED.close_usd,
        volume_usd = EXCLUDED.volume_usd,
        swap_count = EXCLUDED.swap_count
    `, [chainId, tokenAddress]);
  }
}

export async function aggregateMarketOnce() {
  await runMigration();
  const sql = getDb();

  // Fetch external ETH/BNB prices as fallback (cached for 60s).
  // This handles the common case where WETH/USDC anchor pools are older than
  // our discovery window and not in our local swap index.
  const externalPrices = await fetchExternalNativePrices();

  // Fetch current ingested block per chain — used by addEstimatedTimes so swap
  // timestamps are anchored to real wall-clock time rather than DB insertion time.
  const currentBlocks = await getCurrentBlocksByChain();

  // ── Step A: market stats from the most recent 10 000 swaps ───────────────
  const recentRows = await sql.unsafe<SwapRow[]>(
    `SELECT ${SWAP_SQL_COLS} ${SWAP_SQL_JOINS} ORDER BY swaps.block_number DESC, swaps.id DESC LIMIT 10000`,
  );

  const { priced: recentPriced, derivedNativePrices } = priceRows(recentRows, undefined, externalPrices);
  const recentGrouped = groupByToken(addEstimatedTimes(recentPriced, currentBlocks));
  for (const group of recentGrouped.values()) {
    await upsertMarketStats(group);
  }

  // ── Store native asset prices in token_market_stats ───────────────────────
  // WETH / WBNB / native ETH are quote assets — they never appear as the
  // "base" token in our pricing, so they never get upserted by upsertMarketStats.
  // Store them explicitly so the swap-history and wallet APIs can look up
  // WETH → USD conversion without a separate RPC call.
  await upsertNativeAssetPrices(derivedNativePrices);

  // ── Step B: incremental swap_prices insert ────────────────────────────────
  const lastSwapId = await getCandleAggCursor();

  const candleRows: SwapRow[] = lastSwapId === 0
    ? await sql.unsafe<SwapRow[]>(
        `SELECT ${SWAP_SQL_COLS} ${SWAP_SQL_JOINS} ORDER BY swaps.block_number ASC, swaps.id ASC`,
      )
    : await sql.unsafe<SwapRow[]>(
        `SELECT ${SWAP_SQL_COLS} ${SWAP_SQL_JOINS} AND swaps.id > ${lastSwapId} ORDER BY swaps.block_number ASC, swaps.id ASC`,
      );

  let newCandleSwaps = 0;
  const affectedTokens = new Map<string, { chainId: number; tokenAddress: string }>();

  if (candleRows.length > 0) {
    // derivedNativePrices already has external fallback merged in (from Step A)
    const { priced: candlePricedBase } = priceRows(candleRows, derivedNativePrices);
    const allPricedWithTime = addEstimatedTimes(candlePricedBase, currentBlocks);

    // Batch insert into swap_prices
    const rows = allPricedWithTime.map((s) => ({
      occurred_at:   s.estimatedAt.toISOString(),
      chain_id:      s.chainId,
      chain_key:     s.chainKey,
      token_address: s.tokenAddress,
      quote_address: s.quoteAddress,
      price_usd:     decimal(s.priceUsd, 18),
      volume_usd:    decimal(s.volumeUsd, 6),
      is_buy:        s.isBuy,
      block_number:  s.blockNumber,
      swap_id:       s.swapId,
    }));

    if (rows.length > 0) {
      // postgres.js is limited to 65534 parameters; each row has 10 columns → max 6553 rows/batch
      const BATCH_SIZE = 6_000;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        await sql`INSERT INTO swap_prices ${sql(chunk)} ON CONFLICT DO NOTHING`;
      }
      newCandleSwaps = rows.length;

      // Track which tokens need candle rebuild
      for (const s of allPricedWithTime) {
        const key = `${s.chainId}:${s.tokenAddress}`;
        affectedTokens.set(key, { chainId: s.chainId, tokenAddress: s.tokenAddress });
      }
    }

    // Advance cursor to highest swap id processed
    let maxId = 0;
    for (const r of candleRows) {
      const id = Number(r.id);
      if (id > maxId) maxId = id;
    }
    await setCandleAggCursor(maxId);
  }

  // ── Step C: rebuild candles for affected tokens ───────────────────────────
  if (affectedTokens.size > 0) {
    await rebuildCandlesForTokens([...affectedTokens.values()]);
  }

  return {
    indexedSwaps:       recentRows.length,
    pricedSwaps:        recentPriced.length,
    tokens:             recentGrouped.size,
    derivedNativePrices: Object.fromEntries(derivedNativePrices),
    newCandleSwaps,
  };
}

function priceSwapWith(row: SwapRow, assets: QuoteAsset[]): PricedSwapBase | undefined {
  if (!row.token0 || !row.token1) return undefined;

  const chainKey = row.chainKey;
  const token0Quote = getQuoteAsset(chainKey, row.token0, assets);
  const token1Quote = getQuoteAsset(chainKey, row.token1, assets);
  if (!token0Quote && !token1Quote) return undefined;
  if (token0Quote && token1Quote) return undefined;

  const quote = token0Quote ?? token1Quote;
  if (!quote || quote.usdPrice <= 0) return undefined;

  const quoteIsToken0 = Boolean(token0Quote);
  const tokenAddress  = quoteIsToken0 ? row.token1 : row.token0;
  const quoteRaw      = quoteIsToken0 ? row.amount0Raw : row.amount1Raw;
  const tokenRaw      = quoteIsToken0 ? row.amount1Raw : row.amount0Raw;
  const quoteAmount   = normalizeAmount(absBigInt(quoteRaw), quote.decimals);
  const tokenAmount   = normalizeAmount(absBigInt(tokenRaw), 18); // assumes 18 decimals for unknown tokens
  if (quoteAmount <= 0 || tokenAmount <= 0) return undefined;

  const observedAt = row.observedAt instanceof Date ? row.observedAt : new Date(row.observedAt as string);

  // ── isBuy direction ────────────────────────────────────────────────────────
  // V2 (Uniswap V2 / Aerodrome): amounts are (amountOut - amountIn).
  //   Negative quote amount → quote flowed INTO pool → user is buying the base token.
  // V3 / V4: amounts are signed pool-delta (positive = into pool, negative = out of pool).
  //   Positive quote amount → quote flowed INTO pool → user is buying the base token.
  const isV3orV4 = row.protocolVersion === "v3" || row.protocolVersion === "v4";
  const quoteRawBig = BigInt(quoteRaw);
  const isBuy = isV3orV4
    ? (quoteIsToken0 ? quoteRawBig > 0n : quoteRawBig < 0n)   // V3/V4: positive = into pool
    : (quoteIsToken0 ? quoteRawBig < 0n : quoteRawBig > 0n);  // V2: negative = into pool (out - in)

  const priceUsd  = (quoteAmount * quote.usdPrice) / tokenAmount;
  const volumeUsd = quoteAmount * quote.usdPrice;

  // Reject absurd prices that would overflow the DB column or indicate bad data
  // (e.g. dust swaps with near-zero token amounts inflating the price)
  if (!Number.isFinite(priceUsd) || priceUsd <= MIN_SAFE_PRICE_USD || priceUsd > MAX_SAFE_PRICE_USD) {
    return undefined;
  }

  return {
    chainId:      Number(row.chainId),
    chainKey,
    tokenAddress: tokenAddress.toLowerCase(),
    quoteAddress: quote.address.toLowerCase(),
    priceUsd,
    volumeUsd,
    isBuy,
    blockNumber:  Number(row.blockNumber),
    txHash:       row.txHash,
    observedAt,
    swapId:       Number(row.id) || null,
  };
}

function deriveWrappedNativePrices(stablePriced: PricedSwapBase[]): Map<string, number> {
  const prices = new Map<string, number>();
  for (const wn of wrappedNatives) {
    // Skip native ETH entries — their price is inherited from WETH below
    if (wn.address === NATIVE_ETH) continue;

    const wnAddress = wn.address.toLowerCase();
    const wnSwaps = stablePriced.filter((s) => s.chainKey === wn.chain && s.tokenAddress === wnAddress);
    if (wnSwaps.length === 0) continue;
    const sorted = [...wnSwaps].sort((a, b) => a.priceUsd - b.priceUsd);
    const mid = Math.floor(sorted.length / 2);
    const medianPrice =
      sorted.length % 2 === 0
        ? ((sorted[mid - 1]?.priceUsd ?? 0) + (sorted[mid]?.priceUsd ?? 0)) / 2
        : (sorted[mid]?.priceUsd ?? 0);
    if (medianPrice > 0) prices.set(`${wn.chain}:${wnAddress}`, medianPrice);
  }

  // Propagate WETH / WBNB prices to native ETH (0x000…000) — same asset in V4
  for (const [chain, wrappedAddr] of Object.entries(WRAPPED_NATIVE_BY_CHAIN)) {
    const wethPrice = prices.get(`${chain}:${wrappedAddr}`);
    if (wethPrice) {
      prices.set(`${chain}:${NATIVE_ETH}`, wethPrice);
    }
  }

  return prices;
}

function groupByToken(swaps: PricedSwap[]) {
  const groups = new Map<string, PricedSwap[]>();
  for (const swap of swaps) {
    const key = `${swap.chainKey}:${swap.tokenAddress}`;
    groups.set(key, [...(groups.get(key) ?? []), swap]);
  }
  return groups;
}

async function upsertMarketStats(swaps: PricedSwap[]) {
  const sql = getDb();
  const newest = [...swaps].sort((a, b) => b.blockNumber - a.blockNumber)[0];
  if (!newest) return;
  // Skip if the current price is clearly bad (overflow / not finite)
  if (!Number.isFinite(newest.priceUsd) || newest.priceUsd <= 0 || newest.priceUsd > MAX_SAFE_PRICE_USD) return;

  // Use only swaps within the last 24 hours for time-bounded stats
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent24h = swaps.filter((s) => s.estimatedAt.getTime() >= cutoff);
  const statsSwaps = recent24h.length > 0 ? recent24h : swaps;

  // Price change: oldest vs newest within the window
  const sorted = [...statsSwaps].sort((a, b) => a.blockNumber - b.blockNumber);
  const oldest = sorted[0];
  const volumeUsd  = statsSwaps.reduce((sum, s) => sum + s.volumeUsd, 0);
  const buys       = statsSwaps.filter((s) => s.isBuy).length;
  const sells      = statsSwaps.length - buys;
  const priceChange = oldest && oldest.priceUsd > 0
    ? ((newest.priceUsd - oldest.priceUsd) / oldest.priceUsd) * 100
    : 0;

  await sql`
    INSERT INTO token_market_stats (
      chain_id, token_address, quote_address, price_usd, price_change_24h_pct,
      volume_24h_usd, swaps_24h, buys_24h, sells_24h, last_swap_block, last_tx_hash
    )
    VALUES (
      ${newest.chainId},
      ${newest.tokenAddress},
      ${newest.quoteAddress},
      ${decimal(newest.priceUsd, 18)},
      ${decimal(priceChange, 8)},
      ${decimal(volumeUsd, 6)},
      ${statsSwaps.length},
      ${buys},
      ${sells},
      ${newest.blockNumber},
      ${newest.txHash}
    )
    ON CONFLICT (chain_id, token_address) DO UPDATE
      SET quote_address        = EXCLUDED.quote_address,
          price_usd            = EXCLUDED.price_usd,
          price_change_24h_pct = EXCLUDED.price_change_24h_pct,
          volume_24h_usd       = EXCLUDED.volume_24h_usd,
          swaps_24h            = EXCLUDED.swaps_24h,
          buys_24h             = EXCLUDED.buys_24h,
          sells_24h            = EXCLUDED.sells_24h,
          last_swap_block      = EXCLUDED.last_swap_block,
          last_tx_hash         = EXCLUDED.last_tx_hash,
          updated_at           = NOW()
  `;
}

/**
 * Store WETH / WBNB / native ETH prices in token_market_stats.
 * These quote assets never appear as the "base" token in our swap pricing,
 * so the swap-history API needs them explicitly for USD value calculations.
 */
async function upsertNativeAssetPrices(prices: Map<string, number>): Promise<void> {
  const sql = getDb();
  const chainRows = await sql`SELECT id, "key" FROM chains`;
  const chainIdByKey = new Map(chainRows.map((r) => [r.key as ChainKey, Number(r.id)]));

  // A placeholder USDC address — the "quote" for a native asset upsert is arbitrary
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

  for (const [chainKey, wrappedAddr] of Object.entries(WRAPPED_NATIVE_BY_CHAIN)) {
    const chainId = chainIdByKey.get(chainKey as ChainKey);
    if (!chainId) continue;
    const wethPrice = prices.get(`${chainKey}:${wrappedAddr}`);
    if (!wethPrice || wethPrice <= 0) continue;

    // Upsert WETH / WBNB price
    await sql`
      INSERT INTO token_market_stats (chain_id, token_address, quote_address, price_usd, volume_24h_usd, swaps_24h, buys_24h, sells_24h)
      VALUES (${chainId}, ${wrappedAddr}, ${USDC_BASE}, ${decimal(wethPrice, 18)}, 0, 0, 0, 0)
      ON CONFLICT (chain_id, token_address) DO UPDATE
        SET price_usd = EXCLUDED.price_usd, updated_at = NOW()
    `;

    // Also upsert native ETH (0x000…000) — same price
    await sql`
      INSERT INTO token_market_stats (chain_id, token_address, quote_address, price_usd, volume_24h_usd, swaps_24h, buys_24h, sells_24h)
      VALUES (${chainId}, ${NATIVE_ETH}, ${USDC_BASE}, ${decimal(wethPrice, 18)}, 0, 0, 0, 0)
      ON CONFLICT (chain_id, token_address) DO UPDATE
        SET price_usd = EXCLUDED.price_usd, updated_at = NOW()
    `;
  }
}

function absBigInt(value: string) {
  const bigint = BigInt(value);
  return bigint < 0n ? -bigint : bigint;
}

function normalizeAmount(value: bigint, decimals: number) {
  return Number(value) / 10 ** decimals;
}

// Max safe price for NUMERIC(36,18): integer part ≤ 10^18
const MAX_SAFE_PRICE_USD = 1e15; // $1 quadrillion — beyond any realistic asset
const MIN_SAFE_PRICE_USD = 1e-18;

function decimal(value: number, digits: number) {
  if (!Number.isFinite(value) || value > MAX_SAFE_PRICE_USD) return "0";
  return value.toFixed(digits);
}

// Wipe all swap_prices / candles / market stats and reset cursor — forces full rebuild.
export async function rebuildSwapPrices() {
  const sql = getDb();
  console.log("[rebuildSwapPrices] Truncating swap_prices, candles, market stats, resetting cursor…");
  await sql`DELETE FROM token_market_stats`;
  await sql`DELETE FROM token_candles_1h`;
  await sql`DELETE FROM token_candles_5m`;
  await sql`DELETE FROM swap_prices`;
  await setCandleAggCursor(0);
  console.log("[rebuildSwapPrices] Re-aggregating from full swap history…");
  const result = await aggregateMarketOnce();
  console.log(
    `[rebuildSwapPrices] Done — ${result.tokens} tokens, ${result.pricedSwaps} priced, ${result.newCandleSwaps} in swap_prices.`,
  );
  return result;
}

if (process.argv[1]?.endsWith("aggregateMarket.ts") || process.argv[1]?.endsWith("aggregateMarket.js")) {
  aggregateMarketOnce()
    .then(async (result) => {
      console.log(`Aggregated ${result.pricedSwaps}/${result.indexedSwaps} swaps → ${result.tokens} tokens.`);
      if (Object.keys(result.derivedNativePrices).length) {
        console.log("Derived native prices:", result.derivedNativePrices);
      }
      await closeDb();
    })
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exitCode = 1;
    });
}
