import { isChainKey, type ChainKey } from "../config/chains.js";
import { getDb } from "../db/postgres.js";

export async function getTokenHolderSummary(chain: string, address: string) {
  if (!isChainKey(chain)) return undefined;
  const sql = getDb();

  const summaryRows = await sql`
    SELECT holder_count AS "holderCount",
           top_10_concentration_pct AS "top10ConcentrationPct",
           captured_at AS "capturedAt"
    FROM holder_snapshots
    JOIN chains ON chains.id = holder_snapshots.chain_id
    WHERE chains."key" = ${chain}
      AND holder_snapshots.token_address = ${address.toLowerCase()}
    ORDER BY captured_at DESC
    LIMIT 1
  `;

  const topRows = await sql`
    SELECT wallet_address AS wallet,
           balance_raw AS "balanceRaw",
           last_activity_block AS "lastActivityBlock"
    FROM holder_balances
    JOIN chains ON chains.id = holder_balances.chain_id
    WHERE chains."key" = ${chain}
      AND holder_balances.token_address = ${address.toLowerCase()}
      AND CAST(balance_raw AS NUMERIC(65,0)) > 0
    ORDER BY CAST(balance_raw AS NUMERIC(65,0)) DESC
    LIMIT 50
  `;

  return {
    chain,
    address: address.toLowerCase(),
    summary: summaryRows[0] ?? { holderCount: topRows.length, top10ConcentrationPct: 0, capturedAt: null },
    topHolders: topRows,
  };
}

export async function listHolderSnapshots(chain?: ChainKey | "all") {
  const sql = getDb();

  const rows = chain && chain !== "all"
    ? await sql`
        SELECT chains."key" AS chain,
               holder_snapshots.token_address AS "tokenAddress",
               holder_snapshots.holder_count AS "holderCount",
               holder_snapshots.top_10_concentration_pct AS "top10ConcentrationPct",
               holder_snapshots.captured_at AS "capturedAt"
        FROM holder_snapshots
        JOIN chains ON chains.id = holder_snapshots.chain_id
        WHERE chains."key" = ${chain}
        ORDER BY holder_snapshots.captured_at DESC
        LIMIT 100
      `
    : await sql`
        SELECT chains."key" AS chain,
               holder_snapshots.token_address AS "tokenAddress",
               holder_snapshots.holder_count AS "holderCount",
               holder_snapshots.top_10_concentration_pct AS "top10ConcentrationPct",
               holder_snapshots.captured_at AS "capturedAt"
        FROM holder_snapshots
        JOIN chains ON chains.id = holder_snapshots.chain_id
        ORDER BY holder_snapshots.captured_at DESC
        LIMIT 100
      `;

  return rows;
}
