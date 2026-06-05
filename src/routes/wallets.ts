import type { FastifyInstance } from "fastify";
import { getWalletTrades, getWalletStats, getWalletHoldings } from "../services/walletService.js";
import { getWalletFundingAnalysis, getWalletGraph } from "../services/walletGraph.js";

export async function registerWalletRoutes(app: FastifyInstance) {
  app.get("/api/wallets/:address/trades", async (request, reply) => {
    const { address } = request.params as { address: string };
    const query = request.query as { limit?: string };
    const limit = Math.min(500, Math.max(1, parseInt(query.limit ?? "50", 10) || 50));
    const trades = await getWalletTrades(address, limit);
    return { data: trades };
  });

  app.get("/api/wallets/:address/stats", async (request, reply) => {
    const { address } = request.params as { address: string };
    const stats = await getWalletStats(address);
    return { data: stats };
  });

  app.get("/api/wallets/:address/holdings", async (request, reply) => {
    const { address } = request.params as { address: string };
    const holdings = await getWalletHoldings(address);
    return { data: holdings };
  });

  app.get("/api/wallets/:address/funding", async (request) => {
    const { address } = request.params as { address: string };
    const query = request.query as { limit?: string };
    return { data: await getWalletFundingAnalysis(address, Number(query.limit ?? 30)) };
  });

  app.get("/api/wallets/:address/graph", async (request) => {
    const { address } = request.params as { address: string };
    return { data: await getWalletGraph(address) };
  });

  // Legacy chain-scoped endpoint kept for backward compat
  app.get("/api/wallets/:chain/:address", async (request) => {
    const { address } = request.params as { chain: string; address: string };
    const [stats, holdings] = await Promise.all([getWalletStats(address), getWalletHoldings(address)]);
    return { data: { ...stats, positions: holdings } };
  });
}
