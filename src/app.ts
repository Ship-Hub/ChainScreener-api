import cors from "@fastify/cors";
import Fastify from "fastify";
import { env } from "./shared/env.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerTrendingRoutes } from "./routes/trending.js";
import { registerLaunchRoutes } from "./routes/launches.js";
import { registerWalletRoutes } from "./routes/wallets.js";
import { registerRetentionRoutes } from "./routes/retention.js";
import { registerIndexerRoutes } from "./routes/indexer.js";
import { registerMarketRoutes } from "./routes/market.js";
import { registerSmartMoneyRoutes } from "./routes/smartMoney.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerHolderRoutes } from "./routes/holders.js";
import { registerLiveRoutes } from "./routes/live.js";

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: env.FRONTEND_ORIGIN === "*" ? true : env.FRONTEND_ORIGIN.split(","),
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "chain-screener-api",
  }));

  await registerTokenRoutes(app);
  await registerTrendingRoutes(app);
  await registerLaunchRoutes(app);
  await registerWalletRoutes(app);
  await registerRetentionRoutes(app);
  await registerIndexerRoutes(app);
  await registerMarketRoutes(app);
  await registerSmartMoneyRoutes(app);
  await registerAlertRoutes(app);
  await registerHolderRoutes(app);
  await registerLiveRoutes(app);

  return app;
}
