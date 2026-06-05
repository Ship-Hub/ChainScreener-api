import type { FastifyInstance } from "fastify";
import { isChainKey } from "../config/chains.js";
import { getMarketCandles, listMarketTokens, type TokenSortOrder } from "../services/market.js";

export async function registerMarketRoutes(app: FastifyInstance) {
  // Main token list — supports ?chain=base&sort=volume|gainers|losers
  app.get("/api/market/tokens", async (request, reply) => {
    try {
      const query = request.query as { chain?: string; sort?: string };
      if (query.chain && query.chain !== "all" && !isChainKey(query.chain))
        return reply.code(400).send({ error: "Invalid chain" });

      const chain = query.chain === "all" || (query.chain && isChainKey(query.chain))
        ? query.chain
        : undefined;

      const sort = (["volume", "gainers", "losers"].includes(query.sort ?? "")
        ? query.sort
        : "volume") as TokenSortOrder;

      return { data: await listMarketTokens(chain, sort) };
    } catch (error) {
      return reply.code(503).send({
        error: "Market data is not available",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Convenience endpoint — top gainers
  app.get("/api/market/gainers", async (request, reply) => {
    try {
      const query = request.query as { chain?: string };
      const chain = query.chain === "all" || (query.chain && isChainKey(query.chain))
        ? query.chain
        : undefined;
      return { data: await listMarketTokens(chain, "gainers") };
    } catch (error) {
      return reply.code(503).send({
        error: "Market data is not available",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Candles for a specific token
  app.get("/api/market/tokens/:chain/:address/candles", async (request, reply) => {
    try {
      const { chain, address } = request.params as { chain: string; address: string };
      const query = request.query as { interval?: string };
      if (!isChainKey(chain)) return reply.code(400).send({ error: "Invalid chain" });
      return { data: await getMarketCandles(chain, address, query.interval ?? "5m") };
    } catch (error) {
      return reply.code(503).send({
        error: "Market candles are not available",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
