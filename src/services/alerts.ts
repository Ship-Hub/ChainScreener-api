import { getDb } from "../db/postgres.js";

export async function generateAlertsOnce() {
  const sql = getDb();
  const tokens = await sql`
    SELECT
      tms.chain_id AS "chainId",
      chains."key" AS "chainKey",
      tms.token_address AS "tokenAddress",
      COALESCE(tokens.symbol, 'TKN' || RIGHT(tms.token_address, 4)) AS symbol,
      tms.price_change_24h_pct AS "priceChange24h",
      tms.volume_24h_usd AS "volume24hUsd",
      tms.liquidity_usd AS "liquidityUsd",
      tms.swaps_24h AS "swaps24h"
    FROM token_market_stats tms
    JOIN chains ON chains.id = tms.chain_id
    LEFT JOIN tokens ON tokens.chain_id = tms.chain_id AND tokens.address = tms.token_address
    ORDER BY tms.updated_at DESC
    LIMIT 100
  `;

  let created = 0;
  for (const token of tokens) {
    if (Number(token.priceChange24h) >= 25) {
      created += await upsertAlert(token, "price_momentum", "watch", `${token.symbol} momentum spike`, `Price moved ${Number(token.priceChange24h).toFixed(1)}% across the indexed window.`, Number(token.priceChange24h));
    }
    if (Number(token.swaps24h) >= 100) {
      created += await upsertAlert(token, "swap_activity", "info", `${token.symbol} swap activity rising`, `${token.swaps24h} swaps indexed for this token.`, Number(token.swaps24h));
    }
    if (Number(token.volume24hUsd) > 0 && Number(token.liquidityUsd) > 0 && Number(token.volume24hUsd) / Number(token.liquidityUsd) >= 2) {
      created += await upsertAlert(token, "volume_liquidity_ratio", "warning", `${token.symbol} high volume/liquidity ratio`, `Volume is more than 2x tracked liquidity.`, Number(token.volume24hUsd) / Number(token.liquidityUsd));
    }
  }

  return { checked: tokens.length, created };
}

export async function listAlerts(limit = 50) {
  const sql = getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await sql`
    SELECT
      token_alerts.id,
      chains."key" AS chain,
      token_alerts.token_address AS "tokenAddress",
      token_alerts.alert_type AS "alertType",
      token_alerts.severity,
      token_alerts.title,
      token_alerts.detail,
      token_alerts.signal_value AS "signalValue",
      token_alerts.status,
      token_alerts.created_at AS "createdAt"
    FROM token_alerts
    JOIN chains ON chains.id = token_alerts.chain_id
    WHERE token_alerts.status = 'open'
    ORDER BY token_alerts.created_at DESC
    LIMIT ${safeLimit}
  `;
  return rows;
}

export async function getAlertCounts() {
  const sql = getDb();
  const rows = await sql`
    SELECT severity, COUNT(*) AS count
    FROM token_alerts
    WHERE status = 'open'
    GROUP BY severity
  `;
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.severity as string] = Number(row.count);
    return acc;
  }, {});
}

async function upsertAlert(
  token: Record<string, unknown>,
  alertType: string,
  severity: string,
  title: string,
  detail: string,
  signalValue: number,
) {
  const sql = getDb();
  const result = await sql`
    INSERT INTO token_alerts (chain_id, token_address, alert_type, severity, title, detail, signal_value)
    VALUES (${token.chainId as number}, ${token.tokenAddress as string}, ${alertType}, ${severity}, ${title}, ${detail}, ${signalValue})
    ON CONFLICT (chain_id, token_address, alert_type, status) DO UPDATE
      SET severity     = EXCLUDED.severity,
          title        = EXCLUDED.title,
          detail       = EXCLUDED.detail,
          signal_value = EXCLUDED.signal_value
  `;
  return result.count > 0 ? 1 : 0;
}
