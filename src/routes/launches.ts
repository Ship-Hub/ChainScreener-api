import type { FastifyInstance } from "fastify";
import { isChainKey } from "../config/chains.js";
import { listLaunches } from "../services/tokens.js";

export async function registerLaunchRoutes(app: FastifyInstance) {
  app.get("/api/launches", async (request) => {
    const query = request.query as { chain?: string };
    const chain = query.chain && isChainKey(query.chain) ? query.chain : "all";
    return { data: listLaunches(chain) };
  });
}
