import type { FastifyInstance } from "fastify";
import {
  getSmartMoneyFeed,
  getSmartMoneyLeaderboard,
  getSmartMoneyFlow,
  getSmartMoneyConsensus,
  getSmartMoneyMetrics,
} from "../services/smartMoneyService.js";

export async function registerSmartMoneyRoutes(app: FastifyInstance) {
  app.get("/api/smart-money/feed", async (request) => {
    const q = request.query as { hours?: string; limit?: string };
    const hours = Math.min(168, Math.max(1, parseInt(q.hours ?? "24", 10) || 24));
    const limit = Math.min(50, Math.max(1, parseInt(q.limit ?? "20", 10) || 20));
    const data = await getSmartMoneyFeed(hours, limit);
    return { data };
  });

  app.get("/api/smart-money/leaderboard", async (request) => {
    const q = request.query as { limit?: string; hours?: string };
    const limit = Math.min(50, Math.max(1, parseInt(q.limit ?? "20", 10) || 20));
    const hours = Math.min(168, Math.max(0, parseInt(q.hours ?? "0", 10) || 0));
    const data = await getSmartMoneyLeaderboard(limit, hours);
    return { data };
  });

  app.get("/api/smart-money/flow", async (request) => {
    const q = request.query as { hours?: string };
    const hours = Math.min(168, Math.max(1, parseInt(q.hours ?? "24", 10) || 24));
    const data = await getSmartMoneyFlow(hours);
    return { data };
  });

  app.get("/api/smart-money/consensus", async (request) => {
    const q = request.query as { hours?: string };
    const hours = Math.min(168, Math.max(1, parseInt(q.hours ?? "24", 10) || 24));
    const data = await getSmartMoneyConsensus(hours);
    return { data };
  });

  app.get("/api/smart-money/metrics", async (request) => {
    const q = request.query as { hours?: string };
    const hours = Math.min(168, Math.max(1, parseInt(q.hours ?? "24", 10) || 24));
    const data = await getSmartMoneyMetrics(hours);
    return { data };
  });
}
