import type { FastifyInstance } from "fastify";
import { getIndexerStatus, getRecentDiscoveredPools, getRecentIndexedSwaps } from "../services/indexerStatus.js";

export async function registerIndexerRoutes(app: FastifyInstance) {
  app.get("/api/indexer/status", async (_request, reply) => {
    try {
      return { data: await getIndexerStatus() };
    } catch (error) {
      return reply.code(503).send({
        error: "Indexer database is not available",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/indexer/pools", async (request, reply) => {
    try {
      const query = request.query as { limit?: string };
      return { data: await getRecentDiscoveredPools(Number(query.limit ?? 24)) };
    } catch (error) {
      return reply.code(503).send({
        error: "Indexer database is not available",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/api/indexer/swaps", async (request, reply) => {
    try {
      const query = request.query as { limit?: string };
      return { data: await getRecentIndexedSwaps(Number(query.limit ?? 24)) };
    } catch (error) {
      return reply.code(503).send({
        error: "Indexer database is not available",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
