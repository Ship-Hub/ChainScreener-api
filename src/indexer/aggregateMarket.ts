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

// Shared SQL for swap rows
const SWAP_SQL_COLS = `
  swaps.id,
  swaps.chain_id     AS "chainId",
  chains."key"       AS "chainKey",
  pools.token0_address AS token0,
  pools.token1_address AS token1,
  swaps.amount0_raw  AS "amount0Raw",
  swaps.amount1_raw  AS "amount1Raw",
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

function priceRows(rows: SwapRow[], nativePriceOverrides?: Map<string, number>): {
  priced: PricedSwapBase[];
  derivedNativePrices: Map<string, number>;
} {
  const stablePriced = rows.map((r) => priceSwapWith(r, stablecoins)).filter((s): s is PricedSwapBase => Boolean(s));
  const derivedNativePrices = nativePriceOverrides ?? deriveWrappedNativePrices(stablePriced);
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

function addEstimatedTimes(base: PricedSwapBase[]): PricedSwap[] {
  const refByChain = new Map<ChainKey, { block: number; time: number }>();
  for (const s of base) {
    const cur = refByChain.get(s.chainKey);
    if (!cur || s.blockNumber > cur.block) {
      refByChain.set(s.chainKey, { block: s.blockNumber, time: s.observedAt.getTime() });
    }
  }
  return base.map((s) => {
    const ref = refByChain.get(s.chainKey);
    const maxBlock = ref?.block ?? s.blockNumber;
    const refTime = ref?.time ?? Date.now();
    const blockTimeMs = BLOCK_TIME_MS[s.chainKey] ?? 6_000;
    return { ...s, estimatedAt: new Date(refTime - (maxBlock - s.blockNumber) * blockTimeMs) };
  });
}

// ─── Candle-agg cursor ────────────────────────────────────────────────────────
// Tracks the max swap_id inserted into swap_prices.
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

export async function aggregateMarketOnce() {
  await runMigration();
  const sql = getDb();

  // ── Step A: market stats from the most recent 10 000 swaps ───────────────
  const recentRows = await sql.unsafe<SwapRow[]>(
    `SELECT ${SWAP_SQL_COLS} ${SWAP_SQL_JOINS} ORDER BY swaps.block_number DESC, swaps.id DESC LIMIT 10000`,
  );

  const { priced: recentPriced, derivedNativePrices } = priceRows(recentRows);
  const recentGrouped = groupByToken(addEstimatedTimes(recentPriced));
  for (const group of recentGrouped.values()) {
    await upsertMarketStats(group);
  }

  // ── Step B: incremental swap_prices insert ────────────────────────────────
  // Only process swaps not yet inserted into swap_prices.
  const lastSwapId = await getCandleAggCursor();

  const candleRows: SwapRow[] = lastSwapId === 0
    ? await sql.unsafe<SwapRow[]>(
        `SELECT ${SWAP_SQL_COLS} ${SWAP_SQL_JOINS} ORDER BY swaps.block_number ASC, swaps.id ASC`,
      )
    : await sql.unsafe<SwapRow[]>(
        `SELECT ${SWAP_SQL_COLS} ${SWAP_SQL_JOINS} AND swaps.id > ${lastSwapId} ORDER BY swaps.block_number ASC, swaps.id ASC`,
      );

  if (candleRows.length > 0) {
    const { priced: candlePricedBase } = priceRows(candleRows, derivedNativePrices);
    const allPricedWithTime = addEstimatedTimes(candlePricedBase);

    // Batch insert into swap_prices
    const rows = allPricedWithTime.map((s) => ({
      occurred_at: s.estimatedAt.toISOString(),
      chain_id: s.chainId,
      chain_key: s.chainKey,
      token_address: s.tokenAddress,
      quote_address: s.quoteAddress,
      price_usd: decimal(s.priceUsd, 18),
      volume_usd: decimal(s.volumeUsd, 6),
      is_buy: s.isBuy,
      block_number: s.blockNumber,
      swap_id: s.swapId,
    }));

    if (rows.length > 0) {
      await sql`INSERT INTO swap_prices ${sql(rows)} ON CONFLICT DO NOTHING`;
    }

    // Advance cursor to highest swap id processed
    let maxId = 0;
    for (const r of candleRows) {
      const id = Number(r.id);
      if (id > maxId) maxId = id;
    }
    await setCandleAggCursor(maxId);
  }

  return {
    indexedSwaps: recentRows.length,
    pricedSwaps: recentPriced.length,
    tokens: recentGrouped.size,
    derivedNativePrices: Object.fromEntries(derivedNativePrices),
    newCandleSwaps: candleRows.length,
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
  const tokenAddress = quoteIsToken0 ? row.token1 : row.token0;
  const quoteRaw = quoteIsToken0 ? row.amount0Raw : row.amount1Raw;
  const tokenRaw = quoteIsToken0 ? row.amount1Raw : row.amount0Raw;
  const quoteAmount = normalizeAmount(absBigInt(quoteRaw), quote.decimals);
  const tokenAmount = normalizeAmount(absBigInt(tokenRaw), 18);
  if (quoteAmount <= 0 || tokenAmount <= 0) return undefined;

  const observedAt = row.observedAt instanceof Date ? row.observedAt : new Date(row.observedAt as string);

  return {
    chainId: Number(row.chainId),
    chainKey,
    tokenAddress: tokenAddress.toLowerCase(),
    quoteAddress: quote.address.toLowerCase(),
    priceUsd: (quoteAmount * quote.usdPrice) / tokenAmount,
    volumeUsd: quoteAmount * quote.usdPrice,
    isBuy: quoteIsToken0 ? BigInt(row.amount0Raw) < 0n : BigInt(row.amount1Raw) < 0n,
    blockNumber: Number(row.blockNumber),
    txHash: row.txHash,
    observedAt,
    swapId: Number(row.id) || null,
  };
}

function deriveWrappedNativePrices(stablePriced: PricedSwapBase[]): Map<string, number> {
  const prices = new Map<string, number>();
  for (const wn of wrappedNatives) {
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
  const oldest = [...swaps].sort((a, b) => a.blockNumber - b.blockNumber)[0];
  if (!newest || !oldest) return;

  const volumeUsd = swaps.reduce((sum, swap) => sum + swap.volumeUsd, 0);
  const buys = swaps.filter((swap) => swap.isBuy).length;
  const sells = swaps.length - buys;
  const priceChange = oldest.priceUsd > 0 ? ((newest.priceUsd - oldest.priceUsd) / oldest.priceUsd) * 100 : 0;

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
      ${swaps.length},
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

function absBigInt(value: string) {
  const bigint = BigInt(value);
  return bigint < 0n ? -bigint : bigint;
}

function normalizeAmount(value: bigint, decimals: number) {
  return Number(value) / 10 ** decimals;
}

function decimal(value: number, digits: number) {
  if (!Number.isFinite(value)) return "0";
  return value.toFixed(digits);
}

// Wipe all swap_prices and reset cursor — forces full rebuild from swap history.
export async function rebuildSwapPrices() {
  const sql = getDb();
  console.log("[rebuildSwapPrices] Truncating swap_prices and resetting candle-agg cursor…");
  await sql`DELETE FROM swap_prices`;
  await setCandleAggCursor(0);
  console.log("[rebuildSwapPrices] Re-aggregating from full swap history…");
  const result = await aggregateMarketOnce();
  console.log(
    `[rebuildSwapPrices] Done — ${result.tokens} tokens, ${result.pricedSwaps} priced swaps, ${result.newCandleSwaps} inserted into swap_prices.`,
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
