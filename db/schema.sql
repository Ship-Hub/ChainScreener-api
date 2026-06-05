-- PostgreSQL + TimescaleDB schema for chain-screener
-- Run via: npm run db:migrate

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ─── Core reference tables ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chains (
  id          SERIAL PRIMARY KEY,
  "key"       VARCHAR(32)  NOT NULL UNIQUE,
  name        VARCHAR(80)  NOT NULL,
  chain_id    INT          NOT NULL UNIQUE,
  native_symbol VARCHAR(16) NOT NULL,
  rpc_url     TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dexes (
  id               SERIAL PRIMARY KEY,
  chain_id         INT          NOT NULL REFERENCES chains(id),
  "key"            VARCHAR(80)  NOT NULL UNIQUE,
  name             VARCHAR(120) NOT NULL,
  protocol_version VARCHAR(16)  NOT NULL,
  factory_address  VARCHAR(42)  NOT NULL,
  event_name       VARCHAR(64)  NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, factory_address, protocol_version)
);

-- ─── Tokens ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tokens (
  id              BIGSERIAL PRIMARY KEY,
  chain_id        INT          NOT NULL REFERENCES chains(id),
  address         VARCHAR(42)  NOT NULL,
  symbol          VARCHAR(64)  NOT NULL DEFAULT 'UNKNOWN',
  name            VARCHAR(160) NOT NULL DEFAULT 'Unknown Token',
  decimals        INT          NOT NULL DEFAULT 18,
  total_supply    VARCHAR(78)  NULL,
  launch_platform VARCHAR(32)  NULL,
  lifecycle       VARCHAR(8)   NOT NULL DEFAULT 'hot',
  launched_at     TIMESTAMPTZ  NULL,
  last_activity_at TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, address)
);

CREATE INDEX IF NOT EXISTS idx_tokens_lifecycle_activity ON tokens (lifecycle, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_tokens_launch_platform ON tokens (launch_platform);

-- ─── Pools ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pools (
  id               BIGSERIAL PRIMARY KEY,
  chain_id         INT          NOT NULL REFERENCES chains(id),
  dex_id           INT          NOT NULL REFERENCES dexes(id),
  address          VARCHAR(42)  NULL,
  pool_id          VARCHAR(66)  NULL,
  protocol_version VARCHAR(16)  NOT NULL,
  token0_address   VARCHAR(42)  NOT NULL,
  token1_address   VARCHAR(42)  NOT NULL,
  fee              INT          NULL,
  tick_spacing     INT          NULL,
  hook_address     VARCHAR(42)  NULL,
  block_number     BIGINT       NOT NULL,
  tx_hash          VARCHAR(66)  NOT NULL,
  log_index        INT          NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, tx_hash, log_index),
  UNIQUE (chain_id, address),
  UNIQUE (chain_id, pool_id)
);

