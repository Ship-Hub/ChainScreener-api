import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../db/postgres.js";
import { resolveBaseToken, bigIntToFloat, QUOTE_ADDRESSES } from "../services/walletService.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_TRADES_FOR_WALLET = 2000; // more → likely a router/contract
const MIN_TRADES_FOR_WALLET = 2;
const EARLY_BLOCKS = 500; // within this many blocks of pool creation = "early entry"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type TradeRecord = {
  wallet: string;
  chainId: number;
  side: "buy" | "sell";
  tokenAddress: string;
  tokenSymbol: string;
  tokenAmount: number;
  blockNumber: number;
  poolCreatedBlock: number;
  occurredAt: Date;
};

type CandlePoint = { openedAt: Date; closeUsd: number };

type WalletMetrics = {
  tradeCount: number;
  uniqueTokens: number;
  chainCount: number;
  volumeUsd: number;
  winRatePct: number;
  profitableTrades: number;
  totalClosedTrades: number;
  earlyEntryPct: number;
  realizedPnlUsd: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Find candidate wallets
// ─────────────────────────────────────────────────────────────────────────────

async function getCandidates(sql: ReturnType<typeof getDb>) {
  const rows = await sql`
    SELECT
      s.recipient_address AS address,
      COUNT(*) AS trade_count,
      COUNT(DISTINCT s.chain_id) AS chain_count,
      COUNT(DISTINCT COALESCE(p.token0_address, '') || ':' || COALESCE(p.token1_address, '')) AS token_pairs,
      MIN(s.occurred_at) AS first_seen,
      MAX(s.occurred_at) AS last_seen
    FROM swaps s
    LEFT JOIN pools p ON p.id = s.pool_id
    WHERE s.recipient_address IS NOT NULL
      AND s.recipient_address != ${ZERO_ADDRESS}
      AND s.pool_id IS NOT NULL
    GROUP BY s.recipient_address
    HAVING COUNT(*) >= ${MIN_TRADES_FOR_WALLET} AND COUNT(*) < ${MAX_TRADES_FOR_WALLET}
    ORDER BY COUNT(*) DESC
    LIMIT 200
  `;
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Fetch all trades for candidates (enriched with pool creation block)
// ─────────────────────────────────────────────────────────────────────────────

async function getTradesForWallets(
  sql: ReturnType<typeof getDb>,
  addresses: string[],
): Promise<TradeRecord[]> {
  if (!addresses.length) return [];

  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT
       s.recipient_address                               AS wallet,
       s.chain_id                                        AS "chainId",
       s.block_number                                    AS "blockNumber",
       s.occurred_at                                     AS "occurredAt",
       s.amount0_raw                                     AS "amount0Raw",
       s.amount1_raw                                     AS "amount1Raw",
       pools.block_number                                AS "poolCreatedBlock",
       pools.token0_address                              AS token0,
       pools.token1_address                              AS token1,
       COALESCE(t0.symbol,'UNKNOWN')                     AS "token0Symbol",
       COALESCE(t0.decimals,18)                          AS "token0Decimals",
       COALESCE(t1.symbol,'UNKNOWN')                     AS "token1Symbol",
       COALESCE(t1.decimals,18)                          AS "token1Decimals",
       COALESCE(CAST(m0.price_usd AS NUMERIC(36,18)),0) AS "token0PriceUsd",
       COALESCE(CAST(m1.price_usd AS NUMERIC(36,18)),0) AS "token1PriceUsd"
     FROM swaps s
     LEFT JOIN pools ON pools.id = s.pool_id
     LEFT JOIN tokens t0 ON t0.chain_id = s.chain_id AND t0.address = pools.token0_address
     LEFT JOIN tokens t1 ON t1.chain_id = s.chain_id AND t1.address = pools.token1_address
     LEFT JOIN token_market_stats m0 ON m0.chain_id = s.chain_id AND m0.token_address = pools.token0_address
     LEFT JOIN token_market_stats m1 ON m1.chain_id = s.chain_id AND m1.token_address = pools.token1_address
     WHERE s.recipient_address = ANY($1)
       AND s.pool_id IS NOT NULL
     ORDER BY s.occurred_at ASC`,
    [addresses],
  );

  const result: TradeRecord[] = [];
  for (const row of rows) {
    const resolved = resolveBaseToken(row);
    if (!resolved.tokenAddress) continue;
    const amount = bigIntToFloat(resolved.tokenAmountRaw, resolved.tokenDecimals);
    if (amount <= 0) continue;
    result.push({
      wallet: ((row.wallet as string) ?? "").toLowerCase(),
      chainId: Number(row.chainId),
      side: resolved.side,
      tokenAddress: resolved.tokenAddress,
      tokenSymbol: resolved.tokenSymbol,
      tokenAmount: amount,
      blockNumber: Number(row.blockNumber),
      poolCreatedBlock: Number(row.poolCreatedBlock ?? 0),
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt : new Date(row.occurredAt as string),
    });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Load candle series for all tokens seen in trades
// ─────────────────────────────────────────────────────────────────────────────

async function loadCandles(
  sql: ReturnType<typeof getDb>,
  tokenKeys: Set<string>, // "chainId:tokenAddress"
): Promise<Map<string, CandlePoint[]>> {
  if (tokenKeys.size === 0) return new Map();

  // Use composite key comparison: chain_id || ':' || token_address = ANY(keys)
  const keys = Array.from(tokenKeys);

  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `SELECT chain_id, token_address, bucket AS opened_at, close_usd
     FROM token_candles_5m
     WHERE chain_id::text || ':' || token_address = ANY($1)
     ORDER BY chain_id, token_address, bucket ASC`,
    [keys],
  );

  const map = new Map<string, CandlePoint[]>();
  for (const row of rows) {
    const key = `${row.chain_id as number}:${row.token_address as string}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({
      openedAt: row.opened_at instanceof Date ? row.opened_at : new Date(row.opened_at as string),
      closeUsd: Number(row.close_usd),
    });
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function priceAtTime(candles: CandlePoint[], timestamp: Date): number {
  if (!candles.length) return 0;
  const t = timestamp.getTime();
  let lo = 0;
  let hi = candles.length - 1;
  if (candles[0].openedAt.getTime() > t) return 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (candles[mid].openedAt.getTime() <= t) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo].closeUsd;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — Compute per-wallet metrics
// ─────────────────────────────────────────────────────────────────────────────

function computeMetrics(
  walletTrades: TradeRecord[],
  candleMap: Map<string, CandlePoint[]>,
): WalletMetrics {
  if (!walletTrades.length) {
    return {
      tradeCount: 0, uniqueTokens: 0, chainCount: 0, volumeUsd: 0,
      winRatePct: 0, profitableTrades: 0, totalClosedTrades: 0,
      earlyEntryPct: 0, realizedPnlUsd: 0, firstSeen: null, lastSeen: null,
    };
  }

  type Position = { costBasis: number; amount: number };
  const positions = new Map<string, Position>();
  let realizedPnl = 0;
  let profitableTrades = 0;
  let totalClosedTrades = 0;
  let earlyTrades = 0;
  let volumeUsd = 0;

  const tokenWins = new Map<string, boolean>();
  const tokenBuyValue = new Map<string, number>();
  const tokenSellValue = new Map<string, number>();

  for (const trade of walletTrades) {
    const candleKey = `${trade.chainId}:${trade.tokenAddress}`;
    const candles = candleMap.get(candleKey) ?? [];
    const tradePrice = priceAtTime(candles, trade.occurredAt);
    const hasPrice = tradePrice > 0;

    const tradeValue = trade.tokenAmount * tradePrice;
    if (hasPrice) volumeUsd += tradeValue;

    if (trade.side === "buy" && hasPrice) {
      const pos = positions.get(trade.tokenAddress) ?? { costBasis: 0, amount: 0 };
      pos.costBasis =
        (pos.costBasis * pos.amount + tradePrice * trade.tokenAmount) /
        (pos.amount + trade.tokenAmount);
      pos.amount += trade.tokenAmount;
      positions.set(trade.tokenAddress, pos);
      tokenBuyValue.set(trade.tokenAddress, (tokenBuyValue.get(trade.tokenAddress) ?? 0) + tradeValue);
    }

    if (trade.side === "sell" && hasPrice) {
      const pos = positions.get(trade.tokenAddress);
      if (pos && pos.amount > 0) {
        const sellAmt = Math.min(trade.tokenAmount, pos.amount);
        const pnl = sellAmt * (tradePrice - pos.costBasis);
        realizedPnl += pnl;
        pos.amount -= sellAmt;
        tokenSellValue.set(trade.tokenAddress, (tokenSellValue.get(trade.tokenAddress) ?? 0) + tradeValue);
      }
    }

    if (trade.poolCreatedBlock > 0 && trade.blockNumber - trade.poolCreatedBlock <= EARLY_BLOCKS) {
      earlyTrades++;
    }
  }

  for (const [token, buyVal] of tokenBuyValue.entries()) {
    const sellVal = tokenSellValue.get(token) ?? 0;
    if (sellVal === 0) continue;
    totalClosedTrades++;
    if (sellVal > buyVal) {
      profitableTrades++;
      tokenWins.set(token, true);
    } else {
      tokenWins.set(token, false);
    }
  }

  const winRatePct = totalClosedTrades > 0
    ? Math.round((profitableTrades / totalClosedTrades) * 100)
    : 0;

  const earlyEntryPct = walletTrades.length > 0
    ? Math.round((earlyTrades / walletTrades.length) * 100)
    : 0;

  const chainIds = new Set(walletTrades.map((t) => t.chainId));
  const tokenAddrs = new Set(walletTrades.map((t) => t.tokenAddress));
  const dates = walletTrades.map((t) => t.occurredAt);

  return {
    tradeCount: walletTrades.length,
    uniqueTokens: tokenAddrs.size,
    chainCount: chainIds.size,
    volumeUsd,
    winRatePct,
    profitableTrades,
    totalClosedTrades,
    earlyEntryPct,
    realizedPnlUsd: realizedPnl,
    firstSeen: dates.length ? dates[0] : null,
    lastSeen: dates.length ? dates[dates.length - 1] : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — Composite score
// ─────────────────────────────────────────────────────────────────────────────

function computeScore(m: WalletMetrics): number {
  const activity = Math.min(100, Math.floor(
    Math.log(1 + m.tradeCount) * 12 + m.uniqueTokens * 3 + m.chainCount * 8,
  ));
  const winScore = m.totalClosedTrades >= 2 ? m.winRatePct : 50;
  const earlyScore = m.earlyEntryPct;
  const pnlMagnitude = Math.sign(m.realizedPnlUsd) * Math.sqrt(Math.abs(m.realizedPnlUsd));
  const pnlScore = Math.min(100, Math.max(0, 50 + pnlMagnitude * 0.5));
  return Math.round(activity * 0.2 + winScore * 0.4 + earlyScore * 0.2 + pnlScore * 0.2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function computeSmartWalletsOnce(): Promise<{ computed: number }> {
  const sql = getDb();

  const candidates = await getCandidates(sql);
  if (!candidates.length) return { computed: 0 };

  const addresses = candidates.map((c) => ((c.address as string) ?? "").toLowerCase());

  const allTrades = await getTradesForWallets(sql, addresses);

  const tokenKeys = new Set(allTrades.map((t) => `${t.chainId}:${t.tokenAddress}`));
  const candleMap = await loadCandles(sql, tokenKeys);

  let computed = 0;
  for (const candidate of candidates) {
    const addr = ((candidate.address as string) ?? "").toLowerCase();
    const walletTrades = allTrades.filter((t) => t.wallet === addr);
    const metrics = computeMetrics(walletTrades, candleMap);
    const score = computeScore(metrics);

    await sql`
      INSERT INTO smart_wallets
        (address, score, total_volume_usd, total_trades, tokens_traded, chains_active,
         win_rate_pct, realized_pnl_usd, early_entry_pct,
         profitable_trades, total_closed_trades,
         first_seen_at, last_seen_at)
      VALUES (
        ${addr}, ${score},
        ${metrics.volumeUsd.toFixed(6)},
        ${metrics.tradeCount}, ${metrics.uniqueTokens}, ${metrics.chainCount},
        ${metrics.winRatePct.toFixed(2)},
        ${metrics.realizedPnlUsd.toFixed(6)},
        ${metrics.earlyEntryPct.toFixed(2)},
        ${metrics.profitableTrades}, ${metrics.totalClosedTrades},
        ${metrics.firstSeen}, ${metrics.lastSeen}
      )
      ON CONFLICT (address) DO UPDATE
        SET score               = EXCLUDED.score,
            total_volume_usd    = EXCLUDED.total_volume_usd,
            total_trades        = EXCLUDED.total_trades,
            tokens_traded       = EXCLUDED.tokens_traded,
            chains_active       = EXCLUDED.chains_active,
            win_rate_pct        = EXCLUDED.win_rate_pct,
            realized_pnl_usd    = EXCLUDED.realized_pnl_usd,
            early_entry_pct     = EXCLUDED.early_entry_pct,
            profitable_trades   = EXCLUDED.profitable_trades,
            total_closed_trades = EXCLUDED.total_closed_trades,
            first_seen_at       = EXCLUDED.first_seen_at,
            last_seen_at        = EXCLUDED.last_seen_at,
            computed_at         = NOW()
    `;
    computed++;
  }

  return { computed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  computeSmartWalletsOnce()
    .then(async ({ computed }) => {
      await closeDb();
      console.log(`Smart wallets computed: ${computed}`);
    })
    .catch(async (error) => {
      await closeDb();
      console.error(error);
      process.exitCode = 1;
    });
}
