import type { FastifyInstance } from "fastify";
import { isChainKey } from "../config/chains.js";
import { launchPlatforms } from "../config/launchPlatforms.js";
import { listMarketTokens } from "../services/market.js";

const VALID_PLATFORMS = new Set(launchPlatforms.map((p) => p.key));

export async function registerLaunchRoutes(app: FastifyInstance) {
  /** All launches, optionally filtered by chain / sort / platform */
  app.get("/api/launches", async (request) => {
    const query = request.query as { chain?: string; sort?: string; platform?: string; limit?: string };
    const chain = query.chain && isChainKey(query.chain) ? query.chain : "all";
    const sort = query.sort === "gainers" ? "gainers" : query.sort === "volume" ? "volume" : "newest";
    const platform = query.platform && VALID_PLATFORMS.has(query.platform) ? query.platform : undefined;
    const limit = query.limit ? Number(query.limit) : 80;
    const tokens = await listMarketTokens(chain, sort, platform, limit);
    return { data: tokens };
  });

  /**
   * Returns the newest tokens for each known platform in one shot.
   * Response: { clanker: TokenSummary[], bankr: TokenSummary[], ... }
   */
  app.get("/api/launches/by-platform", async () => {
    const platformsWithAddresses = launchPlatforms.filter((p) => p.factoryAddresses.length > 0);
    const results = await Promise.all(
      platformsWithAddresses.map(async (p) => {
        const tokens = await listMarketTokens(p.chain, "newest", p.key, 10);
        return [p.key, tokens.slice(0, 10)] as const;
      }),
    );
    return Object.fromEntries(results);
  });
}
