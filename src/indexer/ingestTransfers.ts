import { type Address } from "viem";
import type { ChainKey } from "../config/chains.js";
import { closeDb, getDb } from "../db/postgres.js";
import { runMigration } from "../db/migrate.js";
import { env } from "../shared/env.js";
import { erc20TransferAbi } from "./protocolEvents.js";
import { getRpcClient } from "./rpc.js";
import { getCursor, setCursor } from "./repository.js";

type ActiveToken = {
  chainId: number | string;
  chainKey: ChainKey;
  tokenAddress: string;
};

const workerName = "transfer-ingestion";
const zeroAddress = "0x0000000000000000000000000000000000000000";

export async function ingestTransfersOnce() {
  await runMigration();
  const sql = getDb();

  const tokens = await sql<ActiveToken[]>`
    SELECT chains.id AS "chainId", chains."key" AS "chainKey", token_market_stats.token_address AS "tokenAddress"
    FROM token_market_stats
    JOIN chains ON chains.id = token_market_stats.chain_id
    ORDER BY token_market_stats.volume_24h_usd DESC
    LIMIT 150
  `;

  const byChain = new Map<ChainKey, ActiveToken[]>();
  for (const token of tokens) {
    byChain.set(token.chainKey, [...(byChain.get(token.chainKey) ?? []), token]);
  }

  const results = [];
  for (const [chainKey, chainTokens] of byChain.entries()) {
    results.push(await ingestChainTransfers(chainKey, chainTokens));
  }

  return results;
}

async function ingestChainTransfers(chainKey: ChainKey, tokens: ActiveToken[]) {
  const sql = getDb();
  const client = getRpcClient(chainKey);
  const latestBlock = await client.getBlockNumber();
  const safeLatestBlock = latestBlock > BigInt(env.INDEXER_CONFIRMATIONS)
    ? latestBlock - BigInt(env.INDEXER_CONFIRMATIONS)
    : latestBlock;
  const cursor = await getCursor(chainKey, "_transfers", workerName);
  const lookbackStart = safeLatestBlock > 2_000n ? safeLatestBlock - 2_000n : 0n;
  const fromBlock = cursor ? cursor + 1n : lookbackStart;
  const pageSize = chainKey === "bsc" ? 100 : Math.min(env.INDEXER_BLOCK_PAGE_SIZE, 500);
  const toBlock = minBlock(fromBlock + BigInt(pageSize - 1), safeLatestBlock);

  if (fromBlock > toBlock || tokens.length === 0) {
    return { chainKey, fromBlock, toBlock: safeLatestBlock, transfers: 0 };
  }

  const logs = await client.getLogs({
    address: tokens.map((token) => token.tokenAddress as Address),
    event: erc20TransferAbi[0],
    fromBlock,
    toBlock,
  });

  const tokenByAddress = new Map(tokens.map((token) => [token.tokenAddress.toLowerCase(), token]));
  let transfers = 0;

  for (const log of logs) {
    const token = tokenByAddress.get(log.address.toLowerCase());
    if (!token || !log.args.from || !log.args.to || log.args.value === undefined) continue;

    const from = log.args.from.toLowerCase();
    const to = log.args.to.toLowerCase();
    const amount = log.args.value.toString();
    const rawLogJson = JSON.stringify(log, (_key, value) => (typeof value === "bigint" ? value.toString() : value));

    await sql`
      INSERT INTO token_transfers (
        chain_id, token_address, from_address, to_address, amount_raw,
        block_number, tx_hash, log_index, raw_log
      )
      VALUES (
        ${Number(token.chainId)}, ${log.address.toLowerCase()},
        ${from}, ${to}, ${amount},
        ${log.blockNumber.toString()}, ${log.transactionHash},
        ${Number(log.logIndex)}, ${rawLogJson}
      )
      ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
    `;

    if (from !== zeroAddress) await applyBalanceDelta(Number(token.chainId), log.address, from, -log.args.value, log.blockNumber);
    if (to !== zeroAddress) await applyBalanceDelta(Number(token.chainId), log.address, to, log.args.value, log.blockNumber);
    if (from !== zeroAddress && to !== zeroAddress) {
      await upsertFundingEdge(Number(token.chainId), log.address, from, to, amount, log.blockNumber);
    }
    transfers += 1;
  }

  await snapshotHolders(tokens.map((token) => ({ chainId: Number(token.chainId), tokenAddress: token.tokenAddress })));
  await setCursor(chainKey, "_transfers", workerName, toBlock);
  return { chainKey, fromBlock, toBlock, transfers };
}

