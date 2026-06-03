import type { FastifyInstance } from "fastify";
import { listTrending } from "../services/trending.js";

export async function registerTrendingRoutes(app: FastifyInstance) {
  app.get("/api/trending", async (request) => {
    const query = request.query as { chain?: string };
    return { data: listTrending(query.chain ?? "all") };
  });
}
