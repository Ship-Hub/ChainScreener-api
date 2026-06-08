import type { ChainKey } from "../config/chains.js";
import type { DexConfig } from "../config/dexes.js";
import { getDb } from "../db/postgres.js";

export type DiscoveredPool = {
  chain: ChainKey;
  dex: DexConfig;
  protocolVersion: "v2" | "v3" | "v4";
  token0: string;
  token1: string;
  poolAddress?: string;
  poolId?: string;
  fee?: number;
  tickSpacing?: number;
  hookAddress?: string;
  blockNumber: bigint;
  /** Actual on-chain timestamp of the pool creation block (fetched from RPC during discovery) */
  blockTimestamp?: Date;
  txHash: string;
  logIndex: number;
  rawLog: unknown;
};

export type IndexedPool = {
  id: number;
  chain: ChainKey;
  dexKey: string;
  dex: DexConfig;
  protocolVersion: "v2" | "v3" | "v4";
  address?: string;
  poolId?: string;
  token0: string;
  token1: string;
  blockNumber: bigint;
};

export type IndexedSwap = {
  chain: ChainKey;
  dex: DexConfig;
  indexedPool?: IndexedPool;
  protocolVersion: "v2" | "v3" | "v4";
  poolAddress?: string;
  v4PoolId?: string;
  sender?: string;
  recipient?: string;
  amount0Raw: string;
  amount1Raw: string;
  sqrtPriceX96?: string;
  liquidity?: string;
  tick?: number;
  fee?: number;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  rawLog: unknown;
};

// ─── In-memory cache for chain/dex IDs ───────────────────────────────────────
const chainIdCache = new Map<string, number>();
const dexIdCache = new Map<string, number>();

export async function getCursor(chainKey: ChainKey, dexKey: string, workerName: string) {
  const sql = getDb();
  const rows = await sql`
    SELECT last_block FROM indexer_cursors
    WHERE chain_key = ${chainKey} AND dex_key = ${dexKey} AND worker_name = ${workerName}
  `;
  return rows[0]?.last_block ? BigInt(rows[0].last_block as string) : undefined;
}

export async function setCursor(chainKey: ChainKey, dexKey: string, workerName: string, lastBlock: bigint) {
  const sql = getDb();
  await sql`
    INSERT INTO indexer_cursors (chain_key, dex_key, worker_name, last_block)
    VALUES (${chainKey}, ${dexKey}, ${workerName}, ${lastBlock.toString()})
    ON CONFLICT (chain_key, dex_key, worker_name)
    DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = NOW()
  `;
}

