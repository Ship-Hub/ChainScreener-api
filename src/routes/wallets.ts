import type { FastifyInstance } from "fastify";
import { getWallet } from "../services/wallets.js";

export async function registerWalletRoutes(app: FastifyInstance) {
  app.get("/api/wallets/:chain/:address", async (request, reply) => {
    const { chain, address } = request.params as { chain: string; address: string };
    const wallet = getWallet(chain, address);
    if (!wallet) return reply.code(404).send({ error: "Wallet not found" });
    return { data: wallet };
  });

  app.get("/api/wallets/:chain/:address/pnl", async (request, reply) => {
    const { chain, address } = request.params as { chain: string; address: string };
    const wallet = getWallet(chain, address);
    if (!wallet) return reply.code(404).send({ error: "Wallet not found" });
    return { data: wallet.positions };
  });
}
