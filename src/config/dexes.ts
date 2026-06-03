import type { ChainKey } from "./chains.js";

export type DexConfig = {
  key: string;
  chain: ChainKey;
  name: string;
  factoryAddress: string;
  event: "PairCreated" | "PoolCreated";
};

export const dexes: DexConfig[] = [
  {
    key: "base-uniswap-v3",
    chain: "base",
    name: "Uniswap V3",
    factoryAddress: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    event: "PoolCreated",
  },
  {
    key: "base-aerodrome",
    chain: "base",
    name: "Aerodrome",
    factoryAddress: "0x420dd381b31aef6683db6b902084cb0ffece40da",
    event: "PoolCreated",
  },
  {
    key: "eth-uniswap-v3",
    chain: "eth",
    name: "Uniswap V3",
    factoryAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    event: "PoolCreated",
  },
  {
    key: "bsc-pancakeswap-v3",
    chain: "bsc",
    name: "PancakeSwap V3",
    factoryAddress: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    event: "PoolCreated",
  },
];
