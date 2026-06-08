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

  const results = await Promise.all(
    [...byChain.entries()].map(([chainKey, chainTokens]) =>
      ingestChainTransfers(chainKey, chainTokens).catch((err) => {
        console.warn(`[ingestTransfers] ${chainKey} failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
        return { chainKey, fromBlock: 0n, toBlock: 0n, transfers: 0 };
      }),
    ),
  );

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

  // Collect data in memory for batch SQL operations
  const transferRows: Array<{
    chain_id: number;
    token_address: string;
    from_address: string;
    to_address: string;
    amount_raw: string;
    block_number: string;
    tx_hash: string;
    log_index: number;
    raw_log: string;
  }> = [];

  const balanceDeltas = new Map<string, { delta: bigint; block: bigint }>();
  const fundingEdges = new Map<string, { amount: bigint; firstBlock: bigint; lastBlock: bigint; count: number }>();

  let transfers = 0;
  for (const log of logs) {
    const token = tokenByAddress.get(log.address.toLowerCase());
    if (!token || !log.args.from || !log.args.to || log.args.value === undefined) continue;

    const from = log.args.from.toLowerCase();
    const to = log.args.to.toLowerCase();
    const amount = log.args.value;
    const chainId = Number(token.chainId);
    const tokenAddr = log.address.toLowerCase();

    transferRows.push({
      chain_id: chainId,
      token_address: tokenAddr,
      from_address: from,
      to_address: to,
      amount_raw: amount.toString(),
      block_number: log.blockNumber.toString(),
      tx_hash: log.transactionHash,
      log_index: Number(log.logIndex),
      raw_log: JSON.stringify(log, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    });

    if (from !== zeroAddress) {
      const k = `${chainId}:${tokenAddr}:${from}`;
      const e = balanceDeltas.get(k) ?? { delta: 0n, block: 0n };
      balanceDeltas.set(k, { delta: e.delta - amount, block: e.block > log.blockNumber ? e.block : log.blockNumber });
    }
    if (to !== zeroAddress) {
      const k = `${chainId}:${tokenAddr}:${to}`;
      const e = balanceDeltas.get(k) ?? { delta: 0n, block: 0n };
      balanceDeltas.set(k, { delta: e.delta + amount, block: e.block > log.blockNumber ? e.block : log.blockNumber });
    }
    if (from !== zeroAddress && to !== zeroAddress) {
      const k = `${chainId}:${tokenAddr}:${from}:${to}`;
      const e = fundingEdges.get(k);
      if (e) {
        e.amount += amount;
        e.lastBlock = e.lastBlock > log.blockNumber ? e.lastBlock : log.blockNumber;
        e.count += 1;
      } else {
        fundingEdges.set(k, { amount, firstBlock: log.blockNumber, lastBlock: log.blockNumber, count: 1 });
      }
    }
    transfers += 1;
  }

  // Batch 1: INSERT token_transfers
  if (transferRows.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < transferRows.length; i += BATCH_SIZE) {
      await sql`INSERT INTO token_transfers ${sql(transferRows.slice(i, i + BATCH_SIZE))} ON CONFLICT DO NOTHING`;
    }
  }

  // Batch 2: UPSERT holder_balances
  if (balanceDeltas.size > 0) {
    const BATCH_SIZE = 500;
    const rows = [...balanceDeltas.entries()].map(([key, { delta, block }]) => {
      const [chainId, tokenAddr, walletAddr] = key.split(':');
      return {
        chain_id: Number(chainId),
        token_address: tokenAddr,
        wallet_address: walletAddr,
        balance_raw: delta.toString(),
        last_activity_block: Number(block),
      };
    });
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      await sql`
        INSERT INTO holder_balances ${sql(chunk)}
        ON CONFLICT (chain_id, token_address, wallet_address) DO UPDATE
          SET balance_raw = (CAST(holder_balances.balance_raw AS NUMERIC) + CAST(EXCLUDED.balance_raw AS NUMERIC))::TEXT,
              last_activity_block = GREATEST(holder_balances.last_activity_block, EXCLUDED.last_activity_block::BIGINT)
      `;
    }
  }

  // Batch 3: UPSERT wallet_funding_edges
  if (fundingEdges.size > 0) {
    const BATCH_SIZE = 500;
    const rows = [...fundingEdges.entries()].map(([key, { amount, firstBlock, lastBlock, count }]) => {
      const [chainId, tokenAddr, from, to] = key.split(':');
      return {
        chain_id: Number(chainId),
        from_address: from,
        to_address: to,
        token_address: tokenAddr,
        amount_raw: amount.toString(),
        first_seen_block: Number(firstBlock),
        last_seen_block: Number(lastBlock),
        transfer_count: count,
        confidence: count * 0.05,
      };
    });
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      await sql`
        INSERT INTO wallet_funding_edges ${sql(chunk)}
        ON CONFLICT (chain_id, from_address, to_address, token_address) DO UPDATE
          SET amount_raw = (CAST(wallet_funding_edges.amount_raw AS NUMERIC) + CAST(EXCLUDED.amount_raw AS NUMERIC))::TEXT,
              last_seen_block = GREATEST(wallet_funding_edges.last_seen_block, EXCLUDED.last_seen_block::BIGINT),
              transfer_count = wallet_funding_edges.transfer_count + EXCLUDED.transfer_count,
              confidence = LEAST(0.95, wallet_funding_edges.confidence + EXCLUDED.confidence)
      `;
    }
  }

  await snapshotHolders(tokens.map((token) => ({ chainId: Number(token.chainId), tokenAddress: token.tokenAddress })));
  await setCursor(chainKey, "_transfers", workerName, toBlock);
  return { chainKey, fromBlock, toBlock, transfers };
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
