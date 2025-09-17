// src/searcher/profitable.ts
// ENHANCED: more DEXs & pairs + safe inclusion of new .env flags/addresses.
// Quoting is enabled for V3 and V2-compatible routers only; solidly/aggregators are placeholders.

import "dotenv/config";
import { ethers } from "ethers";

/* ------------------------------ Helpers ------------------------------ */

function asBool(v?: string, def = false) {
  if (!v) return def;
  const s = v.toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

type Provider = ethers.AbstractProvider;

/* ------------------------------ Addresses from .env ------------------------------ */

const ADDR = {
  // Base tokens
  ARB:   (process.env.TOKEN_ARB   ?? "").trim() || "0x912CE59144191C1204E64559FE8253a0e49E6548",
  WETH:  (process.env.TOKEN_WETH  ?? "").trim() || "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  USDC:  (process.env.TOKEN_USDC  ?? "").trim() || "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  USDT:  (process.env.TOKEN_USDT  ?? "").trim() || "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",

  // Extra tokens
  WBTC:  (process.env.TOKEN_WBTC  ?? "").trim() || "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  LINK:  (process.env.TOKEN_LINK  ?? "").trim() || "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  UNI:   (process.env.TOKEN_UNI   ?? "").trim() || "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0",
  DAI:   (process.env.TOKEN_DAI   ?? "").trim() || "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  FRAX:  (process.env.TOKEN_FRAX  ?? "").trim() || "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F",

  // Uniswap v3 infra
  UNI_QUOTER:  (process.env.UNI_QUOTER  ?? "").trim() || "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  UNI_FACTORY: (process.env.UNI_FACTORY ?? "").trim() || "0x1F98431c8aD98523631AE4a59f267346ea31F984",

  // Uniswap v3 pools (refs)
  UNIV3_ARB_WETH_005:  (process.env.UNIV3_ARB_WETH_005  ?? "").trim(),
  UNIV3_ARB_WETH_03:   (process.env.UNIV3_ARB_WETH_03   ?? "").trim(),
  UNIV3_WETH_USDC_005: (process.env.UNIV3_WETH_USDC_005 ?? "").trim(),
  UNIV3_ARB_USDC_005:  (process.env.UNIV3_ARB_USDC_005  ?? "").trim(),
  UNIV3_WETH_USDT_005: (process.env.UNIV3_WETH_USDT_005 ?? "").trim(),

  // V2-compatible DEX routers (safe for getAmountsOut)
  SUSHI_ROUTER:     (process.env.SUSHI_ROUTER     ?? "").trim(),
  CAMELOT_ROUTER:   (process.env.CAMELOT_ROUTER   ?? "").trim(),
  TRADERJOE_ROUTER: (process.env.TRADERJOE_ROUTER ?? "").trim(),
  ARBIDEX_ROUTER:   (process.env.ARBIDEX_ROUTER   ?? "").trim(),
  ZYBERSWAP_ROUTER: (process.env.ZYBERSWAP_ROUTER ?? "").trim(),

  // DEXes/aggregators needing custom logic (placeholders in this version)
  RAMSES_ROUTER:    (process.env.RAMSES_ROUTER    ?? "").trim(), // Solidly/ve(3,3)
  RADIANT_ROUTER:   (process.env.RADIANT_ROUTER   ?? "").trim(), // actually 1inch in your .env
  VELA_ROUTER:      (process.env.VELA_ROUTER      ?? "").trim(),
  MYCELIUM_ROUTER:  (process.env.MYCELIUM_ROUTER  ?? "").trim(),
  SUSHIXSWAP_ROUTER:(process.env.SUSHIXSWAP_ROUTER?? "").trim(),
  ONEINCH_ROUTER:   (process.env.ONEINCH_ROUTER   ?? "").trim(),
  PARASWAP_ROUTER:  (process.env.PARASWAP_ROUTER  ?? "").trim(),

  // Curve
  CURVE_ROUTER:           (process.env.CURVE_ROUTER           ?? "").trim(),
  CURVE_ADDRESS_PROVIDER: (process.env.CURVE_ADDRESS_PROVIDER ?? "").trim(),
  CURVE_2POOL:            (process.env.CURVE_2POOL            ?? "").trim(),
  CURVE_FRAX_USDC:        (process.env.CURVE_FRAX_USDC        ?? "").trim(),

  // Balancer
  BALANCER_VAULT:   (process.env.BALANCER_VAULT   ?? "").trim(),
  BALANCER_QUERIES: (process.env.BALANCER_QUERIES ?? "").trim(),

  // GMX (not used for on-chain quoting)
  GMX_ROUTER: (process.env.GMX_ROUTER ?? "").trim(),
  GMX_VAULT:  (process.env.GMX_VAULT  ?? "").trim(),
  GMX_READER: (process.env.GMX_READER ?? "").trim(),

  // Chainlink (reserved for price utils)
  CHAINLINK_ETH_USD: (process.env.CHAINLINK_ETH_USD ?? "").trim(),
  CHAINLINK_ARB_USD: (process.env.CHAINLINK_ARB_USD ?? "").trim(),
  CHAINLINK_BTC_USD: (process.env.CHAINLINK_BTC_USD ?? "").trim(),
} as const;

/* ------------------------------ Config from .env ------------------------------ */

const CFG = {
  // Core sizing / thresholds
  PROBE_NOTIONAL_A:  ethers.parseUnits((process.env.PROBE_NOTIONAL_A  ?? "0.01").trim(), 18),
  MIN_PROFIT_ARB:    ethers.parseUnits((process.env.MIN_PROFIT_ARB    ?? "0.002").trim(), 18),
  MAX_GAS_COST_ARB:  ethers.parseUnits((process.env.MAX_GAS_COST_ARB  ?? "0.001").trim(), 18),

  // Toggles
  ENABLE_CROSS_DEX:   asBool(process.env.ENABLE_CROSS_DEX,   true),
  ENABLE_TRIANGULAR:   asBool(process.env.ENABLE_TRIANGULAR,  true),
  ENABLE_MULTI_PAIR:   asBool(process.env.ENABLE_MULTI_PAIR,  true),
  ENABLE_CURVE:        asBool(process.env.ENABLE_CURVE,       false),
  ENABLE_BALANCER:     asBool(process.env.ENABLE_BALANCER,    false),
  ENABLE_GMX:          asBool(process.env.ENABLE_GMX,         false),
  ENABLE_FLASH_LOANS:  asBool(process.env.ENABLE_FLASH_LOANS, false),
  ENABLE_DEEP_SCANNING:asBool(process.env.ENABLE_DEEP_SCANNING, false),

  // Pair lists
  PRIMARY_PAIRS:       (process.env.PRIMARY_PAIRS   ?? "ARB-WETH,WETH-USDC,ARB-USDC").split(",").map(s => s.trim()).filter(Boolean),
  SECONDARY_PAIRS:     (process.env.SECONDARY_PAIRS ?? "WETH-USDT,ARB-USDT,WBTC-WETH").split(",").map(s => s.trim()).filter(Boolean),
  STABLECOIN_PAIRS:    (process.env.STABLECOIN_PAIRS ?? "USDC-USDT,DAI-USDC,FRAX-USDC").split(",").map(s => s.trim()).filter(Boolean),

  // Trading sizes (base units)
  WETH_BASE_AMOUNT: ethers.parseUnits((process.env.WETH_BASE_AMOUNT ?? "0.001").trim(), 18),
  USDC_BASE_AMOUNT: ethers.parseUnits((process.env.USDC_BASE_AMOUNT ?? "1.0").trim(), 6),
  USDT_BASE_AMOUNT: ethers.parseUnits((process.env.USDT_BASE_AMOUNT ?? "1.0").trim(), 6),

  // Scanning/monitoring
  SCAN_INTERVAL_MS:     Math.max(500, Number(process.env.SCAN_INTERVAL_MS ?? "1000")),
  MAX_CONCURRENT_SCANS: Math.max(1, Number(process.env.MAX_CONCURRENT_SCANS ?? "3")),
  SCAN_ALL_DEXS:        asBool(process.env.SCAN_ALL_DEXS, true),

  // Execution & gas (used for reporting/planning)
  MAX_SLIPPAGE_BPS:     Math.max(0, Math.min(10_000, Number(process.env.MAX_SLIPPAGE_BPS ?? "50"))),
  TARGET_GAS_PRICE_GWEI:Number(process.env.TARGET_GAS_PRICE_GWEI ?? "0.05"),
  MAX_GAS_PRICE_GWEI:   Number(process.env.MAX_GAS_PRICE_GWEI ?? "0.2"),
  GAS_MULTIPLIER:       Number(process.env.GAS_MULTIPLIER ?? "1.05"),

  // Safety
  MAX_TRADE_SIZE_ARB:      ethers.parseUnits((process.env.MAX_TRADE_SIZE_ARB ?? "1.0").trim(), 18),
  DAILY_PROFIT_TARGET_ARB: ethers.parseUnits((process.env.DAILY_PROFIT_TARGET_ARB ?? "0.1").trim(), 18),
  DAILY_LOSS_LIMIT_ARB:    ethers.parseUnits((process.env.DAILY_LOSS_LIMIT_ARB ?? "0.05").trim(), 18),

  // Logging & ranking
  LOG_LEVEL:             (process.env.LOG_LEVEL ?? "info").trim(),
  LOG_ALL_QUOTES:        asBool(process.env.LOG_ALL_QUOTES, false),
  LOG_PROFITABLE_ONLY:   asBool(process.env.LOG_PROFITABLE_ONLY, true),
  LOG_DEX_PERFORMANCE:   asBool(process.env.LOG_DEX_PERFORMANCE, false),
  SAVE_TRADE_HISTORY:    asBool(process.env.SAVE_TRADE_HISTORY, true),
  ENABLE_DEX_RANKING:    asBool(process.env.ENABLE_DEX_RANKING, false),
  MIN_DEX_LIQUIDITY:     Number(process.env.MIN_DEX_LIQUIDITY ?? "0"), // USD gate (not enforced here)
  PREFERRED_DEXS:        (process.env.PREFERRED_DEXS ?? "UniV3,Camelot,Sushi").split(",").map(s => s.trim()).filter(Boolean),
  BACKUP_DEXS:           (process.env.BACKUP_DEXS ?? "Arbidex,Zyberswap,Ramses").split(",").map(s => s.trim()).filter(Boolean),
} as const;

/* ------------------------------ Tokens ------------------------------ */

interface TokenConfig { address: string; symbol: string; decimals: number; isStable?: boolean; }

const TOKENS: Record<string, TokenConfig> = {
  ARB:  { address: ADDR.ARB,  symbol: "ARB",  decimals: 18 },
  WETH: { address: ADDR.WETH, symbol: "WETH", decimals: 18 },
  USDC: { address: ADDR.USDC, symbol: "USDC", decimals: 6, isStable: true },
  USDT: { address: ADDR.USDT, symbol: "USDT", decimals: 6, isStable: true },
  WBTC: { address: ADDR.WBTC, symbol: "WBTC", decimals: 8 },
  LINK: { address: ADDR.LINK, symbol: "LINK", decimals: 18 },
  UNI:  { address: ADDR.UNI,  symbol: "UNI",  decimals: 18 },
  DAI:  { address: ADDR.DAI,  symbol: "DAI",  decimals: 18, isStable: true },
  FRAX: { address: ADDR.FRAX, symbol: "FRAX", decimals: 18, isStable: true },
};

/* ------------------------------ DEX Catalog ------------------------------ */

interface DEXConfig {
  name: string;
  type: "uniswap-v2" | "uniswap-v3" | "curve" | "balancer" | "solidly" | "aggregator" | "perp";
  router?: string;
  quoter?: string;
  factory?: string;
  enabled: boolean;
  v2Compatible?: boolean; // for quick filtering
}

const DEXS: DEXConfig[] = [
  { name: "UniV3",     type: "uniswap-v3", quoter: ADDR.UNI_QUOTER, factory: ADDR.UNI_FACTORY, enabled: true },
  { name: "Sushi",     type: "uniswap-v2", router: ADDR.SUSHI_ROUTER,     enabled: !!ADDR.SUSHI_ROUTER,     v2Compatible: true },
  { name: "Camelot",   type: "uniswap-v2", router: ADDR.CAMELOT_ROUTER,   enabled: !!ADDR.CAMELOT_ROUTER,   v2Compatible: true },
  { name: "TraderJoe", type: "uniswap-v2", router: ADDR.TRADERJOE_ROUTER, enabled: !!ADDR.TRADERJOE_ROUTER, v2Compatible: true },
  { name: "Arbidex",   type: "uniswap-v2", router: ADDR.ARBIDEX_ROUTER,   enabled: !!ADDR.ARBIDEX_ROUTER,   v2Compatible: true },
  { name: "Zyberswap", type: "uniswap-v2", router: ADDR.ZYBERSWAP_ROUTER, enabled: !!ADDR.ZYBERSWAP_ROUTER, v2Compatible: true },

  // Placeholders: not quoted in this version
  { name: "Ramses",    type: "solidly",    router: ADDR.RAMSES_ROUTER,    enabled: false },
  { name: "Curve",     type: "curve",      router: ADDR.CURVE_ROUTER,     enabled: CFG.ENABLE_CURVE && !!ADDR.CURVE_ROUTER },
  { name: "Balancer",  type: "balancer",   router: ADDR.BALANCER_VAULT,   enabled: CFG.ENABLE_BALANCER && !!ADDR.BALANCER_VAULT },
  { name: "SushiXSwap",type: "aggregator", router: ADDR.SUSHIXSWAP_ROUTER,enabled: false },
  { name: "1inch",     type: "aggregator", router: ADDR.ONEINCH_ROUTER,   enabled: false },
  { name: "Paraswap",  type: "aggregator", router: ADDR.PARASWAP_ROUTER,  enabled: false },
  { name: "Radiant",   type: "aggregator", router: ADDR.RADIANT_ROUTER,   enabled: false },
  { name: "Vela",      type: "perp",       router: ADDR.VELA_ROUTER,      enabled: false },
  { name: "Mycelium",  type: "perp",       router: ADDR.MYCELIUM_ROUTER,  enabled: false },
  { name: "GMX",       type: "perp",       router: ADDR.GMX_ROUTER,       enabled: false },
];

/* ------------------------------ Validation ------------------------------ */

async function validateContract(provider: Provider, address: string, name: string): Promise<boolean> {
  if (!address || !ethers.isAddress(address) || address === ethers.ZeroAddress) {
    if (CFG.LOG_ALL_QUOTES) console.log(`⚠️ Invalid ${name} address: ${address}`);
    return false;
  }
  try {
    const code = await provider.getCode(address);
    return code !== "0x" && code.length > 2;
  } catch (error) {
    if (CFG.LOG_ALL_QUOTES) console.log(`❌ Failed to validate ${name}:`, error);
    return false;
  }
}

/* ------------------------------ Uniswap v3 QuoterV2 ------------------------------ */

const QUOTER_V2_ABI = [
  {
    type: "function", stateMutability: "nonpayable", name: "quoteExactInputSingle",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn",           type: "address" },
      { name: "tokenOut",          type: "address" },
      { name: "amountIn",          type: "uint256" },
      { name: "fee",               type: "uint24"  },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ]}],
    outputs: [
      { name: "amountOut",               type: "uint256" },
      { name: "sqrtPriceX96After",       type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32"  },
      { name: "gasEstimate",             type: "uint256" },
    ],
  },
] as const;

