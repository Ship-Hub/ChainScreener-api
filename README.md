# Chain Screener API

[![CI](https://github.com/Ship-Hub/ChainScreener-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Ship-Hub/ChainScreener-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Fastify REST API powering the Chain Screener token launch intelligence dashboard. Indexes on-chain events (Uniswap V2/V3/V4 pair creation, swaps, token transfers) across Base, Ethereum, and BNB Chain and serves real-time market stats, smart-wallet analytics, and risk signals.

## Features

- Multi-chain indexer: Base, Ethereum, BNB Chain
- Uniswap V2 / V3 / V4 pool discovery and swap ingestion
- Smart wallet detection and P&L tracking
- Holder analysis and wallet retention tiers
- Token risk scoring and alert generation
- Token metadata enrichment
- BullMQ-backed background workers

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript
- **Framework**: Fastify 5
- **Queue**: BullMQ + Redis
- **Database**: PostgreSQL (production) / MySQL (local dev)
- **Validation**: Zod
- **Blockchain**: viem

## Prerequisites

- Node.js 20+
- PostgreSQL or MySQL
- Redis

## Quick Start

```bash
git clone https://github.com/Ship-Hub/ChainScreener-api.git
cd ChainScreener-api
npm install
cp .env.example .env   # edit values as needed
npm run db:migrate
npm run dev
```

Health check:

```bash
curl http://localhost:4000/health
```

## Environment Variables

Copy `.env.example` to `.env` and fill in your values. See [.env.example](.env.example) for all available options.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `mysql://root:@localhost:3306/chain_screener` | Database connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base chain RPC endpoint |
| `ETH_RPC_URL` | `https://eth.drpc.org` | Ethereum RPC endpoint |
| `BSC_RPC_URL` | `https://bnb-mainnet.g.alchemy.com/public` | BNB Chain RPC endpoint |
| `ENABLE_INDEXER` | `false` | Start background indexer on boot |
| `ENABLE_X_FEED` | `false` | Enable X/Twitter feed integration |
| `X_API_KEY` | — | X/Twitter API key (required if `ENABLE_X_FEED=true`) |

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript |
| `npm start` | Start compiled server |
| `npm run lint` | Run ESLint |
| `npm run db:migrate` | Run database migrations |
| `npm run indexer:discover` | Discover new pools |
| `npm run indexer:swaps` | Ingest swap events |
| `npm run indexer:aggregate` | Derive market stats and candles |
| `npm run indexer:metadata` | Fetch token metadata |
| `npm run indexer:loop` | Run full indexer loop |

## Docker

```bash
cp .env.example .env
docker compose up -d --build
```

## API Endpoints

```
GET  /health
GET  /api/market/tokens
GET  /api/indexer/status
GET  /api/indexer/pools
GET  /api/indexer/swaps
GET  /api/tokens/:address
GET  /api/launches
GET  /api/alerts
GET  /api/smart-money
GET  /api/holders/:address
GET  /api/wallets/:address
GET  /api/retention/policy
```

## Indexer Architecture

The indexer runs as BullMQ background workers and follows this pipeline:

1. **Discovery** (`indexer:discover`) — scans recent blocks for `PairCreated` / `PoolCreated` / `Initialize` events
2. **Swaps** (`indexer:swaps`) — ingests swap events for discovered pools
3. **Aggregate** (`indexer:aggregate`) — derives 5-minute candles and market stats from stablecoin-paired swaps
4. **Metadata** (`indexer:metadata`) — fetches token name, symbol, decimals, logo
5. **Alerts** (`indexer:alerts`) — generates risk signals and smart-wallet alerts
6. **Smart Wallets** (`indexer:smart-wallets`) — scores wallets by P&L and trade quality

Wallet retention is tiered: Smart Wallets and top 50 holders are tracked deeply; cold wallets retain summary P&L only. See [`src/indexer/README.md`](src/indexer/README.md) for full retention rules.

> Public RPCs are suitable for early development only. Use paid/dedicated RPC endpoints before high-volume backfills.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
