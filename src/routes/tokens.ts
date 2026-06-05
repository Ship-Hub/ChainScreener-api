import type { FastifyInstance } from "fastify";
import { isChainKey } from "../config/chains.js";
import { getMarketCandles, listMarketTokens } from "../services/market.js";
import { getTokenDetail, getTokenSwapHistory } from "../services/tokenDetail.js";

export async function registerTokenRoutes(app: FastifyInstance) {
  app.get("/api/tokens", async (request, reply) => {
    try {
      const query = request.query as { chain?: string };
      const chain = query.chain && query.chain !== "all" && isChainKey(query.chain) ? query.chain : undefined;
      return { data: await listMarketTokens(chain) };
    } catch (error) {
      return reply.code(503).send({ error: "Database unavailable", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/tokens/:chain/:address", async (request, reply) => {
    try {
      const { chain, address } = request.params as { chain: string; address: string };
      if (!isChainKey(chain)) return reply.code(400).send({ error: "Invalid chain" });
      const token = await getTokenDetail(chain, address);
      if (!token) return reply.code(404).send({ error: "Token not found" });
      return { data: token };
    } catch (error) {
      return reply.code(503).send({ error: "Database unavailable", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/tokens/:chain/:address/candles", async (request, reply) => {
    try {
      const { chain, address } = request.params as { chain: string; address: string };
      const query = request.query as { interval?: string };
      if (!isChainKey(chain)) return reply.code(400).send({ error: "Invalid chain" });
      return { data: await getMarketCandles(chain, address, query.interval ?? "5m") };
    } catch (error) {
      return reply.code(503).send({ error: "Database unavailable", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/tokens/:chain/:address/swaps", async (request, reply) => {
    try {
      const { chain, address } = request.params as { chain: string; address: string };
      const query = request.query as { limit?: string };
      if (!isChainKey(chain)) return reply.code(400).send({ error: "Invalid chain" });
      return { data: await getTokenSwapHistory(chain, address, Number(query.limit ?? 100)) };
    } catch (error) {
      return reply.code(503).send({ error: "Database unavailable", detail: error instanceof Error ? error.message : String(error) });
    }
  });
}