export async function startIndexerRun(
  workerName: string,
  chainKey: ChainKey,
  dexKey: string,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO indexer_runs (worker_name, chain_key, dex_key, from_block, to_block)
    VALUES (${workerName}, ${chainKey}, ${dexKey}, ${fromBlock.toString()}, ${toBlock.toString()})
    RETURNING id
  `;
  return Number(rows[0].id);
}

export async function finishIndexerRun(runId: number, discoveredPools: number, error?: string) {
  const sql = getDb();
  await sql`
    UPDATE indexer_runs
    SET status = ${error ? "failed" : "success"},
        discovered_pools = ${discoveredPools},
        error = ${error ?? null},
        finished_at = NOW()
    WHERE id = ${runId}
  `;
}

export async function upsertDiscoveredPool(pool: DiscoveredPool) {
  const sql = getDb();
  const chainId = await getChainId(pool.chain);
  const dexId = await getDexId(pool.dex.key);

  await upsertToken(chainId, pool.token0);
  await upsertToken(chainId, pool.token1);

  await sql`
    INSERT INTO pool_discovery_events (
      chain_id, dex_id, protocol_version, event_name, raw_log, block_number, tx_hash, log_index
    )
    VALUES (
      ${chainId}, ${dexId}, ${pool.protocolVersion}, ${pool.dex.event},
      ${stringifyForJson(pool.rawLog)}, ${pool.blockNumber.toString()},
      ${pool.txHash}, ${pool.logIndex}
    )
    ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
  `;

  await sql`
    INSERT INTO pools (
      chain_id, dex_id, address, pool_id, protocol_version,
      token0_address, token1_address, fee, tick_spacing, hook_address,
      block_number, block_timestamp, tx_hash, log_index
    )
    VALUES (
      ${chainId}, ${dexId},
      ${pool.poolAddress?.toLowerCase() ?? null},
      ${pool.poolId?.toLowerCase() ?? null},
      ${pool.protocolVersion},
      ${pool.token0.toLowerCase()},
      ${pool.token1.toLowerCase()},
      ${pool.fee ?? null},
      ${pool.tickSpacing ?? null},
      ${pool.hookAddress?.toLowerCase() ?? null},
      ${pool.blockNumber.toString()},
      ${pool.blockTimestamp?.toISOString() ?? null},
      ${pool.txHash},
      ${pool.logIndex}
    )
    ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
  `;
}

/**
 * Returns pools whose creation block is at or before `swapCursor`
 * but whose history has not yet been backfilled.
 */
export async function getPoolsNeedingBackfill(
  dex: DexConfig,
  swapCursor: bigint,
  limit = 20,
): Promise<IndexedPool[]> {
  const sql = getDb();
  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));

  const rows = await sql`
    SELECT
      pools.id,
      chains."key" AS chain_key,
      dexes."key"  AS dex_key,
      pools.protocol_version,
      pools.address,
      pools.pool_id,
      pools.token0_address,
      pools.token1_address,
      pools.block_number
    FROM pools
    JOIN chains ON chains.id = pools.chain_id
    JOIN dexes  ON dexes.id  = pools.dex_id
    WHERE dexes."key" = ${dex.key}
      AND pools.history_fetched = FALSE
      AND pools.block_number <= ${swapCursor.toString()}
    ORDER BY pools.block_number ASC
    LIMIT ${safeLimit}
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    chain: row.chain_key as ChainKey,
    dexKey: row.dex_key as string,
    dex,
    protocolVersion: row.protocol_version as "v2" | "v3" | "v4",
    address: (row.address as string | null) ?? undefined,
    poolId: (row.pool_id as string | null) ?? undefined,
    token0: row.token0_address as string,
    token1: row.token1_address as string,
    blockNumber: BigInt(row.block_number as string),
  }));
}

/** Mark one or more pools as fully history-backfilled. */
export async function markPoolsHistoryFetched(poolIds: number[]): Promise<void> {
  if (poolIds.length === 0) return;
  const sql = getDb();
  await sql`UPDATE pools SET history_fetched = TRUE WHERE id = ANY(${poolIds})`;
}