CREATE INDEX IF NOT EXISTS idx_pools_chain_block ON pools (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_pools_tokens ON pools (chain_id, token0_address, token1_address);

-- ─── Pool discovery events ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pool_discovery_events (
  id               BIGSERIAL PRIMARY KEY,
  chain_id         INT          NOT NULL REFERENCES chains(id),
  dex_id           INT          NOT NULL REFERENCES dexes(id),
  protocol_version VARCHAR(16)  NOT NULL,
  event_name       VARCHAR(64)  NOT NULL,
  raw_log          JSONB        NOT NULL,
  block_number     BIGINT       NOT NULL,
  tx_hash          VARCHAR(66)  NOT NULL,
  log_index        INT          NOT NULL,
  observed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_pool_events_block ON pool_discovery_events (chain_id, block_number);

-- ─── Swaps ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS swaps (
  id               BIGSERIAL PRIMARY KEY,
  chain_id         INT          NOT NULL REFERENCES chains(id),
  dex_id           INT          NOT NULL REFERENCES dexes(id),
  pool_id          BIGINT       NULL REFERENCES pools(id),
  protocol_version VARCHAR(16)  NOT NULL,
  pool_address     VARCHAR(42)  NULL,
  v4_pool_id       VARCHAR(66)  NULL,
  sender_address   VARCHAR(42)  NULL,
  recipient_address VARCHAR(42) NULL,
  amount0_raw      VARCHAR(96)  NOT NULL,
  amount1_raw      VARCHAR(96)  NOT NULL,
  sqrt_price_x96   VARCHAR(96)  NULL,
  liquidity        VARCHAR(96)  NULL,
  tick             INT          NULL,
  fee              INT          NULL,
  block_number     BIGINT       NOT NULL,
  tx_hash          VARCHAR(66)  NOT NULL,
  log_index        INT          NOT NULL,
  raw_log          JSONB        NOT NULL,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  observed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_swaps_pool_block ON swaps (pool_id, block_number);
CREATE INDEX IF NOT EXISTS idx_swaps_chain_block ON swaps (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_swaps_sender_block ON swaps (sender_address, block_number);
CREATE INDEX IF NOT EXISTS idx_swaps_recipient_block ON swaps (recipient_address, block_number);

-- ─── Token market stats (regular table, not hypertable) ──────────────────────

CREATE TABLE IF NOT EXISTS token_market_stats (
  id                   BIGSERIAL PRIMARY KEY,
  chain_id             INT            NOT NULL REFERENCES chains(id),
  token_address        VARCHAR(42)    NOT NULL,
  quote_address        VARCHAR(42)    NOT NULL,
  price_usd            NUMERIC(36,18) NOT NULL DEFAULT 0,
  price_change_24h_pct NUMERIC(18,8)  NOT NULL DEFAULT 0,
  volume_24h_usd       NUMERIC(36,6)  NOT NULL DEFAULT 0,
  swaps_24h            INT            NOT NULL DEFAULT 0,
  buys_24h             INT            NOT NULL DEFAULT 0,
  sells_24h            INT            NOT NULL DEFAULT 0,
  liquidity_usd        NUMERIC(36,6)  NOT NULL DEFAULT 0,
  last_swap_block      BIGINT         NOT NULL DEFAULT 0,
  last_tx_hash         VARCHAR(66)    NULL,
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, token_address)
);

CREATE INDEX IF NOT EXISTS idx_market_stats_volume ON token_market_stats (volume_24h_usd DESC);
CREATE INDEX IF NOT EXISTS idx_market_stats_updated ON token_market_stats (updated_at DESC);

-- ─── Swap prices (TimescaleDB hypertable) ────────────────────────────────────
-- Stores one row per priced swap — the raw material for OHLCV candles.

CREATE TABLE IF NOT EXISTS swap_prices (
  id            BIGSERIAL,
  occurred_at   TIMESTAMPTZ    NOT NULL,
  chain_id      INT            NOT NULL,
  chain_key     TEXT           NOT NULL,
  token_address TEXT           NOT NULL,
  quote_address TEXT           NOT NULL,
  price_usd     NUMERIC(36,18),
  volume_usd    NUMERIC(36,6),
  is_buy        BOOLEAN,
  block_number  BIGINT,
  swap_id       BIGINT,
  PRIMARY KEY (id, occurred_at)
);

SELECT create_hypertable(
  'swap_prices',
  'occurred_at',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_swap_prices_token ON swap_prices (chain_id, token_address, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_swap_prices_swap_id ON swap_prices (swap_id);

-- ─── Continuous aggregate: 5-minute candles ──────────────────────────────────

CREATE MATERIALIZED VIEW token_candles_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', occurred_at) AS bucket,
  chain_id,
  chain_key,
  token_address,
  quote_address,
  first(price_usd, occurred_at)  AS open_usd,
  MAX(price_usd)                 AS high_usd,
  MIN(price_usd)                 AS low_usd,
  last(price_usd, occurred_at)   AS close_usd,
  SUM(volume_usd)                AS volume_usd,
  COUNT(*)                       AS swap_count
FROM swap_prices
GROUP BY bucket, chain_id, chain_key, token_address, quote_address
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'token_candles_5m',
  start_offset => INTERVAL '1 day',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE
);

-- ─── Continuous aggregate: 1-hour candles (built from 5m) ───────────────────

CREATE MATERIALIZED VIEW token_candles_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', bucket)    AS bucket,
  chain_id,
  chain_key,
  token_address,
  quote_address,
  first(open_usd, bucket)          AS open_usd,
  MAX(high_usd)                    AS high_usd,
  MIN(low_usd)                     AS low_usd,
  last(close_usd, bucket)          AS close_usd,
  SUM(volume_usd)                  AS volume_usd,
  SUM(swap_count)                  AS swap_count
FROM token_candles_5m
GROUP BY time_bucket('1 hour', bucket), chain_id, chain_key, token_address, quote_address
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'token_candles_1h',
  start_offset => INTERVAL '2 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes',
  if_not_exists => TRUE
);

-- ─── Token transfers ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS token_transfers (
  id            BIGSERIAL PRIMARY KEY,
  chain_id      INT         NOT NULL REFERENCES chains(id),
  token_address VARCHAR(42) NOT NULL,
  from_address  VARCHAR(42) NOT NULL,
  to_address    VARCHAR(42) NOT NULL,
  amount_raw    VARCHAR(96) NOT NULL,
  block_number  BIGINT      NOT NULL,
  tx_hash       VARCHAR(66) NOT NULL,
  log_index     INT         NOT NULL,
  raw_log       JSONB       NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_transfers_token_block ON token_transfers (chain_id, token_address, block_number);
CREATE INDEX IF NOT EXISTS idx_transfers_from_block ON token_transfers (from_address, block_number);
CREATE INDEX IF NOT EXISTS idx_transfers_to_block ON token_transfers (to_address, block_number);

-- ─── Holder balances ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS holder_balances (
  id                  BIGSERIAL PRIMARY KEY,
  chain_id            INT         NOT NULL REFERENCES chains(id),
  token_address       VARCHAR(42) NOT NULL,
  wallet_address      VARCHAR(42) NOT NULL,
  balance_raw         VARCHAR(96) NOT NULL DEFAULT '0',
  last_activity_block BIGINT      NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, token_address, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_holder_token_balance ON holder_balances (chain_id, token_address, balance_raw);
CREATE INDEX IF NOT EXISTS idx_holder_wallet ON holder_balances (wallet_address);

-- ─── Holder snapshots ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS holder_snapshots (
  id                       BIGSERIAL PRIMARY KEY,
  chain_id                 INT            NOT NULL REFERENCES chains(id),
  token_address            VARCHAR(42)    NOT NULL,
  holder_count             INT            NOT NULL DEFAULT 0,
  top_10_concentration_pct NUMERIC(12,6)  NOT NULL DEFAULT 0,
  captured_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_holder_snapshots_token_time ON holder_snapshots (chain_id, token_address, captured_at DESC);

-- ─── Token alerts ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS token_alerts (
  id            BIGSERIAL PRIMARY KEY,
  chain_id      INT            NOT NULL REFERENCES chains(id),
  token_address VARCHAR(42)    NOT NULL,
  alert_type    VARCHAR(64)    NOT NULL,
  severity      VARCHAR(16)    NOT NULL DEFAULT 'info',
  title         VARCHAR(160)   NOT NULL,
  detail        TEXT           NOT NULL,
  signal_value  NUMERIC(36,8)  NULL,
  status        VARCHAR(16)    NOT NULL DEFAULT 'open',
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ    NULL,
  UNIQUE (chain_id, token_address, alert_type, status)
);

CREATE INDEX IF NOT EXISTS idx_token_alerts_status_time ON token_alerts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_alerts_severity ON token_alerts (severity, created_at DESC);

-- ─── Wallet funding graph ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_funding_edges (
  id               BIGSERIAL PRIMARY KEY,
  chain_id         INT            NOT NULL REFERENCES chains(id),
  from_address     VARCHAR(42)    NOT NULL,
  to_address       VARCHAR(42)    NOT NULL,
  token_address    VARCHAR(42)    NULL,
  amount_raw       VARCHAR(96)    NOT NULL DEFAULT '0',
  first_seen_block BIGINT         NOT NULL,
  last_seen_block  BIGINT         NOT NULL,
  transfer_count   INT            NOT NULL DEFAULT 1,
  confidence       NUMERIC(5,4)   NOT NULL DEFAULT 0.5,
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, from_address, to_address, token_address)
);

CREATE INDEX IF NOT EXISTS idx_funding_from ON wallet_funding_edges (from_address, last_seen_block DESC);
CREATE INDEX IF NOT EXISTS idx_funding_to ON wallet_funding_edges (to_address, last_seen_block DESC);

-- ─── Indexer cursors ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS indexer_cursors (
  id          BIGSERIAL PRIMARY KEY,
  chain_key   VARCHAR(32) NOT NULL,
  dex_key     VARCHAR(80) NOT NULL,
  worker_name VARCHAR(80) NOT NULL,
  last_block  BIGINT      NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_key, dex_key, worker_name)
);

-- ─── Smart wallets ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS smart_wallets (
  id                  BIGSERIAL PRIMARY KEY,
  address             VARCHAR(42)    NOT NULL UNIQUE,
  score               INT            NOT NULL DEFAULT 0,
  total_volume_usd    NUMERIC(36,6)  NOT NULL DEFAULT 0,
  total_trades        INT            NOT NULL DEFAULT 0,
  tokens_traded       INT            NOT NULL DEFAULT 0,
  chains_active       INT            NOT NULL DEFAULT 1,
  win_rate_pct        NUMERIC(5,2)   NOT NULL DEFAULT 0,
  realized_pnl_usd    NUMERIC(36,6)  NOT NULL DEFAULT 0,
  early_entry_pct     NUMERIC(5,2)   NOT NULL DEFAULT 0,
  profitable_trades   INT            NOT NULL DEFAULT 0,
  total_closed_trades INT            NOT NULL DEFAULT 0,
  first_seen_at       TIMESTAMPTZ    NULL,
  last_seen_at        TIMESTAMPTZ    NULL,
  computed_at         TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_smart_wallet_score ON smart_wallets (score DESC);

-- ─── Indexer runs ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS indexer_runs (
  id              BIGSERIAL PRIMARY KEY,
  worker_name     VARCHAR(80)  NOT NULL,
  chain_key       VARCHAR(32)  NOT NULL,
  dex_key         VARCHAR(80)  NOT NULL,
  from_block      BIGINT       NOT NULL,
  to_block        BIGINT       NOT NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'running',
  discovered_pools INT         NOT NULL DEFAULT 0,
  error           TEXT         NULL,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ  NULL
);

CREATE INDEX IF NOT EXISTS idx_indexer_runs_worker_time ON indexer_runs (worker_name, started_at);
