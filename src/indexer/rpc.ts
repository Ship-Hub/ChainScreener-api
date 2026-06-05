import { createPublicClient, http } from "viem";
import { base, bsc, mainnet } from "viem/chains";
import { chains, type ChainKey } from "../config/chains.js";

const viemChains = {
  base,
  eth: mainnet,
  bsc,
} as const;

const clients = new Map<ChainKey, ReturnType<typeof createPublicClient>>();

export function getRpcClient(chain: ChainKey) {
  const existing = clients.get(chain);
  if (existing) return existing;

  const client = createPublicClient({
    chain: viemChains[chain],
    transport: http(chains[chain].rpcUrl, {
      retryCount: 3,
      timeout: 20_000,
    }),
  });

  clients.set(chain, client as unknown as ReturnType<typeof createPublicClient>);
  return client;
}