export async function listIndexedPoolsForDex(dex: DexConfig, limit = 250): Promise<IndexedPool[]> {
  const sql = getDb();
  const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));

  const rows = await sql`
    SELECT
      pools.id,
      chains."key" AS chain_key,
      dexes."key"  AS dex_key,
      pools.protocol_version,
      pools.address,
      pools.pool_id,
      pools.token0_address,
      pools.token1_address,
      pools.block_number
    FROM pools
    JOIN chains ON chains.id = pools.chain_id
    JOIN dexes  ON dexes.id  = pools.dex_id
    WHERE dexes."key" = ${dex.key}
    ORDER BY pools.block_number DESC
    LIMIT ${safeLimit}
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    chain: row.chain_key as ChainKey,
    dexKey: row.dex_key as string,
    dex,
    protocolVersion: row.protocol_version as "v2" | "v3" | "v4",
    address: (row.address as string | null) ?? undefined,
    poolId: (row.pool_id as string | null) ?? undefined,
    token0: row.token0_address as string,
    token1: row.token1_address as string,
    blockNumber: BigInt(row.block_number as string),
  }));
}

export async function upsertIndexedSwap(swap: IndexedSwap) {
  const sql = getDb();
  const chainId = await getChainId(swap.chain);
  const dexId = await getDexId(swap.dex.key);

  await sql`
    INSERT INTO swaps (
      chain_id, dex_id, pool_id, protocol_version, pool_address, v4_pool_id,
      sender_address, recipient_address, amount0_raw, amount1_raw,
      sqrt_price_x96, liquidity, tick, fee,
      block_number, tx_hash, log_index, raw_log
    )
    VALUES (
      ${chainId}, ${dexId},
      ${swap.indexedPool?.id ?? null},
      ${swap.protocolVersion},
      ${swap.poolAddress?.toLowerCase() ?? null},
      ${swap.v4PoolId?.toLowerCase() ?? null},
      ${swap.sender?.toLowerCase() ?? null},
      ${swap.recipient?.toLowerCase() ?? null},
      ${swap.amount0Raw},
      ${swap.amount1Raw},
      ${swap.sqrtPriceX96 ?? null},
      ${swap.liquidity ?? null},
      ${swap.tick ?? null},
      ${swap.fee ?? null},
      ${swap.blockNumber.toString()},
      ${swap.txHash},
      ${swap.logIndex},
      ${stringifyForJson(swap.rawLog)}
    )
    ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
  `;
}

// Native/wrapped assets whose metadata doesn't come from ERC20 calls
const KNOWN_NATIVE_TOKENS: Record<string, { symbol: string; name: string; decimals: number }> = {
  "0x0000000000000000000000000000000000000000": { symbol: "ETH",  name: "Ethereum",     decimals: 18 },
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": { symbol: "WBNB", name: "Wrapped BNB",   decimals: 18 },
};

async function upsertToken(chainId: number, address: string) {
  const sql = getDb();
  const addr = address.toLowerCase();
  const known = KNOWN_NATIVE_TOKENS[addr];
  if (known) {
    // Pre-seed native/wrapped tokens with correct metadata so they never show as UNKNOWN
    await sql`
      INSERT INTO tokens (chain_id, address, symbol, name, decimals)
      VALUES (${chainId}, ${addr}, ${known.symbol}, ${known.name}, ${known.decimals})
      ON CONFLICT (chain_id, address) DO UPDATE
        SET symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals = EXCLUDED.decimals,
            updated_at = NOW()
    `;
  } else {
    await sql`
      INSERT INTO tokens (chain_id, address)
      VALUES (${chainId}, ${addr})
      ON CONFLICT (chain_id, address) DO UPDATE SET updated_at = NOW()
    `;
  }
}

/**
 * Tag a token with its launch platform (e.g. "clanker", "bankr").
 * Only updates if launch_platform is currently NULL so a later discovery
 * doesn't overwrite an already-confirmed platform tag.
 */
export async function setTokenLaunchPlatform(chain: ChainKey, tokenAddress: string, platform: string) {
  const sql = getDb();
  const chainId = await getChainId(chain);
  await sql`
    UPDATE tokens
    SET launch_platform = ${platform}
    WHERE chain_id = ${chainId}
      AND address = ${tokenAddress.toLowerCase()}
      AND launch_platform IS NULL
  `;
}

async function getChainId(chainKey: ChainKey): Promise<number> {
  const cached = chainIdCache.get(chainKey);
  if (cached !== undefined) return cached;

  const sql = getDb();
  const rows = await sql`SELECT id FROM chains WHERE "key" = ${chainKey}`;
  const id = rows[0]?.id;
  if (!id) throw new Error(`Chain is not seeded: ${chainKey}`);
  const num = Number(id);
  chainIdCache.set(chainKey, num);
  return num;
}

async function getDexId(dexKey: string): Promise<number> {
  const cached = dexIdCache.get(dexKey);
  if (cached !== undefined) return cached;

  const sql = getDb();
  const rows = await sql`SELECT id FROM dexes WHERE "key" = ${dexKey}`;
  const id = rows[0]?.id;
  if (!id) throw new Error(`DEX is not seeded: ${dexKey}`);
  const num = Number(id);
  dexIdCache.set(dexKey, num);
  return num;
}

function stringifyForJson(value: unknown) {
  return JSON.stringify(value, (_key, fieldValue) =>
    typeof fieldValue === "bigint" ? fieldValue.toString() : fieldValue,
  );
}
