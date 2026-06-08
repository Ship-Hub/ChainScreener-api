import { closeDb } from "../db/postgres.js";
import { env } from "../shared/env.js";
import { discoverPoolsOnce, backfillMissingPoolTimestamps } from "./discoverPools.js";
import { fetchTokenMetadataOnce } from "./fetchTokenMetadata.js";
import { ingestSwapsOnce } from "./ingestSwaps.js";
import { aggregateMarketOnce } from "./aggregateMarket.js";
import { fetchLiquidityOnce } from "./fetchLiquidity.js";
import { computeSmartWalletsOnce } from "./computeSmartWallets.js";
import { ingestTransfersOnce } from "./ingestTransfers.js";
import { generateAlertsOnce } from "../services/alerts.js";

let running = false;

export async function startIndexerLoop(log?: (msg: string) => void) {
  const info = log ?? console.log;
  const warn = (msg: string) => (log ? log(msg) : console.warn(msg));

  info("[indexer] Loop started — polling every " + env.INDEXER_POLL_INTERVAL_SECS + "s");

  while (true) {
    const cycleStart = Date.now();

    try {
      // 1. Discover new pools (fetches actual block timestamps for new pools)
      const poolResults = await discoverPoolsOnce();
      const newPools = poolResults.reduce((sum, r) => sum + r.discoveredPools, 0);
      if (newPools > 0) info(`[indexer] discover: +${newPools} pools`);
    } catch (error) {
      warn(`[indexer] discover error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // 1b. Backfill block_timestamp for pools discovered before this feature was added
      const backfilled = await backfillMissingPoolTimestamps();
      if (backfilled > 0) info(`[indexer] block-timestamp backfill: ${backfilled} pools updated`);
    } catch (error) {
      warn(`[indexer] block-timestamp backfill error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // 2. Fetch ERC20 metadata for newly discovered tokens
      const { checked, updated } = await fetchTokenMetadataOnce();
      if (updated > 0) info(`[indexer] metadata: ${updated}/${checked} tokens resolved`);
    } catch (error) {
      warn(`[indexer] metadata error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // 3. Ingest swaps from all discovered pools
      const swapResults = await ingestSwapsOnce();
      const newSwaps = swapResults.reduce((sum, r) => sum + r.indexedSwaps, 0);
      if (newSwaps > 0) info(`[indexer] swaps: +${newSwaps} indexed`);
    } catch (error) {
      warn(`[indexer] swaps error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // 4. Aggregate market stats + candles from swaps
      const { pricedSwaps, tokens, derivedNativePrices } = await aggregateMarketOnce();

      if (pricedSwaps > 0) {
        const nativeSummary = Object.entries(derivedNativePrices)
          .map(([k, v]) => `${k.split(":")[0]}=$${v.toFixed(0)}`)
          .join(" ");
        info(`[indexer] aggregate: ${pricedSwaps} swaps → ${tokens} tokens${nativeSummary ? " | " + nativeSummary : ""}`);
      }
    } catch (error) {
      warn(`[indexer] aggregate error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // 5. Fetch pool reserves via RPC to compute on-chain liquidity (TVL)
      const { updated: liquidityUpdated } = await fetchLiquidityOnce();
      if (liquidityUpdated > 0) info(`[indexer] liquidity: ${liquidityUpdated} tokens updated`);
    } catch (error) {
      warn(`[indexer] liquidity error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // 6. Ingest ERC20 transfers for live market tokens and update holder balances
      const transferResults = await ingestTransfersOnce();
      const newTransfers = transferResults.reduce((sum, r) => sum + r.transfers, 0);
      if (newTransfers > 0) info(`[indexer] transfers: +${newTransfers} indexed`);
    } catch (error) {
      warn(`[indexer] transfers error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // 7. Score and upsert smart wallets from accumulated swap data
      const { computed } = await computeSmartWalletsOnce();
      if (computed > 0) info(`[indexer] smart-wallets: ${computed} upserted`);
    } catch (error) {
      warn(`[indexer] smart-wallets error: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // 8. Generate open alerts from current market/holder/wallet signals
      const { created } = await generateAlertsOnce();
      if (created > 0) info(`[indexer] alerts: ${created} open signals updated`);
    } catch (error) {
      warn(`[indexer] alerts error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const elapsed = Math.round((Date.now() - cycleStart) / 1000);
    const sleep = Math.max(1, env.INDEXER_POLL_INTERVAL_SECS - elapsed);
    info(`[indexer] cycle completed in ${elapsed}s — next in ${sleep}s`);
    await new Promise((resolve) => setTimeout(resolve, sleep * 1000));
  }
}

// Standalone runner
if (process.argv[1]?.endsWith("indexerLoop.ts") || process.argv[1]?.endsWith("indexerLoop.js")) {
  process.on("SIGINT", async () => {
    console.log("\n[indexer] Shutting down...");
    await closeDb();
    process.exit(0);
  });

  startIndexerLoop().catch(async (error) => {
    console.error("[indexer] Fatal:", error);
    await closeDb();
    process.exitCode = 1;
  });
}
