CREATE TABLE IF NOT EXISTS chains (
  id INT AUTO_INCREMENT PRIMARY KEY,
  `key` VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  chain_id INT NOT NULL UNIQUE,
  native_symbol VARCHAR(16) NOT NULL,
  rpc_url TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dexes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  `key` VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  protocol_version VARCHAR(16) NOT NULL,
  factory_address VARCHAR(42) NOT NULL,
  event_name VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_dexes_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  UNIQUE KEY uq_dex_chain_factory_version (chain_id, factory_address, protocol_version)
);

CREATE TABLE IF NOT EXISTS tokens (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  address VARCHAR(42) NOT NULL,
  symbol VARCHAR(64) NOT NULL DEFAULT 'UNKNOWN',
  name VARCHAR(160) NOT NULL DEFAULT 'Unknown Token',
  decimals INT NOT NULL DEFAULT 18,
  lifecycle ENUM('hot', 'warm', 'cold') NOT NULL DEFAULT 'hot',
  launched_at TIMESTAMP NULL,
  last_activity_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_tokens_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  UNIQUE KEY uq_tokens_chain_address (chain_id, address),
  KEY idx_tokens_lifecycle_activity (lifecycle, last_activity_at)
);

CREATE TABLE IF NOT EXISTS pools (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  dex_id INT NOT NULL,
  address VARCHAR(42) NULL,
  pool_id VARCHAR(66) NULL,
  protocol_version VARCHAR(16) NOT NULL,
  token0_address VARCHAR(42) NOT NULL,
  token1_address VARCHAR(42) NOT NULL,
  fee INT NULL,
  tick_spacing INT NULL,
  hook_address VARCHAR(42) NULL,
  block_number BIGINT NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  log_index INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pools_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  CONSTRAINT fk_pools_dex FOREIGN KEY (dex_id) REFERENCES dexes(id),
  UNIQUE KEY uq_pool_log (chain_id, tx_hash, log_index),
  UNIQUE KEY uq_pool_address (chain_id, address),
  UNIQUE KEY uq_pool_id (chain_id, pool_id),
  KEY idx_pools_chain_block (chain_id, block_number),
  KEY idx_pools_tokens (chain_id, token0_address, token1_address)
);

CREATE TABLE IF NOT EXISTS pool_discovery_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  dex_id INT NOT NULL,
  protocol_version VARCHAR(16) NOT NULL,
  event_name VARCHAR(64) NOT NULL,
  raw_log JSON NOT NULL,
  block_number BIGINT NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  log_index INT NOT NULL,
  observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_pool_events_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  CONSTRAINT fk_pool_events_dex FOREIGN KEY (dex_id) REFERENCES dexes(id),
  UNIQUE KEY uq_pool_event_log (chain_id, tx_hash, log_index),
  KEY idx_pool_events_block (chain_id, block_number)
);

CREATE TABLE IF NOT EXISTS swaps (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  dex_id INT NOT NULL,
  pool_id BIGINT NULL,
  protocol_version VARCHAR(16) NOT NULL,
  pool_address VARCHAR(42) NULL,
  v4_pool_id VARCHAR(66) NULL,
  sender_address VARCHAR(42) NULL,
  recipient_address VARCHAR(42) NULL,
  amount0_raw VARCHAR(96) NOT NULL,
  amount1_raw VARCHAR(96) NOT NULL,
  sqrt_price_x96 VARCHAR(96) NULL,
  liquidity VARCHAR(96) NULL,
  tick INT NULL,
  fee INT NULL,
  block_number BIGINT NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  log_index INT NOT NULL,
  raw_log JSON NOT NULL,
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_swaps_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  CONSTRAINT fk_swaps_dex FOREIGN KEY (dex_id) REFERENCES dexes(id),
  CONSTRAINT fk_swaps_pool FOREIGN KEY (pool_id) REFERENCES pools(id),
  UNIQUE KEY uq_swap_log (chain_id, tx_hash, log_index),
  KEY idx_swaps_pool_block (pool_id, block_number),
  KEY idx_swaps_chain_block (chain_id, block_number),
  KEY idx_swaps_sender_block (sender_address, block_number)
);

CREATE TABLE IF NOT EXISTS token_market_stats (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  quote_address VARCHAR(42) NOT NULL,
  price_usd DECIMAL(36,18) NOT NULL DEFAULT 0,
  price_change_24h_pct DECIMAL(18,8) NOT NULL DEFAULT 0,
  volume_24h_usd DECIMAL(36,6) NOT NULL DEFAULT 0,
  swaps_24h INT NOT NULL DEFAULT 0,
  buys_24h INT NOT NULL DEFAULT 0,
  sells_24h INT NOT NULL DEFAULT 0,
  last_swap_block BIGINT NOT NULL DEFAULT 0,
  last_tx_hash VARCHAR(66) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_market_stats_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  UNIQUE KEY uq_market_stats_token (chain_id, token_address),
  KEY idx_market_stats_volume (volume_24h_usd DESC),
  KEY idx_market_stats_updated (updated_at DESC)
);

