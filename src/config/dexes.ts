import type { ChainKey } from "./chains.js";

export type DexConfig = {
  key: string;
  chain: ChainKey;
  name: string;
  protocol: "uniswap-v2" | "uniswap-v3" | "uniswap-v4" | "aerodrome-v1";
  version: "v2" | "v3" | "v4";
  factoryAddress: string;
  event: "PairCreated" | "PoolCreated" | "Initialize";
};

export const dexes: DexConfig[] = [
  {
    key: "base-uniswap-v2",
    chain: "base",
    name: "Uniswap V2",
    protocol: "uniswap-v2",
    version: "v2",
    factoryAddress: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    event: "PairCreated",
  },
  {
    key: "base-uniswap-v3",
    chain: "base",
    name: "Uniswap V3",
    protocol: "uniswap-v3",
    version: "v3",
    factoryAddress: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    event: "PoolCreated",
  },
  {
    key: "base-uniswap-v4",
    chain: "base",
    name: "Uniswap V4",
    protocol: "uniswap-v4",
    version: "v4",
    factoryAddress: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    event: "Initialize",
  },
  {
    key: "base-aerodrome-v1",
    chain: "base",
    name: "Aerodrome V1",
    protocol: "aerodrome-v1",
    version: "v2",
    factoryAddress: "0x420DD381b31aEF6683db6B902084cB0FFEce40Da",
    event: "PairCreated",
  },
  {
    key: "eth-uniswap-v2",
    chain: "eth",
    name: "Uniswap V2",
    protocol: "uniswap-v2",
    version: "v2",
    factoryAddress: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    event: "PairCreated",
  },
  {
    key: "eth-uniswap-v3",
    chain: "eth",
    name: "Uniswap V3",
    protocol: "uniswap-v3",
    version: "v3",
    factoryAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    event: "PoolCreated",
  },
  {
    key: "eth-uniswap-v4",
    chain: "eth",
    name: "Uniswap V4",
    protocol: "uniswap-v4",
    version: "v4",
    factoryAddress: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    event: "Initialize",
  },
  {
    key: "bsc-pancakeswap-v3",
    chain: "bsc",
    name: "PancakeSwap V3",
    protocol: "uniswap-v3",
    version: "v3",
    factoryAddress: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    event: "PoolCreated",
  },
  {
    key: "bsc-pancakeswap-v2",
    chain: "bsc",
    name: "PancakeSwap V2",
    protocol: "uniswap-v2",
    version: "v2",
    factoryAddress: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    event: "PairCreated",
  },
  {
    key: "bsc-uniswap-v4",
    chain: "bsc",
    name: "Uniswap V4",
    protocol: "uniswap-v4",
    version: "v4",
    factoryAddress: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    event: "Initialize",
  },
  {
    key: "bsc-uniswap-v2",
    chain: "bsc",
    name: "Uniswap V2",
    protocol: "uniswap-v2",
    version: "v2",
    factoryAddress: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    event: "PairCreated",
  },
  {
    key: "bsc-uniswap-v3",
    chain: "bsc",
    name: "Uniswap V3",
    protocol: "uniswap-v3",
    version: "v3",
    factoryAddress: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    event: "PoolCreated",
  },
  {
    key: "eth-sushiswap-v2",
    chain: "eth",
    name: "SushiSwap V2",
    protocol: "uniswap-v2",
    version: "v2",
    factoryAddress: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
    event: "PairCreated",
  },
  {
    key: "eth-sushiswap-v3",
    chain: "eth",
    name: "SushiSwap V3",
    protocol: "uniswap-v3",
    version: "v3",
    factoryAddress: "0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4f",
    event: "PoolCreated",
  },
];
