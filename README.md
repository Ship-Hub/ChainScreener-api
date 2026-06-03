# Chain Screener API

Fastify API for the Chain Screener launch intelligence dashboard.

## Local

```bash
npm install
copy .env.example .env
npm run dev
```

Health check:

```bash
curl http://localhost:4000/health
```

## Build

```bash
npm run build
npm start
```

## Docker

```bash
copy .env.example .env
docker compose up -d --build
```

The MVP currently serves seeded Phase 1 intelligence data while the indexer workers are staged under `src/indexer`.
