import type { FastifyInstance } from "fastify";
import { isChainKey } from "../config/chains.js";
import { getTokenHolderSummary, listHolderSnapshots } from "../services/holders.js";

export async function registerHolderRoutes(app: FastifyInstance) {
  app.get("/api/holders", async (request, reply) => {
    const query = request.query as { chain?: string };
    if (query.chain && query.chain !== "all" && !isChainKey(query.chain)) return reply.code(400).send({ error: "Invalid chain" });
    const chain = query.chain === "all" || (query.chain && isChainKey(query.chain)) ? query.chain : undefined;
    return { data: await listHolderSnapshots(chain) };
  });

  app.get("/api/holders/:chain/:address", async (request, reply) => {
    const { chain, address } = request.params as { chain: string; address: string };
    const data = await getTokenHolderSummary(chain, address);
    if (!data) return reply.code(404).send({ error: "Holder data not found" });
    return { data };
  });
}