async function applyBalanceDelta(
  chainId: number,
  tokenAddress: string,
  walletAddress: string,
  delta: bigint,
  blockNumber: bigint,
) {
  const sql = getDb();
  // PostgreSQL doesn't have MySQL's DECIMAL arithmetic on varchar — store as numeric string.
  // We do a read-modify-write here for correctness (BIGINT arithmetic on text is risky at scale).
  await sql`
    INSERT INTO holder_balances (chain_id, token_address, wallet_address, balance_raw, last_activity_block)
    VALUES (${chainId}, ${tokenAddress.toLowerCase()}, ${walletAddress.toLowerCase()}, ${delta.toString()}, ${blockNumber.toString()})
    ON CONFLICT (chain_id, token_address, wallet_address) DO UPDATE
      SET balance_raw = (CAST(holder_balances.balance_raw AS NUMERIC) + ${delta.toString()}::NUMERIC)::TEXT,
          last_activity_block = GREATEST(holder_balances.last_activity_block, ${blockNumber.toString()}::BIGINT)
  `;
}

async function upsertFundingEdge(
  chainId: number,
  tokenAddress: string,
  from: string,
  to: string,
  amount: string,
  blockNumber: bigint,
) {
  const sql = getDb();
  await sql`
    INSERT INTO wallet_funding_edges (
      chain_id, from_address, to_address, token_address,
      amount_raw, first_seen_block, last_seen_block, transfer_count, confidence
    )
    VALUES (${chainId}, ${from}, ${to}, ${tokenAddress.toLowerCase()}, ${amount}, ${blockNumber.toString()}, ${blockNumber.toString()}, 1, 0.55)
    ON CONFLICT (chain_id, from_address, to_address, token_address) DO UPDATE
      SET amount_raw      = (CAST(wallet_funding_edges.amount_raw AS NUMERIC) + ${amount}::NUMERIC)::TEXT,
          last_seen_block = GREATEST(wallet_funding_edges.last_seen_block, ${blockNumber.toString()}::BIGINT),
          transfer_count  = wallet_funding_edges.transfer_count + 1,
          confidence      = LEAST(0.95, wallet_funding_edges.confidence + 0.05)
  `;
}

async function snapshotHolders(tokens: Array<{ chainId: number; tokenAddress: string }>) {
  const sql = getDb();
  for (const token of tokens) {
    const rows = await sql`
      SELECT COUNT(*) AS "holderCount"
      FROM holder_balances
      WHERE chain_id = ${token.chainId}
        AND token_address = ${token.tokenAddress.toLowerCase()}
        AND CAST(balance_raw AS NUMERIC) > 0
    `;
    await sql`
      INSERT INTO holder_snapshots (chain_id, token_address, holder_count, top_10_concentration_pct)
      VALUES (${token.chainId}, ${token.tokenAddress.toLowerCase()}, ${Number(rows[0]?.holderCount ?? 0)}, 0)
    `;
  }
}

function minBlock(a: bigint, b: bigint) {
  return a < b ? a : b;
}

if (process.argv[1]?.endsWith("ingestTransfers.ts") || process.argv[1]?.endsWith("ingestTransfers.js")) {
  ingestTransfersOnce()
    .then(async (results) => {
      for (const result of results) {
        console.log(`${result.chainKey}: ${result.fromBlock}-${result.toBlock}, indexed ${result.transfers} transfers`);
      }
      await closeDb();
    })
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exitCode = 1;
    });
}
