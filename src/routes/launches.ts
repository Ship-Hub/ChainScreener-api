import type { FastifyInstance } from "fastify";
import { isChainKey } from "../config/chains.js";
import { launchPlatforms } from "../config/launchPlatforms.js";
import { listMarketTokens } from "../services/market.js";

const VALID_PLATFORMS = new Set(launchPlatforms.map((p) => p.key));

export async function registerLaunchRoutes(app: FastifyInstance) {
  /** All launches, optionally filtered by chain / sort / platform, with pagination. */
  app.get("/api/launches", async (request) => {
    const query = request.query as {
      chain?: string; sort?: string; platform?: string;
      limit?: string; offset?: string; maxAgeDays?: string; minVolume?: string;
    };
    const chain       = query.chain && isChainKey(query.chain) ? query.chain : "all";
    const sort        = query.sort === "gainers" ? "gainers" : query.sort === "volume" ? "volume" : "newest";
    const platform    = query.platform && VALID_PLATFORMS.has(query.platform) ? query.platform : undefined;
    const limit       = Math.min(500, Math.max(1, Number(query.limit)  || 100));
    const offset      = Math.max(0, Number(query.offset) || 0);
    // Default 7-day window for the Launches page; callers can override or pass 0 for no cap.
    const maxAgeDays  = query.maxAgeDays !== undefined ? Number(query.maxAgeDays) || 0 : 7;
    // Minimum volume in USD to filter out noise tokens (< $10 by default)
    const minVolume   = Math.max(0, Number(query.minVolume) || 0);

    const tokens = await listMarketTokens(chain, sort, platform, limit, offset, maxAgeDays || undefined, minVolume);
    return {
      data:    tokens,
      offset,
      limit,
      // If we got a full page there are likely more; frontend will re-check on the next Load More.
      hasMore: tokens.length >= limit,
    };
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
