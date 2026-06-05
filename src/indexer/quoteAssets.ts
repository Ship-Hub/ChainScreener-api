import type { ChainKey } from "../config/chains.js";

export type QuoteAsset = {
  chain: ChainKey;
  address: string;
  symbol: string;
  decimals: number;
  usdPrice: number;
};

export const stablecoins: QuoteAsset[] = [
  { chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913", symbol: "USDC", decimals: 6, usdPrice: 1 },
  { chain: "base", address: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", symbol: "USDbC", decimals: 6, usdPrice: 1 },
  { chain: "eth", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6, usdPrice: 1 },
  { chain: "eth", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6, usdPrice: 1 },
  { chain: "eth", address: "0x6b175474e89094c44da98b954eedeac495271d0f", symbol: "DAI", decimals: 18, usdPrice: 1 },
  { chain: "bsc", address: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", decimals: 18, usdPrice: 1 },
  { chain: "bsc", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", symbol: "USDC", decimals: 18, usdPrice: 1 },
];

// Wrapped native tokens — prices are derived from indexed stablecoin swaps at runtime.
export const wrappedNatives: QuoteAsset[] = [
  { chain: "base", address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18, usdPrice: 0 },
  { chain: "eth", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18, usdPrice: 0 },
  { chain: "bsc", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB", decimals: 18, usdPrice: 0 },
];

export const quoteAssets: QuoteAsset[] = [...stablecoins, ...wrappedNatives];

export function getQuoteAsset(chain: ChainKey, address: string, assets: QuoteAsset[] = stablecoins) {
  const normalized = address.toLowerCase();
  return assets.find((asset) => asset.chain === chain && asset.address.toLowerCase() === normalized);
}
