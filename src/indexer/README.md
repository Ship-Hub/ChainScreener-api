Phase 1 indexer modules belong here.

Planned workers:
- Factory event discovery for Base Uniswap V3 and Aerodrome pools.
- Launch-source heuristics for Clanker and Bankr.
- Swap/liquidity ingestion for discovered hot tokens only.
- Candle pre-aggregation jobs backed by MySQL initially, with TimescaleDB still an option if candle volume demands it later.
- Hot/warm/cold lifecycle archival jobs.

Current live-data foundation:
- MySQL stores discovered chains, DEX deployments, tokens, pools, raw discovery logs, and worker cursors.
- `npm run db:migrate` creates/seeds the local MySQL schema.
- `npm run indexer:discover` scans recent confirmed blocks for Uniswap V2 `PairCreated`, Uniswap V3 `PoolCreated`, and Uniswap V4 `Initialize` events.
- Public RPC defaults are provided for Base, Ethereum, and BNB. They are development-only and should be replaced before large backfills.

Next workers:
- Swap ingestion for discovered Hot pools.
- ERC-20 transfer ingestion for holder balances and top-holder snapshots.
- Token metadata enrichment for symbol, name, decimals, and launch-source detection.

## Wallet P&L retention strategy

Do not calculate and retain full P&L history for every wallet on every token. Indexers should assign each wallet/token pair to the highest applicable tier:

1. `smart_wallet`: always full P&L, full transaction history, and full performance metrics.
2. `top_holder`: full tracking for the current top 50 holders of active tokens.
3. `watched_wallet`: full tracking for user-added wallets.
4. `active_wallet`: full tracking only while interacting with Hot tokens.
5. `cold_wallet`: summary-only retention.

Cold wallet summaries keep wallet address, token address, current balance, realized P&L summary, unrealized P&L summary, ROI summary, and last activity timestamp. Detailed position events and trade-by-trade calculations can be deleted after the summary is persisted.

Rehydrate a wallet/token position when the token becomes active again, the wallet interacts again, the wallet becomes a top 50 holder, the wallet is promoted to the smart wallet list, or a user adds it to a watchlist. Rehydration should restore full tracking, rebuild the position from retained chain data or fresh RPC/indexer reads, and write a `wallet_tracking_events` row.

## Lifecycle retention jobs

Hot tokens:
- Keep full wallet tracking for smart wallets, top 50 holders, watched wallets, and active wallets.
- Keep all swaps and transfers.

Warm tokens:
- Keep full wallet tracking only for smart wallets, top 50 holders, and watched wallets.
- Keep only the most recent 30 days of transfers.
- Keep recent swaps and compress older swaps into `swap_aggregates`.

Cold tokens:
- Delete detailed wallet position history and trade-level calculations after summary fields are retained in `wallet_token_positions`.
- Delete detailed transfers.
- Delete detailed swaps after retaining total volume, total buys, total sells, ATH volume, and daily candle history.

Always retain current holder balances, daily holder snapshots, top 50 holder snapshots, holder count history, and holder growth metrics.

## Candle retention

- `1m`: 7 days
- `5m`: 30 days
- `15m`: 60 days
- `1h`: 180 days
- `4h`: indefinitely
- `1d`: indefinitely
