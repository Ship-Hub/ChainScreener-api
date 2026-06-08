import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("postgresql://chain:chain@localhost:5432/chain_screener"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  BASE_RPC_URL: z.string().default("https://mainnet.base.org"),
  ETH_RPC_URL: z.string().default("https://ethereum-rpc.publicnode.com"),
  BSC_RPC_URL: z.string().default("https://bnb-mainnet.g.alchemy.com/public"),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(12),
  INDEXER_BLOCK_PAGE_SIZE: z.coerce.number().int().positive().max(5000).default(500),
  INDEXER_DISCOVERY_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(5000),
  ENABLE_INDEXER: z.coerce.boolean().default(false),
  INDEXER_POLL_INTERVAL_SECS: z.coerce.number().int().positive().default(30),
  LIVE_FEED_INTERVAL_MS: z.coerce.number().int().positive().min(1000).default(3000),
  ENABLE_X_FEED: z.coerce.boolean().default(false),
  X_API_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);