CREATE TABLE IF NOT EXISTS token_candles (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  interval_name VARCHAR(8) NOT NULL,
  opened_at TIMESTAMP NOT NULL,
  open_usd DECIMAL(36,18) NOT NULL,
  high_usd DECIMAL(36,18) NOT NULL,
  low_usd DECIMAL(36,18) NOT NULL,
  close_usd DECIMAL(36,18) NOT NULL,
  volume_usd DECIMAL(36,6) NOT NULL DEFAULT 0,
  swap_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_token_candles_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  UNIQUE KEY uq_token_candle (chain_id, token_address, interval_name, opened_at),
  KEY idx_token_candles_lookup (chain_id, token_address, interval_name, opened_at DESC)
);

CREATE TABLE IF NOT EXISTS token_transfers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  from_address VARCHAR(42) NOT NULL,
  to_address VARCHAR(42) NOT NULL,
  amount_raw VARCHAR(96) NOT NULL,
  block_number BIGINT NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  log_index INT NOT NULL,
  raw_log JSON NOT NULL,
  observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_token_transfers_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  UNIQUE KEY uq_token_transfer_log (chain_id, tx_hash, log_index),
  KEY idx_transfers_token_block (chain_id, token_address, block_number),
  KEY idx_transfers_from_block (from_address, block_number),
  KEY idx_transfers_to_block (to_address, block_number)
);

CREATE TABLE IF NOT EXISTS holder_balances (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  wallet_address VARCHAR(42) NOT NULL,
  balance_raw VARCHAR(96) NOT NULL DEFAULT '0',
  last_activity_block BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_holder_balances_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  UNIQUE KEY uq_holder_balance (chain_id, token_address, wallet_address),
  KEY idx_holder_token_balance (chain_id, token_address, balance_raw),
  KEY idx_holder_wallet (wallet_address)
);

CREATE TABLE IF NOT EXISTS holder_snapshots (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  holder_count INT NOT NULL DEFAULT 0,
  top_10_concentration_pct DECIMAL(12,6) NOT NULL DEFAULT 0,
  captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_holder_snapshots_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  KEY idx_holder_snapshots_token_time (chain_id, token_address, captured_at DESC)
);

CREATE TABLE IF NOT EXISTS token_alerts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  alert_type VARCHAR(64) NOT NULL,
  severity ENUM('info', 'watch', 'warning', 'critical') NOT NULL DEFAULT 'info',
  title VARCHAR(160) NOT NULL,
  detail TEXT NOT NULL,
  signal_value DECIMAL(36,8) NULL,
  status ENUM('open', 'acknowledged', 'resolved') NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP NULL,
  CONSTRAINT fk_token_alerts_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  UNIQUE KEY uq_token_alert_window (chain_id, token_address, alert_type, status),
  KEY idx_token_alerts_status_time (status, created_at DESC),
  KEY idx_token_alerts_severity (severity, created_at DESC)
);

CREATE TABLE IF NOT EXISTS wallet_funding_edges (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_id INT NOT NULL,
  from_address VARCHAR(42) NOT NULL,
  to_address VARCHAR(42) NOT NULL,
  token_address VARCHAR(42) NULL,
  amount_raw VARCHAR(96) NOT NULL DEFAULT '0',
  first_seen_block BIGINT NOT NULL,
  last_seen_block BIGINT NOT NULL,
  transfer_count INT NOT NULL DEFAULT 1,
  confidence DECIMAL(5,4) NOT NULL DEFAULT 0.5,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_wallet_funding_edges_chain FOREIGN KEY (chain_id) REFERENCES chains(id),
  UNIQUE KEY uq_funding_edge (chain_id, from_address, to_address, token_address),
  KEY idx_funding_from (from_address, last_seen_block DESC),
  KEY idx_funding_to (to_address, last_seen_block DESC)
);

CREATE TABLE IF NOT EXISTS indexer_cursors (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  chain_key VARCHAR(32) NOT NULL,
  dex_key VARCHAR(80) NOT NULL,
  worker_name VARCHAR(80) NOT NULL,
  last_block BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_indexer_cursor (chain_key, dex_key, worker_name)
);

CREATE TABLE IF NOT EXISTS smart_wallets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  address VARCHAR(42) NOT NULL,
  score INT NOT NULL DEFAULT 0,
  total_volume_usd DECIMAL(36,6) NOT NULL DEFAULT 0,
  total_trades INT NOT NULL DEFAULT 0,
  tokens_traded INT NOT NULL DEFAULT 0,
  chains_active INT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMP NULL,
  last_seen_at TIMESTAMP NULL,
  computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_smart_wallet_address (address),
  KEY idx_smart_wallet_score (score DESC)
);

CREATE TABLE IF NOT EXISTS indexer_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  worker_name VARCHAR(80) NOT NULL,
  chain_key VARCHAR(32) NOT NULL,
  dex_key VARCHAR(80) NOT NULL,
  from_block BIGINT NOT NULL,
  to_block BIGINT NOT NULL,
  status ENUM('running', 'success', 'failed') NOT NULL DEFAULT 'running',
  discovered_pools INT NOT NULL DEFAULT 0,
  error TEXT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  KEY idx_indexer_runs_worker_time (worker_name, started_at)
);
