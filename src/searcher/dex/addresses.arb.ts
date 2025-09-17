// src/searcher/dex/addresses.arb.ts
import { ethers } from "ethers";

/** Canonical, checksummed defaults for Arbitrum One (42161) */
const DEFAULTS = {
  // Tokens
  WETH:        "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  USDC:        "0xAf88d065E77c8CC2239327C5EDb3A432268e5831",
  USDCe:       "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
  ARB:         "0x912CE59144191C1204E64559FE8253a0e49E6548",

  // Routers / Quoter / Factory
  V2_ROUTER:   "0xc873fEcbd354f5A56E00E710B90EF4201db2448d", // Camelot v2 Router
  V3_QUOTER:   "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", // Uniswap v3 QuoterV2
  V3_ROUTER:   "0xE592427A0AEce92De3Edee1F18E0157C05861564", // Uniswap v3 SwapRouter v1
  V3_ROUTER02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // Uniswap v3 SwapRouter02
  V3_FACTORY:  "0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap v3 Factory
} as const;

/** Accept common env aliases (any one will work) */
const ENV_ALIASES: Record<string, string[]> = {
  WETH:       ["WETH_ARBITRUM","ARB_WETH","WETH"],
  USDC:       ["USDC_ARBITRUM","ARB_USDC","USDC"],
  USDCe:      ["USDCe_ARBITRUM","ARB_USDCe","USDCe","USDC_E"],
  ARB:        ["ARB_ARBITRUM","ARB_TOKEN","ARB"],

  V2_ROUTER:  ["UNIV2_ROUTER_ARBITRUM","ARB_UNIV2_ROUTER","V2_ROUTER_ARBITRUM","CAMELOT_V2_ROUTER"],
  V3_QUOTER:  ["UNIV3_QUOTER_ARBITRUM","ARB_UNIV3_QUOTER","V3_QUOTER_ARBITRUM"],
  V3_ROUTER:  ["UNIV3_SWAPROUTER_ARBITRUM","ARB_UNIV3_ROUTER","V3_ROUTER_ARBITRUM"],
  V3_ROUTER02:["UNIV3_SWAPROUTER02_ARBITRUM","ARB_UNIV3_ROUTER02","V3_ROUTER02_ARBITRUM","SWAP_ROUTER02"],
  V3_FACTORY: ["UNIV3_FACTORY_ARBITRUM","ARB_UNIV3_FACTORY","V3_FACTORY_ARBITRUM","UNIV3_FACTORY"],
};

type Resolved = { value: string; source: "env" | "default" | "missing"; from?: string };

function resolveOne(key: keyof typeof DEFAULTS): Resolved {
  const aliases = ENV_ALIASES[key] || [];
  for (const name of aliases) {
    const raw = process.env[name];
    if (!raw) continue;
    const v = raw.trim();
    if (ethers.isAddress(v)) return { value: ethers.getAddress(v), source: "env", from: name };
  }
  const dflt = (DEFAULTS as any)[key];
  if (ethers.isAddress(dflt)) return { value: ethers.getAddress(dflt), source: "default" };
  return { value: "", source: "missing" };
}

const _resolved = {
  WETH:        resolveOne("WETH"),
  USDC:        resolveOne("USDC"),
  USDCe:       resolveOne("USDCe"),
  ARB:         resolveOne("ARB"),
  V2_ROUTER:   resolveOne("V2_ROUTER"),
  V3_QUOTER:   resolveOne("V3_QUOTER"),
  V3_ROUTER:   resolveOne("V3_ROUTER"),
  V3_ROUTER02: resolveOne("V3_ROUTER02"),
  V3_FACTORY:  resolveOne("V3_FACTORY"),
};

export const ADDR = Object.fromEntries(Object.entries(_resolved).map(([k, r]) => [k, (r as Resolved).value])) as {
  WETH: string; USDC: string; USDCe: string; ARB: string;
  V2_ROUTER: string; V3_QUOTER: string; V3_ROUTER: string; V3_ROUTER02: string; V3_FACTORY: string;
};

export function debugAddressResolution() {
  return Object.fromEntries(Object.entries(_resolved).map(([k, r]) => {
    const rr = r as Resolved;
    return [k, { value: rr.value || "(missing)", source: rr.source, envVar: rr.from || "" }];
  }));
}

/** === Your scanning pairs (now ARB/WETH) ===
 * v3 fee tier: 500 = 0.05% on Uniswap v3 (deep ARB/WETH pool 0xc6f78049...d6396a).
 */
export const PAIRS: Array<{ a: "ARB" | "WETH" | "USDC" | "USDCe"; b: "ARB" | "WETH" | "USDC" | "USDCe"; v3Fee: 100 | 500 | 3000 | 10000 }> = [
  { a: "ARB", b: "WETH", v3Fee: 500 },
];

/** Validate only what PAIRS + infra actually require */
export function validateAddresses() {
  const required = new Set<keyof typeof ADDR>(["V2_ROUTER","V3_QUOTER","V3_ROUTER02","V3_FACTORY"]);
  for (const p of PAIRS) { required.add(p.a as any); required.add(p.b as any); }
  const missing = [...required].filter((k) => {
    const v = (ADDR as any)[k]; return !v || !ethers.isAddress(v);
  });
  if (missing.length) {
    const table = debugAddressResolution();
    throw new Error(
      `Missing/invalid Arbitrum addresses: ${missing.join(", ")}\n` +
      `Resolution table: ${JSON.stringify(table, null, 2)}\n` +
      `Fix: set a valid address in .env using accepted names or keep defaults.`
    );
  }
}
