import { getDb } from "../db/postgres.js";

export async function getIndexerStatus() {
  const sql = getDb();
  const cursors = await sql`
    SELECT chain_key AS "chainKey", dex_key AS "dexKey", worker_name AS "workerName",
           last_block AS "lastBlock", updated_at AS "updatedAt"
    FROM indexer_cursors
    ORDER BY chain_key, dex_key
  `;
  const runs = await sql`
    SELECT worker_name AS "workerName", chain_key AS "chainKey", dex_key AS "dexKey",
           from_block AS "fromBlock", to_block AS "toBlock", status,
           discovered_pools AS "discoveredPools", error,
           started_at AS "startedAt", finished_at AS "finishedAt"
    FROM indexer_runs
    ORDER BY started_at DESC
    LIMIT 20
  `;

  return {
    cursors,
    recentRuns: runs,
  };
}

export async function getRecentDiscoveredPools(limit = 24) {
  const sql = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await sql`
    SELECT
      chains."key"              AS chain,
      dexes."key"               AS "dexKey",
      dexes.name                AS "dexName",
      pools.protocol_version    AS "protocolVersion",
      pools.address             AS "poolAddress",
      pools.pool_id             AS "poolId",
      pools.token0_address      AS token0,
      pools.token1_address      AS token1,
      t0.symbol                 AS "token0Symbol",
      t0.name                   AS "token0Name",
      t1.symbol                 AS "token1Symbol",
      t1.name                   AS "token1Name",
      pools.fee,
      pools.tick_spacing        AS "tickSpacing",
      pools.hook_address        AS "hookAddress",
      pools.block_number        AS "blockNumber",
      pools.tx_hash             AS "txHash",
      pools.created_at          AS "discoveredAt"
    FROM pools
    JOIN chains ON chains.id = pools.chain_id
    JOIN dexes  ON dexes.id  = pools.dex_id
    LEFT JOIN tokens t0 ON t0.chain_id = pools.chain_id AND t0.address = pools.token0_address
    LEFT JOIN tokens t1 ON t1.chain_id = pools.chain_id AND t1.address = pools.token1_address
    ORDER BY pools.block_number DESC, pools.id DESC
    LIMIT ${safeLimit}
  `;

  return rows;
}

export async function getRecentIndexedSwaps(limit = 24) {
  const sql = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await sql`
    SELECT
      chains."key"              AS chain,
      dexes."key"               AS "dexKey",
      dexes.name                AS "dexName",
      swaps.protocol_version    AS "protocolVersion",
      swaps.pool_address        AS "poolAddress",
      swaps.v4_pool_id          AS "poolId",
      pools.token0_address      AS token0,
      pools.token1_address      AS token1,
      t0.symbol                 AS "token0Symbol",
      t0.name                   AS "token0Name",
      t1.symbol                 AS "token1Symbol",
      t1.name                   AS "token1Name",
      swaps.sender_address      AS sender,
      swaps.recipient_address   AS recipient,
      swaps.amount0_raw         AS "amount0Raw",
      swaps.amount1_raw         AS "amount1Raw",
      swaps.tick,
      swaps.fee,
      swaps.block_number        AS "blockNumber",
      swaps.tx_hash             AS "txHash",
      swaps.observed_at         AS "observedAt"
    FROM swaps
    JOIN chains ON chains.id = swaps.chain_id
    JOIN dexes  ON dexes.id  = swaps.dex_id
    LEFT JOIN pools ON pools.id = swaps.pool_id
    LEFT JOIN tokens t0 ON t0.chain_id = swaps.chain_id AND t0.address = pools.token0_address
    LEFT JOIN tokens t1 ON t1.chain_id = swaps.chain_id AND t1.address = pools.token1_address
    ORDER BY swaps.block_number DESC, swaps.id DESC
    LIMIT ${safeLimit}
  `;

  return rows;
}
