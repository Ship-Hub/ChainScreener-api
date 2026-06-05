import type { FastifyInstance } from "fastify";
import { getRetentionPolicy, getWalletTrackingPolicy, shouldRehydrate, walletTierPriority, type WalletTrackingTier } from "../services/retention.js";
import type { TokenLifecycle } from "../types/token.js";

const lifecycleValues = ["hot", "warm", "cold"] as const;

export async function registerRetentionRoutes(app: FastifyInstance) {
  app.get("/api/retention/policy", async () => ({
    data: {
      walletTierPriority,
      lifecycles: lifecycleValues.map((lifecycle) => getRetentionPolicy(lifecycle)),
      rehydrationTriggers: ["token_became_active", "wallet_interacted", "top_50_holder", "smart_wallet_promoted", "watchlist_added"],
    },
  }));

  app.get("/api/retention/policy/:lifecycle", async (request, reply) => {
    const { lifecycle } = request.params as { lifecycle: string };
    if (!isLifecycle(lifecycle)) return reply.code(404).send({ error: "Lifecycle policy not found" });
    return { data: getRetentionPolicy(lifecycle) };
  });

  app.get("/api/retention/wallet-tier/:tier", async (request, reply) => {
    const { tier } = request.params as { tier: string };
    const query = request.query as { lifecycle?: string; rehydrationReason?: string };
    const lifecycle = query.lifecycle ?? "hot";
    if (!isWalletTier(tier)) return reply.code(404).send({ error: "Wallet tier policy not found" });
    if (!isLifecycle(lifecycle)) return reply.code(400).send({ error: "Invalid lifecycle" });

    return {
      data: {
        ...getWalletTrackingPolicy(tier, lifecycle),
        rehydrate: query.rehydrationReason ? shouldRehydrate(query.rehydrationReason) : false,
      },
    };
  });
}

function isLifecycle(value: string): value is TokenLifecycle {
  return lifecycleValues.includes(value as TokenLifecycle);
}

function isWalletTier(value: string): value is WalletTrackingTier {
  return walletTierPriority.includes(value as WalletTrackingTier);
}
