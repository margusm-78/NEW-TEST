import "dotenv/config";
import { ethers } from "ethers";

/* ---------- helpers ---------- */

function req(name: string): string {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
function addr(name: string): string {
  const v = req(name);
  if (!ethers.isAddress(v)) throw new Error(`Invalid address in ${name}: ${v}`);
  return ethers.getAddress(v);
}
function bool(name: string, def = false): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return def;
  return ["1", "true", "yes", "y"].includes(v);
}
function toWei(strOrNum: string | number | undefined, def = "0.00002"): bigint {
  const n = strOrNum === undefined ? Number(def) : Number(strOrNum);
  if (!Number.isFinite(n) || n < 0) return BigInt(Math.round(Number(def) * 1e18));
  return BigInt(Math.round(n * 1e18));
}

/* ---------- tokens ---------- */
const TOKENS = {
  WETH: addr("WETH"),
  ARB:  addr("ARB"),
} as const;

/* ---------- uniswap infra ---------- */
const UNI = {
  factory: addr("UNIV3_FACTORY_ARBITRUM"),
  quoter:  addr("UNIV3_QUOTER_ARBITRUM"),
  priceFee: Number(process.env.FEE_TIER_1 ?? "3000"), // hint for pricing
  pools: [
    { name: "ARB/WETH@500",  address: "", token0: "ARB", token1: "WETH", fee: Number(process.env.FEE_TIER_3 ?? "500") },
    { name: "ARB/WETH@3000", address: "", token0: "ARB", token1: "WETH", fee: Number(process.env.FEE_TIER_1 ?? "3000") },
    { name: "ARB/WETH@10000",address: "", token0: "ARB", token1: "WETH", fee: Number(process.env.FEE_TIER_2 ?? "10000") },
  ],
};

/* ---------- runtime ---------- */
export const CONFIG = {
  rpcUrl: req("ARB_RPC_URL"),
  router: addr("ROUTER_ADDRESS"),

  uni: {
    ...UNI,
    minProfitARBWei: toWei(process.env.MIN_PROFIT_ARB), // optional if you prefer profit gate in ARB
    minProfitWETHWei: toWei(process.env.MIN_PROFIT_WETH ?? "0.00002"),
  },

  tokens: TOKENS,
  profitToken: TOKENS.WETH,

  dryRun: bool("DRY_RUN", false),

  timeboost: {
    defaultBidWei: BigInt(process.env.DEFAULT_BID_WEI ?? "0"),
  },
} as const;

export const ROUTERS = {
  swapRouter02: addr("UNIV3_SWAPROUTER02_ARBITRUM"),
} as const;

export type BackrunConfig = { enableArb?: boolean };
export const BackrunConfig: BackrunConfig = { enableArb: false };
