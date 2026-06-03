import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/chain_screener"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  BASE_RPC_URL: z.string().default("https://mainnet.base.org"),
  ETH_RPC_URL: z.string().default("https://ethereum-rpc.publicnode.com"),
  BSC_RPC_URL: z.string().default("https://bsc-dataseed.binance.org"),
  ENABLE_INDEXER: z.coerce.boolean().default(false),
  ENABLE_X_FEED: z.coerce.boolean().default(false),
  X_API_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);