async function quoteUniV3(
  provider: Provider,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  try {
    const quoter = new ethers.Contract(ADDR.UNI_QUOTER, QUOTER_V2_ABI, provider);
    const res = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n });
    const out = (res as any)?.amountOut as bigint | undefined;
    return out ?? 0n;
  } catch (error) {
    if (CFG.LOG_ALL_QUOTES) console.log(`UniV3 quote failed (${tokenIn}->${tokenOut}, fee ${fee}):`, error);
    return 0n;
  }
}

/* ------------------------------ Uniswap v2-style routers ------------------------------ */

const V2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
] as const;

async function quoteV2Router(
  provider: Provider,
  routerAddr: string,
  path: string[],
  amountIn: bigint
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  if (!await validateContract(provider, routerAddr, "V2Router")) return 0n;
  try {
    const router = new ethers.Contract(routerAddr, V2_ROUTER_ABI, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return (Array.isArray(amounts) && amounts.length > 1) ? (amounts[amounts.length - 1] as bigint) : 0n;
  } catch (error) {
    if (CFG.LOG_ALL_QUOTES) console.log(`V2Router quote failed (${routerAddr}):`, error);
    return 0n;
  }
}

/* ------------------------------ Curve (stable-only) ------------------------------ */

const CURVE_ROUTER_ABI = [
  "function get_best_rate(address from, address to, uint256 amount) view returns (address pool, uint256 amountOut)",
] as const;

async function quoteCurve(
  provider: Provider,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<{ pool: string; amountOut: bigint }> {
  if (!CFG.ENABLE_CURVE || !ADDR.CURVE_ROUTER || amountIn <= 0n) return { pool: "", amountOut: 0n };
  try {
    const router = new ethers.Contract(ADDR.CURVE_ROUTER, CURVE_ROUTER_ABI, provider);
    const [pool, amountOut] = await router.get_best_rate(tokenIn, tokenOut, amountIn);
    return { pool, amountOut: amountOut as bigint };
  } catch (error) {
    if (CFG.LOG_ALL_QUOTES) console.log(`Curve quote failed:`, error);
    return { pool: "", amountOut: 0n };
  }
}

/* ------------------------------ Balancer (placeholder) ------------------------------ */

async function quoteBalancer(
  _provider: Provider,
  _tokenIn: string,
  _tokenOut: string,
  _amountIn: bigint
): Promise<bigint> {
  if (!CFG.ENABLE_BALANCER) return 0n;
  // Implement with Vault's queryBatchSwap + pool discovery
  return 0n;
}

/* ------------------------------ Quotes per pair ------------------------------ */

type DexQuote = {
  name: string;
  amountOut: bigint;
  amountIn: bigint;
  tokenIn: string;
  tokenOut: string;
  pair: string;
};

const dexPerf: Record<string, { quotes: number; wins: number }> = {};

function bumpDexPerf(name: string, field: "quotes" | "wins") {
  dexPerf[name] = dexPerf[name] ?? { quotes: 0, wins: 0 };
  dexPerf[name][field]++;
}

async function getQuotesForPair(
  provider: Provider,
  tokenInAddr: string,
  tokenOutAddr: string,
  tokenInSymbol: string,
  tokenOutSymbol: string,
  amountIn: bigint
): Promise<DexQuote[]> {
  if (amountIn <= 0n) return [];
  const quotes: DexQuote[] = [];
  const pairName = `${tokenInSymbol}/${tokenOutSymbol}`;

  // Uni V3 fee tiers: add 0.01% when deep scanning
  const v3Fees = CFG.ENABLE_DEEP_SCANNING ? [100, 500, 3000, 10000] : [500, 3000, 10000];
  for (const fee of v3Fees) {
    const amountOut = await quoteUniV3(provider, tokenInAddr, tokenOutAddr, fee, amountIn);
    if (amountOut > 0n) {
      quotes.push({ name: `UniV3-${fee / 100}%`, amountOut, amountIn, tokenIn: tokenInAddr, tokenOut: tokenOutAddr, pair: pairName });
      bumpDexPerf("UniV3", "quotes");
    }
  }

  // V2-compatible DEXes
  const v2Routers = DEXS.filter(d => d.v2Compatible && d.enabled && d.router);
  for (const dex of v2Routers) {
    const out = await quoteV2Router(provider, dex.router!, [tokenInAddr, tokenOutAddr], amountIn);
    if (out > 0n) {
      quotes.push({ name: dex.name, amountOut: out, amountIn, tokenIn: tokenInAddr, tokenOut: tokenOutAddr, pair: pairName });
      bumpDexPerf(dex.name, "quotes");
    }
  }

  // Curve (stable-only)
  const tokenInCfg  = Object.values(TOKENS).find(t => t.address.toLowerCase() === tokenInAddr.toLowerCase());
  const tokenOutCfg = Object.values(TOKENS).find(t => t.address.toLowerCase() === tokenOutAddr.toLowerCase());
  if (tokenInCfg?.isStable && tokenOutCfg?.isStable && CFG.ENABLE_CURVE) {
    const curve = await quoteCurve(provider, tokenInAddr, tokenOutAddr, amountIn);
    if (curve.amountOut > 0n) {
      quotes.push({ name: "Curve", amountOut: curve.amountOut, amountIn, tokenIn: tokenInAddr, tokenOut: tokenOutAddr, pair: pairName });
      bumpDexPerf("Curve", "quotes");
    }
  }

  if (CFG.LOG_ALL_QUOTES && quotes.length) console.log(`  ${pairName}: ${quotes.length} quotes`);
  return quotes;
}

/* ------------------------------ Cross-DEX multi-pair ------------------------------ */

async function findCrossDEXOpportunities(provider: Provider) {
  if (!CFG.ENABLE_CROSS_DEX) return { profitable: false as const };
  console.log("=== SCANNING CROSS-DEX (MULTI-PAIR) ===");

  const pairsToProbe = [
    { tokenIn: "WETH", tokenOut: "ARB",  amount: CFG.WETH_BASE_AMOUNT },
    { tokenIn: "USDC", tokenOut: "ARB",  amount: CFG.USDC_BASE_AMOUNT },
    { tokenIn: "WETH", tokenOut: "USDC", amount: CFG.WETH_BASE_AMOUNT },
    { tokenIn: "USDC", tokenOut: "WETH", amount: CFG.USDC_BASE_AMOUNT },
    // Deep scan: add more (from env lists)
    ...(CFG.ENABLE_DEEP_SCANNING
      ? CFG.PRIMARY_PAIRS.concat(CFG.SECONDARY_PAIRS)
          .map(p => p.split("-"))
          .filter(([a,b]) => TOKENS[a] && TOKENS[b])
          .map(([a,b]) => ({
            tokenIn: a,
            tokenOut: b,
            amount:
              a === "WETH" ? CFG.WETH_BASE_AMOUNT :
              a === "USDC" ? CFG.USDC_BASE_AMOUNT :
              a === "USDT" ? CFG.USDT_BASE_AMOUNT :
              ethers.parseUnits("1", TOKENS[a].decimals),
          }))
      : []),
  ];

  let best: any = { profitable: false as const };

  for (const pair of pairsToProbe) {
    const ti = TOKENS[pair.tokenIn]; const to = TOKENS[pair.tokenOut];
    if (!ti || !to) continue;

    console.log(`\nPair: ${pair.tokenIn} -> ${pair.tokenOut}`);
    const buyQuotes = await getQuotesForPair(provider, ti.address, to.address, ti.symbol, to.symbol, pair.amount);
    if (buyQuotes.length === 0) continue;

    const bestBuy = buyQuotes.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
    bumpDexPerf(bestBuy.name, "wins");
    console.log(`  Best buy: ${bestBuy.name} → ${ethers.formatUnits(bestBuy.amountOut, to.decimals)} ${to.symbol}`);

    const sellQuotes = await getQuotesForPair(provider, to.address, ti.address, to.symbol, ti.symbol, bestBuy.amountOut);
    const viableSells = sellQuotes.filter(s => s.name !== bestBuy.name);
    if (viableSells.length === 0) continue;

    const bestSell = viableSells.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
    bumpDexPerf(bestSell.name, "wins");

    const profit = bestSell.amountOut - pair.amount;

    // Convert profits into ARB for uniform thresholding
    let profitInArb = profit;
    if (profit > 0n && ti.symbol !== "ARB") {
      if (ti.symbol === "WETH")       profitInArb = await quoteUniV3(provider, ADDR.WETH, ADDR.ARB, 3000, profit);
      else if (ti.symbol === "USDC")  profitInArb = await quoteUniV3(provider, ADDR.USDC, ADDR.ARB, 3000, profit);
      else if (ti.symbol === "USDT")  profitInArb = await quoteUniV3(provider, ADDR.USDT, ADDR.ARB, 3000, profit);
    }

    const netArb = profitInArb - CFG.MAX_GAS_COST_ARB;

    console.log(`  Path: ${pair.tokenIn} -> ${bestBuy.name} -> ${to.symbol} -> ${bestSell.name} -> ${pair.tokenIn}`);
    console.log(`  Δ ${ti.symbol}: ${ethers.formatUnits(profit, ti.decimals)}`);
    console.log(`  ≈ ARB: ${ethers.formatUnits(profitInArb, 18)} | Net: ${ethers.formatUnits(netArb, 18)} ARB`);

    if (netArb > CFG.MIN_PROFIT_ARB && (!best.profitable || netArb > best.profit)) {
      best = {
        profitable: true as const,
        strategy: "Cross-DEX-Multi-Pair",
        pair: `${pair.tokenIn}/${pair.tokenOut}`,
        buyDEX: bestBuy.name,
        sellDEX: bestSell.name,
        profit: netArb,
        grossProfit: profitInArb,
        path: `${pair.tokenIn} -> ${bestBuy.name} -> ${to.symbol} -> ${bestSell.name} -> ${pair.tokenIn}`,
        gasAssumed: CFG.MAX_GAS_COST_ARB,
      };
    }
  }

  if (CFG.LOG_DEX_PERFORMANCE) {
    console.log("\nDEX performance (quotes/wins):", dexPerf);
  }

  if (best.profitable) console.log(`\n✅ Best cross-DEX opportunity found!`);
  else                 console.log(`\n❌ No profitable cross-DEX opportunities`);
  return best;
}

/* ------------------------------ Triangular (multi-path) ------------------------------ */

async function findTriangularOpportunity(provider: Provider) {
  if (!CFG.ENABLE_TRIANGULAR) return { profitable: false as const };
  console.log("=== SCANNING TRIANGULAR (MULTI-PATH) ===");

  const paths = [
    { tokens: ["ARB","WETH","USDC","ARB"],  fees: [3000,  500, 3000], name: "ARB-WETH-USDC-ARB" },
    { tokens: ["ARB","USDC","WETH","ARB"],  fees: [3000,  500, 3000], name: "ARB-USDC-WETH-ARB" },
    { tokens: ["WETH","ARB","USDC","WETH"], fees: [3000, 3000,  500], name: "WETH-ARB-USDC-WETH" },
    { tokens: ["WETH","USDC","ARB","WETH"], fees: [ 500, 3000, 3000], name: "WETH-USDC-ARB-WETH" },
    { tokens: ["USDC","WETH","ARB","USDC"], fees: [ 500, 3000, 3000], name: "USDC-WETH-ARB-USDC" },
    // Stable path (0.01% tier may not exist; deep scan helps)
    { tokens: ["USDC","USDT","WETH","USDC"], fees: [ 100,  500,  500], name: "USDC-USDT-WETH-USDC" },
  ];

  let best: any = { profitable: false as const };

  for (const path of paths) {
    if (!path.tokens.every(t => TOKENS[t])) continue;

    const startTok = TOKENS[path.tokens[0]];
    const startAmt =
      startTok.symbol === "ARB"  ? CFG.PROBE_NOTIONAL_A  :
      startTok.symbol === "WETH" ? CFG.WETH_BASE_AMOUNT :
      startTok.symbol === "USDC" ? CFG.USDC_BASE_AMOUNT :
      startTok.symbol === "USDT" ? CFG.USDT_BASE_AMOUNT :
      ethers.parseUnits("1", startTok.decimals);

    console.log(`\nPath: ${path.name} with ${ethers.formatUnits(startAmt, startTok.decimals)} ${startTok.symbol}`);

    let amt = startAmt;
    let ok  = true;
    const steps: Array<{ from: string; to: string; amountIn: bigint; amountOut: bigint; fee: number }> = [];

    for (let i = 0; i < path.tokens.length - 1; i++) {
      const from = TOKENS[path.tokens[i]];
      const to   = TOKENS[path.tokens[i + 1]];
      const fee  = path.fees[i];

      const out = await quoteUniV3(provider, from.address, to.address, fee, amt);
      if (out === 0n) { ok = false; if (CFG.LOG_ALL_QUOTES) console.log(`  Fail ${from.symbol}->${to.symbol} (fee ${fee})`); break; }
      steps.push({ from: from.symbol, to: to.symbol, amountIn: amt, amountOut: out, fee });
      amt = out;
    }

    if (!ok) continue;

    const finalAmt = amt;
    const gross = finalAmt - startAmt;

    // Convert to ARB profit
    let profitArb = gross;
    if (startTok.symbol !== "ARB" && gross > 0n) {
      if (startTok.symbol === "WETH")       profitArb = await quoteUniV3(provider, ADDR.WETH, ADDR.ARB, 3000, gross);
      else if (startTok.symbol === "USDC")  profitArb = await quoteUniV3(provider, ADDR.USDC, ADDR.ARB, 3000, gross);
      else if (startTok.symbol === "USDT")  profitArb = await quoteUniV3(provider, ADDR.USDT, ADDR.ARB, 3000, gross);
    }

    const netArb = profitArb - CFG.MAX_GAS_COST_ARB;
    const bps = gross > 0n ? Number(gross * 10000n / startAmt) : 0;

    console.log(`  Result: ${ethers.formatUnits(startAmt, startTok.decimals)} → ${ethers.formatUnits(finalAmt, startTok.decimals)} ${startTok.symbol}`);
    console.log(`  Gross:  ${ethers.formatUnits(gross, startTok.decimals)} ${startTok.symbol} (${bps} bps)`);
    console.log(`  Net(ARB): ${ethers.formatUnits(netArb, 18)} ARB`);

    if (netArb > CFG.MIN_PROFIT_ARB && (!best.profitable || netArb > best.profit)) {
      best = {
        profitable: true as const,
        strategy: "Triangular-Multi-Path",
        path: path.tokens as readonly string[],
        pathName: path.name,
        profit: netArb,
        grossProfit: profitArb,
        gasAssumed: CFG.MAX_GAS_COST_ARB,
        profitBPS: bps,
        steps,
      };
    }
  }

  if (best.profitable) console.log(`\n✅ Best triangular: ${best.pathName}, net ${ethers.formatUnits(best.profit, 18)} ARB`);
  else                 console.log("\nNo profitable triangular paths found");
  return best;
}

/* ------------------------------ Multi-token complex (demo) ------------------------------ */

async function findMultiTokenOpportunities(provider: Provider) {
  if (!CFG.ENABLE_MULTI_PAIR) return { profitable: false as const };
  console.log("=== SCANNING MULTI-TOKEN (COMPLEX DEMO) ===");

  const complex = [
    { tokens: ["ARB","WETH","USDC","USDT","ARB"], name: "ARB-WETH-USDC-USDT-ARB" },
    { tokens: ["WETH","ARB","USDC","DAI","WETH"], name: "WETH-ARB-USDC-DAI-WETH" },
    { tokens: ["WETH","WBTC","USDC","ARB","WETH"], name: "WETH-WBTC-USDC-ARB-WETH" },
  ];

  let best: any = { profitable: false as const };

  for (const path of complex) {
    if (!path.tokens.every(t => TOKENS[t])) continue;

    const startTok = TOKENS[path.tokens[0]];
    const startAmt =
      startTok.symbol === "ARB"  ? CFG.PROBE_NOTIONAL_A  :
      startTok.symbol === "WETH" ? CFG.WETH_BASE_AMOUNT :
      startTok.symbol === "USDC" ? CFG.USDC_BASE_AMOUNT :
      startTok.symbol === "USDT" ? CFG.USDT_BASE_AMOUNT :
      ethers.parseUnits("1", startTok.decimals);

    console.log(`\nComplex path: ${path.name}`);
    let amt = startAmt, ok = true;
    let gasEst = 0n;

    for (let i = 0; i < path.tokens.length - 1; i++) {
      const from = TOKENS[path.tokens[i]];
      const to   = TOKENS[path.tokens[i + 1]];
      let bestHop = 0n;
      for (const fee of [500, 3000, 10000]) {
        const out = await quoteUniV3(provider, from.address, to.address, fee, amt);
        if (out > bestHop) bestHop = out;
      }
      if (bestHop === 0n) { ok = false; break; }
      amt = bestHop;
      gasEst += ethers.parseUnits("0.0002", 18); // rough ARB per hop
    }

    if (!ok) continue;

    const gross = amt - startAmt;
    let profitArb = gross;
    if (startTok.symbol !== "ARB" && gross > 0n) {
      if (startTok.symbol === "WETH")       profitArb = await quoteUniV3(provider, ADDR.WETH, ADDR.ARB, 3000, gross);
      else if (startTok.symbol === "USDC")  profitArb = await quoteUniV3(provider, ADDR.USDC, ADDR.ARB, 3000, gross);
      else if (startTok.symbol === "USDT")  profitArb = await quoteUniV3(provider, ADDR.USDT, ADDR.ARB, 3000, gross);
    }
    const net = profitArb - gasEst;

    console.log(`  Gross(ARB): ${ethers.formatUnits(profitArb, 18)} | Gas est: ${ethers.formatUnits(gasEst, 18)} | Net: ${ethers.formatUnits(net, 18)} ARB`);

    if (net > CFG.MIN_PROFIT_ARB && (!best.profitable || net > best.profit)) {
      best = { profitable: true as const, strategy: "Multi-Token-Complex", pathName: path.name, profit: net, grossProfit: profitArb, gasAssumed: gasEst, path: path.tokens.join(" -> ") };
    }
  }

  return best;
}

/* ------------------------------ Flash loans (placeholder) ------------------------------ */

async function findFlashLoanOpportunity(_provider: Provider) {
  if (!CFG.ENABLE_FLASH_LOANS) return { profitable: false as const };
  console.log("=== SCANNING FLASH LOAN ARBITRAGE ===");
  return { profitable: false as const };
}

/* ------------------------------ Orchestrator ------------------------------ */

export async function runProfitableMEVBot(provider: Provider) {
  console.log("=== STARTING ENHANCED MEV STRATEGY ===");

  // Validate must-haves
  const must = [
    { addr: ADDR.ARB,        name: "ARB Token" },
    { addr: ADDR.WETH,       name: "WETH Token" },
    { addr: ADDR.USDC,       name: "USDC Token" },
    { addr: ADDR.UNI_QUOTER, name: "Uniswap Quoter" },
  ];
  for (const m of must) {
    if (!await validateContract(provider, m.addr, m.name)) {
      console.log(`Critical contract invalid: ${m.name}`);
      return null;
    }
  }

  // Quoter smoke test
  try {
    const t = ethers.parseUnits("0.001", 18);
    const q = await quoteUniV3(provider, ADDR.ARB, ADDR.WETH, 3000, t);
    if (q === 0n) { console.log("Quoter test failed (0)"); return null; }
    console.log(`Quoter ok: ${ethers.formatUnits(t, 18)} ARB → ${ethers.formatUnits(q, 18)} WETH`);
  } catch (e) { console.log("Quoter test error:", e); return null; }

  // Show config snapshot
  console.log("\nConfig:");
  console.log(`  Trade size (ARB): ${ethers.formatUnits(CFG.PROBE_NOTIONAL_A, 18)}`);
  console.log(`  Min profit:       ${ethers.formatUnits(CFG.MIN_PROFIT_ARB, 18)} ARB`);
  console.log(`  Cross-DEX:        ${CFG.ENABLE_CROSS_DEX}`);
  console.log(`  Triangular:       ${CFG.ENABLE_TRIANGULAR}`);
  console.log(`  Multi-pair:       ${CFG.ENABLE_MULTI_PAIR}`);
  console.log(`  Deep scanning:    ${CFG.ENABLE_DEEP_SCANNING}`);
  console.log(`  Curve enabled:    ${CFG.ENABLE_CURVE}`);
  console.log(`  Active DEXs:      ${DEXS.filter(d => d.enabled).map(d => d.name).join(", ") || "None"}`);

  // Run strategies
  const fns: Array<() => Promise<any>> = [];
  const names: string[] = [];
  if (CFG.ENABLE_CROSS_DEX)  { fns.push(() => findCrossDEXOpportunities(provider)); names.push("Cross-DEX-Multi-Pair"); }
  if (CFG.ENABLE_TRIANGULAR) { fns.push(() => findTriangularOpportunity(provider));  names.push("Triangular-Multi-Path"); }
  if (CFG.ENABLE_MULTI_PAIR) { fns.push(() => findMultiTokenOpportunities(provider)); names.push("Multi-Token-Complex"); }
  if (CFG.ENABLE_FLASH_LOANS){ fns.push(() => findFlashLoanOpportunity(provider));   names.push("Flash-Loan"); }

  if (!fns.length) { console.log("No strategies enabled"); return null; }

  const results = await Promise.allSettled(fns.map(fn => fn()));

  let best: { strategy: string; profit: bigint; details: any } | null = null;
  results.forEach((r, i) => {
    const name = names[i];
    if (r.status === "fulfilled") {
      const val = r.value;
      if (val?.profitable && val.profit) {
        if (!best || val.profit > best.profit) best = { strategy: name, profit: val.profit, details: val };
        console.log(`${name}: ${ethers.formatUnits(val.profit, 18)} ARB`);
      } else {
        console.log(`${name}: Not profitable`);
      }
    } else {
      console.log(`${name}: Failed - ${r.reason}`);
    }
  });

  if (CFG.LOG_DEX_PERFORMANCE) console.log("\nDEX performance:", dexPerf);

  if (best?.details?.profitable) {
    console.log(`\nBEST OPPORTUNITY: ${best.strategy}`);
    console.log(`  Net Profit: ${ethers.formatUnits(best.profit, 18)} ARB`);
    const d = best.details;
    if (d.grossProfit) console.log(`  Gross Profit: ${ethers.formatUnits(d.grossProfit, 18)} ARB`);
    if (d.path)        console.log(`  Path: ${d.path}`);
    if (d.pathName)    console.log(`  Strategy: ${d.pathName}`);
    if (d.profitBPS)   console.log(`  Margin: ${d.profitBPS} bps (${(d.profitBPS / 100).toFixed(2)}%)`);
    return best.details;
  }

  console.log("\nNO PROFITABLE OPPORTUNITIES FOUND");
  return null;
}

/* ------------------------------ Continuous Monitoring ------------------------------ */

export async function startContinuousMonitoring(provider: Provider) {
  console.log("=== STARTING ENHANCED CONTINUOUS MONITORING ===");
  console.log(`Interval: ${CFG.SCAN_INTERVAL_MS}ms | DEXs: ${DEXS.filter(d => d.enabled).length}`);

  let scans = 0, hits = 0, total = 0n, best: any = null;

  const runScan = async () => {
    scans++;
    console.log(`\n--- Scan #${scans} ---`);
    try {
      const opp = await runProfitableMEVBot(provider);
      if (opp?.profitable) {
        const p = opp.profit || 0n;
        hits++; total += p;
        const prevBest = best?.profit ?? 0n;
        const newBest = !best || p > prevBest;
        if (newBest) best = opp;
        console.log(`HIT! Profit: ${ethers.formatUnits(p, 18)} ARB${newBest ? " (NEW BEST)" : ""}`);
        if (CFG.SAVE_TRADE_HISTORY) {
          console.log("Record:", JSON.stringify({
            t: new Date().toISOString(), scan: scans, strategy: opp.strategy, profit: ethers.formatUnits(p, 18)
          }, null, 2));
        }
      } else {
        console.log("No opportunities this scan");
      }

      const rate = scans ? ((hits / scans) * 100).toFixed(2) : "0.00";
      console.log(`Stats: ${hits}/${scans} profitable (${rate}%), total ${ethers.formatUnits(total, 18)} ARB`);
    } catch (e) {
      console.log("Scan failed:", e);
    }
  };

  await runScan();
  const iv = setInterval(runScan, CFG.SCAN_INTERVAL_MS);

  if (typeof process !== "undefined" && process.on) {
    process.on("SIGINT", () => {
      clearInterval(iv);
      const rate = scans ? ((hits / scans) * 100).toFixed(2) : "0.00";
      console.log(`\nFINAL STATS\n  scans: ${scans}\n  hits: ${hits}\n  rate: ${rate}%\n  total: ${ethers.formatUnits(total, 18)} ARB`);
      if (best) console.log(`  best: ${ethers.formatUnits(best.profit || 0n, 18)} ARB (${best.strategy})`);
      process.exit(0);
    });
  }
}

/* ------------------------------ Exports ------------------------------ */

export {
  findCrossDEXOpportunities,
  findTriangularOpportunity,
  findMultiTokenOpportunities,
  findFlashLoanOpportunity,
  quoteUniV3,
  quoteV2Router,
  quoteCurve,
  quoteBalancer,
  validateContract,
  CFG,
  ADDR,
  TOKENS,
  DEXS,
};
