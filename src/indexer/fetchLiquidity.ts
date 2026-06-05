import { parseAbi } from "viem";
import type { ChainKey } from "../config/chains.js";
import { getDb, closeDb } from "../db/postgres.js";
import { stablecoins } from "./quoteAssets.js";
import { getRpcClient } from "./rpc.js";

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const MULTICALL_CHUNK = 120; // calls per multicall batch (2 per pool → 60 pools per batch)

type PoolRow = {
  poolAddress: string;
  chainId: number | string;
  chainKey: ChainKey;
  token0: string;
  token1: string;
  decimals0: number | string;
  decimals1: number | string;
};

type PriceRow = {
  chainId: number | string;
  tokenAddress: string;
  priceUsd: string;
};

const STABLECOIN_PRICE_BY_KEY = new Map(
  stablecoins.map((sc) => [`${sc.chain}:${sc.address.toLowerCase()}`, 1.0]),
);

function normalizeBalance(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const scale = BigInt(10 ** Math.min(decimals, 9));
  const whole = raw / BigInt(10 ** decimals);
  const frac = Number((raw % BigInt(10 ** decimals)) / scale) / 10 ** (decimals - Math.min(decimals, 9));
  return Number(whole) + frac;
}

export async function fetchLiquidityOnce(): Promise<{ updated: number }> {
  const sql = getDb();

  const pools = await sql<PoolRow[]>`
    SELECT
      p.address        AS "poolAddress",
      p.chain_id       AS "chainId",
      chains."key"     AS "chainKey",
      p.token0_address AS token0,
      p.token1_address AS token1,
      COALESCE(t0.decimals, 18) AS decimals0,
      COALESCE(t1.decimals, 18) AS decimals1
    FROM pools p
    JOIN chains ON chains.id = p.chain_id
    LEFT JOIN tokens t0 ON t0.chain_id = p.chain_id AND t0.address = p.token0_address
    LEFT JOIN tokens t1 ON t1.chain_id = p.chain_id AND t1.address = p.token1_address
    WHERE p.address IS NOT NULL
    LIMIT 300
  `;

  const priceRows = await sql<PriceRow[]>`
    SELECT chain_id AS "chainId", token_address AS "tokenAddress", price_usd::text AS "priceUsd"
    FROM token_market_stats
    WHERE price_usd > 0
  `;

  const tmsPriceMap = new Map<string, number>();
  for (const row of priceRows) {
    tmsPriceMap.set(`${Number(row.chainId)}:${(row.tokenAddress as string).toLowerCase()}`, Number(row.priceUsd));
  }

  const getPrice = (chainId: number, chainKey: ChainKey, address: string): number => {
    const addr = address.toLowerCase();
    return (
      tmsPriceMap.get(`${chainId}:${addr}`) ??
      STABLECOIN_PRICE_BY_KEY.get(`${chainKey}:${addr}`) ??
      0
    );
  };

  const byChain = new Map<ChainKey, PoolRow[]>();
  for (const pool of pools) {
    const arr = byChain.get(pool.chainKey) ?? [];
    arr.push(pool);
    byChain.set(pool.chainKey, arr);
  }

  const tvlByToken = new Map<string, number>();

  for (const [chainKey, chainPools] of byChain) {
    const client = getRpcClient(chainKey);

    const allCalls = chainPools.flatMap((pool) => [
      {
        address: pool.token0 as `0x${string}`,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf" as const,
        args: [pool.poolAddress as `0x${string}`] as const,
      },
      {
        address: pool.token1 as `0x${string}`,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf" as const,
        args: [pool.poolAddress as `0x${string}`] as const,
      },
    ]);

    for (let offset = 0; offset < allCalls.length; offset += MULTICALL_CHUNK) {
      const chunk = allCalls.slice(offset, offset + MULTICALL_CHUNK);
      const chunkPools = chainPools.slice(offset / 2, (offset + MULTICALL_CHUNK) / 2);

      let results: { result?: bigint; error?: Error }[] = [];
      try {
        results = (await client.multicall({
          contracts: chunk,
          allowFailure: true,
        })) as { result?: bigint; error?: Error }[];
      } catch {
        continue;
      }

      for (let i = 0; i < chunkPools.length; i++) {
        const pool = chunkPools[i];
        if (!pool) continue;
        const r0 = results[i * 2];
        const r1 = results[i * 2 + 1];
        if (!r0 || !r1) continue;

        const bal0 = r0.result !== undefined ? normalizeBalance(r0.result, Number(pool.decimals0)) : 0;
        const bal1 = r1.result !== undefined ? normalizeBalance(r1.result, Number(pool.decimals1)) : 0;
        const p0 = getPrice(Number(pool.chainId), chainKey, pool.token0);
        const p1 = getPrice(Number(pool.chainId), chainKey, pool.token1);

        const tvl = bal0 * p0 + bal1 * p1;
        if (tvl <= 0) continue;

        for (const addr of [pool.token0, pool.token1]) {
          const key = `${Number(pool.chainId)}:${addr.toLowerCase()}`;
          tvlByToken.set(key, (tvlByToken.get(key) ?? 0) + tvl);
        }
      }
    }
  }

  if (tvlByToken.size === 0) return { updated: 0 };

  let updated = 0;
  for (const [key, tvl] of tvlByToken) {
    const colonIdx = key.indexOf(":");
    const chainId = Number(key.slice(0, colonIdx));
    const tokenAddress = key.slice(colonIdx + 1);
    const result = await sql`
      UPDATE token_market_stats
      SET liquidity_usd = ${tvl.toFixed(6)}
      WHERE chain_id = ${chainId} AND token_address = ${tokenAddress}
    `;
    if (result.count > 0) updated++;
  }

  return { updated };
}

// Standalone runner
if (process.argv[1]?.endsWith("fetchLiquidity.ts") || process.argv[1]?.endsWith("fetchLiquidity.js")) {
  fetchLiquidityOnce()
    .then(async (r) => {
      console.log(`Liquidity: ${r.updated} tokens updated`);
      await closeDb();
    })
    .catch(async (e) => {
      console.error(e);
      await closeDb();
      process.exitCode = 1;
    });
}
