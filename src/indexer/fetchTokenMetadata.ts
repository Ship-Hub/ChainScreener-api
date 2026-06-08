import type { Address } from "viem";
import { closeDb, getDb } from "../db/postgres.js";
import { runMigration } from "../db/migrate.js";
import { getRpcClient } from "./rpc.js";
import type { ChainKey } from "../config/chains.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BATCH_SIZE = 50;

const erc20Abi = [
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

type UnresolvedToken = { chainKey: ChainKey; address: string };

export async function fetchTokenMetadataOnce() {
  await runMigration();
  const sql = getDb();

  // ── Fix native/well-known tokens that can't be resolved via ERC20 multicall ─
  // These addresses are excluded from the main loop below, so we handle them here.
  await sql`
    UPDATE tokens
    SET symbol = 'ETH', name = 'Ethereum', decimals = 18, updated_at = NOW()
    WHERE address = ${ZERO_ADDRESS} AND (symbol IS NULL OR symbol = 'UNKNOWN')
  `;
  await sql`
    UPDATE tokens
    SET symbol = 'WETH', name = 'Wrapped Ether', decimals = 18, updated_at = NOW()
    WHERE address IN (
      '0x4200000000000000000000000000000000000006',
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
    ) AND (symbol IS NULL OR symbol = 'UNKNOWN')
  `;
  await sql`
    UPDATE tokens
    SET symbol = 'WBNB', name = 'Wrapped BNB', decimals = 18, updated_at = NOW()
    WHERE address = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' AND (symbol IS NULL OR symbol = 'UNKNOWN')
  `;

  const rows = await sql<UnresolvedToken[]>`
    SELECT chains."key" AS "chainKey", tokens.address
    FROM tokens
    JOIN chains ON chains.id = tokens.chain_id
    WHERE (tokens.symbol IS NULL OR tokens.symbol = 'UNKNOWN')
      AND tokens.address != ${ZERO_ADDRESS}
    ORDER BY tokens.updated_at DESC
    LIMIT 500
  `;

  const byChain = new Map<ChainKey, string[]>();
  for (const row of rows) {
    const list = byChain.get(row.chainKey) ?? [];
    list.push(row.address);
    byChain.set(row.chainKey, list);
  }

  let updated = 0;
  for (const [chain, addresses] of byChain.entries()) {
    updated += await fetchChainMetadata(chain, addresses);
  }

  return { checked: rows.length, updated };
}

async function fetchChainMetadata(chain: ChainKey, addresses: string[]) {
  const sql = getDb();
  const client = getRpcClient(chain);
  let updated = 0;

  const chainRows = await sql`SELECT id FROM chains WHERE "key" = ${chain}`;
  const chainId = chainRows[0]?.id as number | undefined;
  if (!chainId) return 0;

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);
    const calls = batch.flatMap((address) => [
      { address: address as Address, abi: erc20Abi, functionName: "name" as const },
      { address: address as Address, abi: erc20Abi, functionName: "symbol" as const },
      { address: address as Address, abi: erc20Abi, functionName: "decimals" as const },
      { address: address as Address, abi: erc20Abi, functionName: "totalSupply" as const },
    ]);

    let results: Array<{ status: "success" | "failure"; result?: unknown }>;
    try {
      results = await client.multicall({ contracts: calls, allowFailure: true });
    } catch (error) {
      console.warn(`Multicall failed for batch on ${chain}:`, error instanceof Error ? error.message : error);
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const address = batch[j];
      if (!address) continue;
      const nameRes = results[j * 4];
      const symbolRes = results[j * 4 + 1];
      const decimalsRes = results[j * 4 + 2];
      const supplyRes = results[j * 4 + 3];

      const name = nameRes?.status === "success" ? String(nameRes.result).slice(0, 160) : null;
      const symbol = symbolRes?.status === "success" ? String(symbolRes.result).slice(0, 64) : null;
      const decimals = decimalsRes?.status === "success" ? Number(decimalsRes.result) : null;
      const totalSupply = supplyRes?.status === "success" ? String(supplyRes.result) : null;

      if (!name && !symbol) continue;

      // Build update dynamically — only set non-null fields
      if (name && symbol && decimals !== null && totalSupply !== null) {
        await sql`UPDATE tokens SET name = ${name}, symbol = ${symbol}, decimals = ${decimals}, total_supply = ${totalSupply}, updated_at = NOW() WHERE chain_id = ${Number(chainId)} AND address = ${address.toLowerCase()}`;
      } else if (name && symbol && decimals !== null) {
        await sql`UPDATE tokens SET name = ${name}, symbol = ${symbol}, decimals = ${decimals}, updated_at = NOW() WHERE chain_id = ${Number(chainId)} AND address = ${address.toLowerCase()}`;
      } else if (name && symbol) {
        await sql`UPDATE tokens SET name = ${name}, symbol = ${symbol}, updated_at = NOW() WHERE chain_id = ${Number(chainId)} AND address = ${address.toLowerCase()}`;
      } else if (symbol) {
        await sql`UPDATE tokens SET symbol = ${symbol}, updated_at = NOW() WHERE chain_id = ${Number(chainId)} AND address = ${address.toLowerCase()}`;
      } else if (name) {
        await sql`UPDATE tokens SET name = ${name}, updated_at = NOW() WHERE chain_id = ${Number(chainId)} AND address = ${address.toLowerCase()}`;
      }
      updated++;
    }
  }

  return updated;
}

if (process.argv[1]?.endsWith("fetchTokenMetadata.ts") || process.argv[1]?.endsWith("fetchTokenMetadata.js")) {
  fetchTokenMetadataOnce()
    .then(async ({ checked, updated }) => {
      console.log(`Checked ${checked} tokens, updated metadata for ${updated}.`);
      await closeDb();
    })
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exitCode = 1;
    });
}
