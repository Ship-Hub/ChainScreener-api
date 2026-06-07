import { type Address } from "viem";
import { dexes, type DexConfig } from "../config/dexes.js";
import { closeDb } from "../db/postgres.js";
import { runMigration } from "../db/migrate.js";
import { env } from "../shared/env.js";
import { getRpcClient } from "./rpc.js";
import { uniswapV2PairAbi, uniswapV3PoolAbi, uniswapV4SwapAbi } from "./protocolEvents.js";
import {
  finishIndexerRun,
  getCursor,
  getPoolsNeedingBackfill,
  listIndexedPoolsForDex,
  markPoolsHistoryFetched,
  setCursor,
  startIndexerRun,
  upsertIndexedSwap,
  type IndexedPool,
} from "./repository.js";

const workerName = "swap-ingestion";

export type SwapIngestionResult = {
  dexKey: string;
  fromBlock: bigint;
  toBlock: bigint;
  indexedSwaps: number;
};

export async function ingestSwapsOnce(selectedDexes: DexConfig[] = dexes): Promise<SwapIngestionResult[]> {
  await runMigration();

  const results: SwapIngestionResult[] = [];
  for (const dex of selectedDexes) {
    try {
      results.push(await ingestDexSwaps(dex));
    } catch (err) {
      console.warn(
        `[ingestSwaps] ${dex.key} failed (RPC error?): ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
      results.push({ dexKey: dex.key, fromBlock: 0n, toBlock: 0n, indexedSwaps: 0 });
    }
  }

  return results;
}

async function ingestDexSwaps(dex: DexConfig): Promise<SwapIngestionResult> {
  const pools = await listIndexedPoolsForDex(dex, 300);
  const client = getRpcClient(dex.chain);
  const latestBlock = await client.getBlockNumber();
  const safeLatestBlock = latestBlock > BigInt(env.INDEXER_CONFIRMATIONS) ? latestBlock - BigInt(env.INDEXER_CONFIRMATIONS) : latestBlock;
  if (!pools.length) {
    return { dexKey: dex.key, fromBlock: safeLatestBlock, toBlock: safeLatestBlock, indexedSwaps: 0 };
  }

  const existingCursor = await getCursor(dex.chain, dex.key, workerName);

  // ── Historical backfill for newly discovered pools ────────────────────────
  // When a pool is discovered after the main cursor has already advanced past
  // its creation block, its pre-cursor swaps are silently skipped.
  // This step detects such pools and fetches their missing history first.
  if (existingCursor) {
    await backfillNewPools(dex, pools, existingCursor, safeLatestBlock);
  }

  // ── Normal forward paging ─────────────────────────────────────────────────
  const newestPoolStart = pools.reduce<bigint | undefined>((min, pool) => {
    if (min === undefined) return pool.blockNumber;
    return pool.blockNumber < min ? pool.blockNumber : min;
  }, undefined);
  const lookbackStart = safeLatestBlock > BigInt(env.INDEXER_DISCOVERY_LOOKBACK_BLOCKS)
    ? safeLatestBlock - BigInt(env.INDEXER_DISCOVERY_LOOKBACK_BLOCKS)
    : 0n;
  const fromBlock = existingCursor ? existingCursor + 1n : newestPoolStart ?? lookbackStart;
  const pageSize = Math.min(env.INDEXER_BLOCK_PAGE_SIZE, maxLogBlockRange(dex.chain));
  const toBlock = minBlock(fromBlock + BigInt(pageSize - 1), safeLatestBlock);

  if (fromBlock > toBlock) {
    return { dexKey: dex.key, fromBlock, toBlock: safeLatestBlock, indexedSwaps: 0 };
  }

  const runId = await startIndexerRun(workerName, dex.chain, dex.key, fromBlock, toBlock);
  let indexedSwaps = 0;

  try {
    const swaps = dex.version === "v4"
      ? await fetchV4Swaps(dex, pools, fromBlock, toBlock)
      : dex.version === "v3"
        ? await fetchV3Swaps(dex, pools, fromBlock, toBlock)
        : await fetchV2Swaps(dex, pools, fromBlock, toBlock);

    for (const swap of swaps) {
      await upsertIndexedSwap(swap);
      indexedSwaps += 1;
    }

    await setCursor(dex.chain, dex.key, workerName, toBlock);
    await finishIndexerRun(runId, indexedSwaps);
    return { dexKey: dex.key, fromBlock, toBlock, indexedSwaps };
  } catch (error) {
    await finishIndexerRun(runId, indexedSwaps, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Backfills historical swaps for any pool whose creation block predates the
 * current swap cursor.  Processes up to 5 pools per call, each in pages of
 * up to BACKFILL_PAGE_BLOCKS to avoid RPC timeouts.
 */
const BACKFILL_PAGE_BLOCKS = 2_000n;
const BACKFILL_POOLS_PER_CYCLE = 5;

async function backfillNewPools(
  dex: DexConfig,
  allPools: IndexedPool[],
  swapCursor: bigint,
  safeLatestBlock: bigint,
): Promise<void> {
  const poolsToFill = await getPoolsNeedingBackfill(dex, swapCursor, BACKFILL_POOLS_PER_CYCLE);
  if (poolsToFill.length === 0) return;

  const addressToPool = mapPoolsByAddress(allPools);
  const poolIdToPool  = new Map(allPools.filter((p) => p.poolId).map((p) => [p.poolId!.toLowerCase(), p]));

  for (const pool of poolsToFill) {
    const fromBlock = pool.blockNumber;
    // Fetch history up to the cursor (we'll pick up the rest in the main loop)
    const toBlock   = minBlock(swapCursor, safeLatestBlock);
    if (fromBlock > toBlock) {
      await markPoolsHistoryFetched([pool.id]);
      continue;
    }

    console.log(
      `[backfill] ${dex.key} pool ${pool.address ?? pool.poolId ?? pool.id}: ` +
      `fetching blocks ${fromBlock}–${toBlock} (${toBlock - fromBlock} blocks)`,
    );

    // Page through the historical range in chunks
    let cursor = fromBlock;
    let totalInserted = 0;
    while (cursor <= toBlock) {
      const end = minBlock(cursor + BACKFILL_PAGE_BLOCKS - 1n, toBlock);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let swaps: any[];
        if (dex.version === "v4") {
          swaps = await fetchV4Swaps(dex, [pool], cursor, end);
        } else if (dex.version === "v3") {
          swaps = await fetchV3Swaps(dex, [pool], cursor, end);
        } else {
          swaps = await fetchV2Swaps(dex, [pool], cursor, end);
        }
        for (const swap of swaps) {
          await upsertIndexedSwap(swap);
          totalInserted++;
        }
      } catch (err) {
        console.warn(`[backfill] ${dex.key} chunk ${cursor}–${end} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      cursor = end + 1n;
    }

    console.log(`[backfill] ${dex.key} pool ${pool.address ?? pool.poolId ?? pool.id}: inserted ${totalInserted} swaps`);
    await markPoolsHistoryFetched([pool.id]);
  }

}

const MAX_ADDRESSES_PER_CALL = 20;

async function fetchV2Swaps(dex: DexConfig, pools: IndexedPool[], fromBlock: bigint, toBlock: bigint) {
  const client = getRpcClient(dex.chain);
  const addressToPool = mapPoolsByAddress(pools);
  const addresses = [...addressToPool.keys()] as Address[];
  const allLogs = await batchGetLogs(client, addresses, uniswapV2PairAbi[0], fromBlock, toBlock);

  return allLogs.map((log) => {
    const pool = addressToPool.get(log.address.toLowerCase());
    const amount0Raw = bigintDelta(log.args.amount0In, log.args.amount0Out);
    const amount1Raw = bigintDelta(log.args.amount1In, log.args.amount1Out);

    return {
      chain: dex.chain,
      dex,
      indexedPool: pool,
      protocolVersion: dex.version,
      poolAddress: log.address,
      sender: log.args.sender,
      recipient: log.args.to,
      amount0Raw,
      amount1Raw,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      rawLog: log,
    };
  });
}

async function fetchV3Swaps(dex: DexConfig, pools: IndexedPool[], fromBlock: bigint, toBlock: bigint) {
  const client = getRpcClient(dex.chain);
  const addressToPool = mapPoolsByAddress(pools);
  const addresses = [...addressToPool.keys()] as Address[];
  const allLogs = await batchGetLogs(client, addresses, uniswapV3PoolAbi[0], fromBlock, toBlock);

  return allLogs.map((log) => ({
    chain: dex.chain,
    dex,
    indexedPool: addressToPool.get(log.address.toLowerCase()),
    protocolVersion: dex.version,
    poolAddress: log.address,
    sender: log.args.sender,
    recipient: log.args.recipient,
    amount0Raw: requireBigint(log.args.amount0, "amount0").toString(),
    amount1Raw: requireBigint(log.args.amount1, "amount1").toString(),
    sqrtPriceX96: requireBigint(log.args.sqrtPriceX96, "sqrtPriceX96").toString(),
    liquidity: requireBigint(log.args.liquidity, "liquidity").toString(),
    tick: Number(log.args.tick),
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: Number(log.logIndex),
    rawLog: log,
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function batchGetLogs(client: ReturnType<typeof getRpcClient>, addresses: Address[], event: any, fromBlock: bigint, toBlock: bigint): Promise<any[]> {
  const results: unknown[] = [];
  for (let i = 0; i < addresses.length; i += MAX_ADDRESSES_PER_CALL) {
    const batch = addresses.slice(i, i + MAX_ADDRESSES_PER_CALL);
    const logs = await client.getLogs({ address: batch, event, fromBlock, toBlock });
    results.push(...logs);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return results as any[];
}

async function fetchV4Swaps(dex: DexConfig, pools: IndexedPool[], fromBlock: bigint, toBlock: bigint) {
  const client = getRpcClient(dex.chain);
  const poolIdToPool = new Map(pools.filter((pool) => pool.poolId).map((pool) => [pool.poolId!.toLowerCase(), pool]));
  const logs = await client.getLogs({
    address: dex.factoryAddress as Address,
    event: uniswapV4SwapAbi[0],
    fromBlock,
    toBlock,
  });

  return logs
    .filter((log) => log.args.id && poolIdToPool.has(log.args.id.toLowerCase()))
    .map((log) => ({
      chain: dex.chain,
      dex,
      indexedPool: poolIdToPool.get(log.args.id!.toLowerCase()),
      protocolVersion: dex.version,
      v4PoolId: log.args.id,
      sender: log.args.sender,
      amount0Raw: requireBigint(log.args.amount0, "amount0").toString(),
      amount1Raw: requireBigint(log.args.amount1, "amount1").toString(),
      sqrtPriceX96: requireBigint(log.args.sqrtPriceX96, "sqrtPriceX96").toString(),
      liquidity: requireBigint(log.args.liquidity, "liquidity").toString(),
      tick: Number(log.args.tick),
      fee: Number(log.args.fee),
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      rawLog: log,
    }));
}

function mapPoolsByAddress(pools: IndexedPool[]) {
  return new Map(pools.filter((pool) => pool.address).map((pool) => [pool.address!.toLowerCase(), pool]));
}

function bigintDelta(amountIn: bigint | undefined, amountOut: bigint | undefined) {
  return (requireBigint(amountOut, "amountOut") - requireBigint(amountIn, "amountIn")).toString();
}

function requireBigint(value: bigint | undefined, field: string) {
  if (value === undefined) throw new Error(`Missing ${field} in swap log`);
  return value;
}

function minBlock(a: bigint, b: bigint) {
  return a < b ? a : b;
}

function maxLogBlockRange(chain: DexConfig["chain"]) {
  if (chain === "bsc") return 100;
  return 1_000;
}

if (process.argv[1]?.endsWith("ingestSwaps.ts") || process.argv[1]?.endsWith("ingestSwaps.js")) {
  ingestSwapsOnce()
    .then(async (results) => {
      for (const result of results) {
        console.log(`${result.dexKey}: ${result.fromBlock}-${result.toBlock}, indexed ${result.indexedSwaps} swaps`);
      }
      await closeDb();
    })
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exitCode = 1;
    });
}
