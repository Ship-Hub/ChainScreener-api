import type { FastifyInstance } from "fastify";
import { getToken, getTokenChart, getTokenHolders, getTokenPnl, getTokenRisk, getTokenSwaps, listTokens } from "../services/tokens.js";

export async function registerTokenRoutes(app: FastifyInstance) {
  app.get("/api/tokens", async (request) => {
    const query = request.query as { chain?: string; q?: string; risk?: string; launchSource?: string };
    return { data: listTokens(query) };
  });

  app.get("/api/tokens/:chain/:address", async (request, reply) => {
    const { chain, address } = request.params as { chain: string; address: string };
    const token = getToken(chain, address);
    if (!token) return reply.code(404).send({ error: "Token not found" });
    return { data: token };
  });

  app.get("/api/tokens/:chain/:address/chart", async (request, reply) => {
    const { chain, address } = request.params as { chain: string; address: string };
    const data = getTokenChart(chain, address);
    if (!data) return reply.code(404).send({ error: "Token not found" });
    return { data };
  });

  app.get("/api/tokens/:chain/:address/swaps", async (request, reply) => {
    const { chain, address } = request.params as { chain: string; address: string };
    const data = getTokenSwaps(chain, address);
    if (!data) return reply.code(404).send({ error: "Token not found" });
    return { data };
  });

  app.get("/api/tokens/:chain/:address/holders", async (request, reply) => {
    const { chain, address } = request.params as { chain: string; address: string };
    const data = getTokenHolders(chain, address);
    if (!data) return reply.code(404).send({ error: "Token not found" });
    return { data };
  });

  app.get("/api/tokens/:chain/:address/risk", async (request, reply) => {
    const { chain, address } = request.params as { chain: string; address: string };
    const data = getTokenRisk(chain, address);
    if (!data) return reply.code(404).send({ error: "Token not found" });
    return { data };
  });

  app.get("/api/tokens/:chain/:address/pnl", async (request, reply) => {
    const { chain, address } = request.params as { chain: string; address: string };
    const data = getTokenPnl(chain, address);
    if (!data) return reply.code(404).send({ error: "Token not found" });
    return { data };
  });
}
