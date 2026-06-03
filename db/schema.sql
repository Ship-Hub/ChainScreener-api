CREATE TABLE IF NOT EXISTS chains (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  chain_id INTEGER UNIQUE NOT NULL,
  native_symbol TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dexes (
  id SERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  factory_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS launch_platforms (
  id SERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  matcher TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tokens (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  launch_platform_id INTEGER REFERENCES launch_platforms(id),
  lifecycle TEXT NOT NULL DEFAULT 'hot',
  launched_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain_id, address)
);

CREATE TABLE IF NOT EXISTS token_metadata (
  token_id BIGINT PRIMARY KEY REFERENCES tokens(id) ON DELETE CASCADE,
  logo_url TEXT,
  description TEXT,
  website_url TEXT,
  source JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pools (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  dex_id INTEGER NOT NULL REFERENCES dexes(id),
  address TEXT NOT NULL,
  base_token_address TEXT NOT NULL,
  quote_token_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dex_id, address)
);

CREATE TABLE IF NOT EXISTS swaps (
  id BIGSERIAL PRIMARY KEY,
  pool_id BIGINT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  side TEXT NOT NULL,
  token_amount NUMERIC NOT NULL,
  usd_amount NUMERIC NOT NULL,
  price_usd NUMERIC NOT NULL,
  block_number BIGINT NOT NULL,
  tx_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS liquidity_events (
  id BIGSERIAL PRIMARY KEY,
  pool_id BIGINT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  event_type TEXT NOT NULL,
  usd_amount NUMERIC NOT NULL,
  tx_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS transfers (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  token_amount NUMERIC NOT NULL,
  tx_hash TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS holders (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  balance NUMERIC NOT NULL,
  share_pct NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token_id, wallet_address)
);

CREATE TABLE IF NOT EXISTS holder_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  holder_count INTEGER NOT NULL,
  top_holder_concentration NUMERIC NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  address TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  labels TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (chain_id, address)
);

CREATE TABLE IF NOT EXISTS wallet_token_positions (
  id BIGSERIAL PRIMARY KEY,
  wallet_id BIGINT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  total_bought_usd NUMERIC NOT NULL DEFAULT 0,
  total_sold_usd NUMERIC NOT NULL DEFAULT 0,
  average_entry_usd NUMERIC NOT NULL DEFAULT 0,
  current_holdings NUMERIC NOT NULL DEFAULT 0,
  realized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
  unrealized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
  roi_pct NUMERIC NOT NULL DEFAULT 0,
  first_buy_at TIMESTAMPTZ,
  last_sell_at TIMESTAMPTZ,
  UNIQUE (wallet_id, token_id)
);

CREATE TABLE IF NOT EXISTS wallet_funding_links (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  funder_address TEXT NOT NULL,
  funded_address TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  confidence NUMERIC NOT NULL DEFAULT 0.5
);

CREATE TABLE IF NOT EXISTS candles (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  interval TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume_usd NUMERIC NOT NULL,
  UNIQUE (token_id, interval, opened_at)
);

CREATE TABLE IF NOT EXISTS risk_scores (
  token_id BIGINT PRIMARY KEY REFERENCES tokens(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  level TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_flags (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  flag_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS social_links (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS x_posts (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL,
  UNIQUE (token_id, post_id)
);

CREATE TABLE IF NOT EXISTS trending_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_id BIGINT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  score NUMERIC NOT NULL,
  signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_swaps_pool_time ON swaps (pool_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_candles_token_interval_time ON candles (token_id, interval, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_lifecycle_activity ON tokens (lifecycle, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_trending_snapshots_time ON trending_snapshots (captured_at DESC);
