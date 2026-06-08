import { type Address } from "viem";
import { dexes, type DexConfig } from "../config/dexes.js";
import { buildPlatformLookup } from "../config/launchPlatforms.js";
import { env } from "../shared/env.js";
import { closeDb, getDb } from "../db/postgres.js";
import { runMigration } from "../db/migrate.js";
import { aerodromeV1FactoryAbi, uniswapV2FactoryAbi, uniswapV3FactoryAbi, uniswapV4PoolManagerAbi } from "./protocolEvents.js";
import { getRpcClient } from "./rpc.js";
import { finishIndexerRun, getCursor, setCursor, setTokenLaunchPlatform, startIndexerRun, upsertDiscoveredPool } from "./repository.js";

const platformLookup = buildPlatformLookup();

// Pre-compute which chains have platform entries so we skip the RPC call on chains with none
const platformChains = new Set(
  [...platformLookup.keys()].map((k) => k.split(":")[0]),
);

const workerName = "pool-discovery";

export type DiscoveryResult = {
  dexKey: string;
  fromBlock: bigint;
  toBlock: bigint;
  discoveredPools: number;
};

export async function discoverPoolsOnce(selectedDexes: DexConfig[] = dexes): Promise<DiscoveryResult[]> {
  await runMigration();

  const results: DiscoveryResult[] = [];
  for (const dex of selectedDexes) {
    try {
      results.push(await discoverDexPools(dex));
    } catch (err) {
      // Per-DEX errors are non-fatal — log and continue to next DEX.
      console.warn(
        `[discoverPools] ${dex.key} failed (RPC error?): ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
      results.push({
        dexKey: dex.key,
        fromBlock: 0n,
        toBlock: 0n,
        discoveredPools: 0,
      });
    }
  }

  return results;
}

async function discoverDexPools(dex: DexConfig): Promise<DiscoveryResult> {
  const client = getRpcClient(dex.chain);
  const latestBlock = await client.getBlockNumber();
  const safeLatestBlock = latestBlock > BigInt(env.INDEXER_CONFIRMATIONS) ? latestBlock - BigInt(env.INDEXER_CONFIRMATIONS) : latestBlock;
  const existingCursor = await getCursor(dex.chain, dex.key, workerName);
  const lookbackStart = safeLatestBlock > BigInt(env.INDEXER_DISCOVERY_LOOKBACK_BLOCKS)
    ? safeLatestBlock - BigInt(env.INDEXER_DISCOVERY_LOOKBACK_BLOCKS)
    : 0n;
  const pageSize = Math.min(env.INDEXER_BLOCK_PAGE_SIZE, maxLogBlockRange(dex.chain));
  const fromBlock = existingCursor ? existingCursor + 1n : lookbackStart;
  const toBlock = minBlock(fromBlock + BigInt(pageSize - 1), safeLatestBlock);

  if (fromBlock > toBlock) {
    return { dexKey: dex.key, fromBlock, toBlock: safeLatestBlock, discoveredPools: 0 };
  }

  const runId = await startIndexerRun(workerName, dex.chain, dex.key, fromBlock, toBlock);
  let discoveredPools = 0;

  try {
    const rawPools = await fetchPoolLogs(dex, fromBlock, toBlock);

    // ── Fetch actual on-chain block timestamps for new pools ──────────────────
    // We batch-fetch all unique block numbers so age computation is accurate.
    // Without this, pools.created_at = DB insertion time, which is wrong for
    // pools discovered hours after creation.
    const blockTimestampMap = rawPools.length > 0
      ? await fetchBlockTimestamps(dex.chain, rawPools.map((p) => p.blockNumber))
      : new Map<bigint, Date>();

    for (const pool of rawPools) {
      await upsertDiscoveredPool({ ...pool, blockTimestamp: blockTimestampMap.get(pool.blockNumber) });
      discoveredPools += 1;

      // Detect launch platform (Clanker, Bankr, etc.) by checking who sent
      // the pool-creation transaction. Only runs on chains that have platforms.
      if (platformChains.has(dex.chain)) {
        const platform = await detectPoolPlatform(dex, pool.txHash as `0x${string}`);
        if (platform) {
          // Tag the non-quote token. If neither or both are quote assets, tag both.
          await setTokenLaunchPlatform(dex.chain, pool.token0, platform);
          await setTokenLaunchPlatform(dex.chain, pool.token1, platform);
        }
      }
    }

    await setCursor(dex.chain, dex.key, workerName, toBlock);
    await finishIndexerRun(runId, discoveredPools);
    return { dexKey: dex.key, fromBlock, toBlock, discoveredPools };
  } catch (error) {
    await finishIndexerRun(runId, discoveredPools, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Fetch actual on-chain block timestamps for a set of block numbers in parallel.
 * Returns a Map from blockNumber → Date.
 */
async function fetchBlockTimestamps(chain: DexConfig["chain"], blockNumbers: bigint[]): Promise<Map<bigint, Date>> {
  const client = getRpcClient(chain);
  const uniqueBlocks = [...new Set(blockNumbers)];
  const timestampMap = new Map<bigint, Date>();

  // Fetch all unique blocks in parallel (typically < 20 per discovery page)
  const settled = await Promise.allSettled(
    uniqueBlocks.map((bn) => client.getBlock({ blockNumber: bn })),
  );
  for (let i = 0; i < uniqueBlocks.length; i++) {
    const result = settled[i];
    const bn = uniqueBlocks[i];
    if (result?.status === "fulfilled" && bn !== undefined) {
      timestampMap.set(bn, new Date(Number(result.value.timestamp) * 1000));
    }
  }

  return timestampMap;
}

/**
 * Backfill block_timestamp for pools that were discovered before this feature
 * was added (block_timestamp IS NULL). Processes up to `limit` pools per call.
 */
const TIMESTAMP_BACKFILL_PER_CYCLE = 20;

export async function backfillMissingPoolTimestamps(selectedDexes: DexConfig[] = dexes): Promise<number> {
  const sql = getDb();
  let total = 0;

  for (const dex of selectedDexes) {
    const rows = await sql`
      SELECT pools.id, pools.block_number::bigint AS block_number
      FROM pools
      JOIN chains ON chains.id = pools.chain_id
      WHERE chains."key" = ${dex.chain}
        AND pools.block_timestamp IS NULL
      ORDER BY pools.block_number ASC
      LIMIT ${TIMESTAMP_BACKFILL_PER_CYCLE}
    `;
    if (rows.length === 0) continue;

    const blockNumbers = rows.map((r) => BigInt(r.block_number as string | number));
    const timestampMap = await fetchBlockTimestamps(dex.chain, blockNumbers);

    for (const row of rows) {
      const bn = BigInt(row.block_number as string | number);
      const ts = timestampMap.get(bn);
      if (!ts) continue;
      await sql`UPDATE pools SET block_timestamp = ${ts.toISOString()} WHERE id = ${row.id}`;
      total++;
    }
    // Only process the first chain with missing timestamps per call to avoid long cycles
    if (total > 0) break;
  }

  return total;
}

async function fetchPoolLogs(dex: DexConfig, fromBlock: bigint, toBlock: bigint) {
  if (dex.version === "v2") return fetchV2Pools(dex, fromBlock, toBlock);
  if (dex.version === "v3") return fetchV3Pools(dex, fromBlock, toBlock);
  return fetchV4Pools(dex, fromBlock, toBlock);
}

async function fetchV2Pools(dex: DexConfig, fromBlock: bigint, toBlock: bigint) {
  if (dex.protocol === "aerodrome-v1") return fetchAerodromeV1Pools(dex, fromBlock, toBlock);

  const client = getRpcClient(dex.chain);
  const logs = await client.getLogs({
    address: dex.factoryAddress as Address,
    event: uniswapV2FactoryAbi[0],
    fromBlock,
    toBlock,
  });

  return logs.map((log) => {
    const token0 = requireAddress(log.args.token0, "token0", dex.key);
    const token1 = requireAddress(log.args.token1, "token1", dex.key);
    const pair = requireAddress(log.args.pair, "pair", dex.key);

    return {
      chain: dex.chain,
      dex,
      protocolVersion: dex.version,
      token0,
      token1,
      poolAddress: pair,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      rawLog: log,
    };
  });
}

async function fetchAerodromeV1Pools(dex: DexConfig, fromBlock: bigint, toBlock: bigint) {
  const client = getRpcClient(dex.chain);
  const logs = await client.getLogs({
    address: dex.factoryAddress as Address,
    event: aerodromeV1FactoryAbi[0],
    fromBlock,
    toBlock,
  });

  return logs.map((log) => {
    const token0 = requireAddress(log.args.token0, "token0", dex.key);
    const token1 = requireAddress(log.args.token1, "token1", dex.key);
    const pair = requireAddress(log.args.pair, "pair", dex.key);

    return {
      chain: dex.chain,
      dex,
      protocolVersion: dex.version,
      token0,
      token1,
      poolAddress: pair,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      rawLog: log,
    };
  });
}

async function fetchV3Pools(dex: DexConfig, fromBlock: bigint, toBlock: bigint) {
  const client = getRpcClient(dex.chain);
  const logs = await client.getLogs({
    address: dex.factoryAddress as Address,
    event: uniswapV3FactoryAbi[0],
    fromBlock,
    toBlock,
  });

  return logs.map((log) => {
    const token0 = requireAddress(log.args.token0, "token0", dex.key);
    const token1 = requireAddress(log.args.token1, "token1", dex.key);
    const pool = requireAddress(log.args.pool, "pool", dex.key);

    return {
      chain: dex.chain,
      dex,
      protocolVersion: dex.version,
      token0,
      token1,
      poolAddress: pool,
      fee: Number(log.args.fee),
      tickSpacing: Number(log.args.tickSpacing),
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      rawLog: log,
    };
  });
}

async function fetchV4Pools(dex: DexConfig, fromBlock: bigint, toBlock: bigint) {
  const client = getRpcClient(dex.chain);
  const logs = await client.getLogs({
    address: dex.factoryAddress as Address,
    event: uniswapV4PoolManagerAbi[0],
    fromBlock,
    toBlock,
  });

  return logs.map((log) => {
    const token0 = requireAddress(log.args.currency0, "currency0", dex.key);
    const token1 = requireAddress(log.args.currency1, "currency1", dex.key);
    const hooks = requireAddress(log.args.hooks, "hooks", dex.key);
    if (!log.args.id) throw new Error(`Missing id in ${dex.key} Initialize log`);

    return {
      chain: dex.chain,
      dex,
      protocolVersion: dex.version,
      token0,
      token1,
      poolId: log.args.id,
      fee: Number(log.args.fee),
      tickSpacing: Number(log.args.tickSpacing),
      hookAddress: hooks,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      rawLog: log,
    };
  });
}

/**
 * Look up the sender of the pool-creation transaction and match it against
 * known launch-platform factory addresses.
 * Returns the platform key (e.g. "clanker") or null if not recognised.
 */
async function detectPoolPlatform(dex: DexConfig, txHash: `0x${string}`): Promise<string | null> {
  try {
    const client = getRpcClient(dex.chain);
    const tx = await client.getTransaction({ hash: txHash });
    const lookupKey = `${dex.chain}:${tx.from.toLowerCase()}`;
    return platformLookup.get(lookupKey) ?? null;
  } catch {
    // Non-fatal: if the RPC call fails we just skip tagging
    return null;
  }
}

function minBlock(a: bigint, b: bigint) {
  return a < b ? a : b;
}

function maxLogBlockRange(chain: DexConfig["chain"]) {
  if (chain === "bsc") return 100;
  return 1_000;
}

function requireAddress(value: Address | undefined, field: string, dexKey: string) {
  if (!value) throw new Error(`Missing ${field} in ${dexKey} discovery log`);
  return value;
}

if (process.argv[1]?.endsWith("discoverPools.ts") || process.argv[1]?.endsWith("discoverPools.js")) {
  discoverPoolsOnce()
    .then(async (results) => {
      for (const result of results) {
        console.log(`${result.dexKey}: ${result.fromBlock}-${result.toBlock}, discovered ${result.discoveredPools} pools`);
      }
      await closeDb();
    })
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exitCode = 1;
    });
}
