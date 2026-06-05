import { getDb } from "../db/postgres.js";

export async function getWalletFundingAnalysis(address: string, limit = 30) {
  const sql = getDb();
  const addr = address.toLowerCase();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));

  const incoming = await sql`
    SELECT chains."key" AS chain,
           from_address AS "fromAddress",
           to_address AS "toAddress",
           token_address AS "tokenAddress",
           amount_raw AS "amountRaw",
           transfer_count AS "transferCount",
           confidence,
           first_seen_block AS "firstSeenBlock",
           last_seen_block AS "lastSeenBlock"
    FROM wallet_funding_edges
    JOIN chains ON chains.id = wallet_funding_edges.chain_id
    WHERE to_address = ${addr}
    ORDER BY confidence DESC, last_seen_block DESC
    LIMIT ${safeLimit}
  `;

  const outgoing = await sql`
    SELECT chains."key" AS chain,
           from_address AS "fromAddress",
           to_address AS "toAddress",
           token_address AS "tokenAddress",
           amount_raw AS "amountRaw",
           transfer_count AS "transferCount",
           confidence,
           first_seen_block AS "firstSeenBlock",
           last_seen_block AS "lastSeenBlock"
    FROM wallet_funding_edges
    JOIN chains ON chains.id = wallet_funding_edges.chain_id
    WHERE from_address = ${addr}
    ORDER BY confidence DESC, last_seen_block DESC
    LIMIT ${safeLimit}
  `;

  return {
    address: addr,
    incoming,
    outgoing,
    likelyFunders: incoming.slice(0, 5),
    likelyFundedWallets: outgoing.slice(0, 5),
  };
}

export async function getWalletGraph(address: string) {
  const sql = getDb();
  const addr = address.toLowerCase();
  const funding = await getWalletFundingAnalysis(addr, 20);

  const coTraders = await sql`
    SELECT
      other.wallet AS address,
      COUNT(*) AS "sharedPools",
      MAX(other.block_number) AS "lastSharedBlock"
    FROM (
      SELECT pool_id, block_number
      FROM swaps
      WHERE (sender_address = ${addr} OR recipient_address = ${addr}) AND pool_id IS NOT NULL
      ORDER BY block_number DESC
      LIMIT 250
    ) mine
    JOIN (
      SELECT pool_id, block_number, COALESCE(recipient_address, sender_address) AS wallet
      FROM swaps
      WHERE pool_id IS NOT NULL
    ) other ON other.pool_id = mine.pool_id
    WHERE other.wallet IS NOT NULL AND other.wallet != ${addr}
    GROUP BY other.wallet
    ORDER BY COUNT(*) DESC, MAX(other.block_number) DESC
    LIMIT 25
  `;

  const nodes = new Map<string, { id: string; label: string; type: string; weight: number }>();
  nodes.set(addr, { id: addr, label: shortAddress(addr), type: "wallet", weight: 10 });

  const edges: Array<{ from: string; to: string; type: string; weight: number; confidence?: number }> = [];
  for (const edge of [...funding.incoming, ...funding.outgoing]) {
    const from = edge.fromAddress as string;
    const to = edge.toAddress as string;
    nodes.set(from, { id: from, label: shortAddress(from), type: "funding", weight: Number(edge.transferCount) });
    nodes.set(to, { id: to, label: shortAddress(to), type: "funding", weight: Number(edge.transferCount) });
    edges.push({ from, to, type: "funding", weight: Number(edge.transferCount), confidence: Number(edge.confidence) });
  }
  for (const row of coTraders) {
    const walletAddr = row.address as string;
    nodes.set(walletAddr, { id: walletAddr, label: shortAddress(walletAddr), type: "co-trader", weight: Number(row.sharedPools) });
    edges.push({ from: addr, to: walletAddr, type: "shared-pool", weight: Number(row.sharedPools) });
  }

  return {
    address: addr,
    nodes: Array.from(nodes.values()),
    edges,
  };
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
