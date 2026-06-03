import { base, bsc, mainnet } from "viem/chains";
import { env } from "../shared/env.js";

export type ChainKey = "base" | "eth" | "bsc";

export const chains = {
  base: {
    key: "base",
    name: "Base",
    chainId: base.id,
    nativeSymbol: "ETH",
    rpcUrl: env.BASE_RPC_URL,
  },
  eth: {
    key: "eth",
    name: "Ethereum",
    chainId: mainnet.id,
    nativeSymbol: "ETH",
    rpcUrl: env.ETH_RPC_URL,
  },
  bsc: {
    key: "bsc",
    name: "BNB Smart Chain",
    chainId: bsc.id,
    nativeSymbol: "BNB",
    rpcUrl: env.BSC_RPC_URL,
  },
} as const;

export function isChainKey(value: string): value is ChainKey {
  return value in chains;
}
