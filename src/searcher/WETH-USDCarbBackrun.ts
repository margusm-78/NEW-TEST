// src/searcher/arbBackrun.ts
import "dotenv/config";
import { ethers } from "ethers";
import { ADDR, PAIRS, validateAddresses } from "./dex/addresses.arb";
import { ERC20_ABI, UNIV2_ROUTER_ABI, UNIV3_QUOTER_V2_ABI } from "./dex/abis";
import { CONFIG } from "./backrunConfig";
import { initHotTxLimiter, canSend, recordSend, remaining, describeLimiter } from "./limit/hotTxLimiter";
import { withRetry } from "./rpc";

const provider = new ethers.JsonRpcProvider(process.env.ARB_RPC_URL!, { name: "arbitrum", chainId: 42161 });
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const v2 = new ethers.Contract(ADDR.V2_ROUTER, UNIV2_ROUTER_ABI, provider);
const v3Quoter = new ethers.Contract(ADDR.V3_QUOTER, UNIV3_QUOTER_V2_ABI, provider);

type TokenInfo = { decimals: number, symbol: string };
const TOK: Record<string, TokenInfo> = {};

let dryRun = CONFIG.DRY_RUN;

async function loadToken(addr: string) {
  const erc = new ethers.Contract(addr, ERC20_ABI, provider);
  const [dec, sym] = await Promise.all([erc.decimals(), erc.symbol()]);
  return { decimals: Number(dec), symbol: String(sym) };
}

async function init() {
  validateAddresses();
  initHotTxLimiter();
  for (const k of ["WETH","USDC","USDCe"] as const) {
    const addr = (ADDR as any)[k];
    if (addr) TOK[k] = await loadToken(addr);
  }
  console.log("Backrunner init OK. Account:", wallet.address);
  console.log("Routers:", { v2: ADDR.V2_ROUTER, v3Quoter: ADDR.V3_QUOTER, v3Router02: ADDR.V3_ROUTER02 });
  console.log("Pairs:", PAIRS);
  console.log("Config:", { ...CONFIG, DRY_RUN: dryRun });
  console.log("Hot TX limiter:", describeLimiter());
}

function f(x: bigint, d: number) { return ethers.formatUnits(x, d); }

async function quoteV2(amountIn: bigint, path: string[]) {
  const amounts: bigint[] = await withRetry("v2.getAmountsOut", () => v2.getAmountsOut(amountIn, path));
  return amounts[amounts.length - 1];
}
async function quoteV3Single(tokenIn: string, tokenOut: string, fee: number, amountIn: bigint) {
  const params = { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 };
  const res = await withRetry("v3.quoteExactInputSingle", () => v3Quoter.quoteExactInputSingle.staticCall(params));
  return res[0] as bigint;
}

type Opp = { pair: { a: string; b: string; v3Fee: number }; dir: "V3->V2" | "V2->V3"; grossA: bigint; notionalA: bigint; block: number };

async function scanBlock(blockNumber: number) {
  const now = new Date().toISOString();
  const opps: Opp[] = [];

  for (const p of PAIRS) {
    const A = (ADDR as any)[p.a] as string;
    const B = (ADDR as any)[p.b] as string;
    const decA = TOK[p.a].decimals;
    const notionalA = ethers.parseUnits(CONFIG.PROBE_NOTIONAL_A.toString(), decA);
    const pathAB = [A, B];
    const pathBA = [B, A];

    try {
      const v3Out = await quoteV3Single(A, B, p.v3Fee, notionalA);
      const v2Back= await quoteV2(v3Out, pathBA);
      const gross1 = v2Back - notionalA;

      const v2Out = await quoteV2(notionalA, pathAB);
      const v3Back= await quoteV3Single(B, A, p.v3Fee, v2Out);
      const gross2 = v3Back - notionalA;

      if (gross1 > 0n) opps.push({ pair: p, dir: "V3->V2", grossA: gross1, notionalA, block: blockNumber });
      if (gross2 > 0n) opps.push({ pair: p, dir: "V2->V3", grossA: gross2, notionalA, block: blockNumber });
    } catch (e: any) {
      console.warn(`[warn] quotes failed for ${p.a}/${p.b} @ block ${blockNumber}: ${e?.shortMessage || e?.message || e}`);
    }
  }

  if (!opps.length) {
    console.log(`[${now}] #${blockNumber} no opps`);
    return;
  }

  // Best opp for this block
  opps.sort((a, b) => (a.grossA > b.grossA ? -1 : 1));
  const best = opps[0];
  const decA = TOK[best.pair.a].decimals;

  console.log(`[${now}] #${blockNumber} BEST ${best.dir} ${best.pair.a}/${best.pair.b} fee=${best.pair.v3Fee} grossΔ=${f(best.grossA, decA)} ${best.pair.a}`);

  if (dryRun) return;

  if (!canSend()) {
    console.log(`[limit] TX cap reached. Policy=${CONFIG.ON_TX_LIMIT}.`);
    if (CONFIG.ON_TX_LIMIT === "dry_run") {
      dryRun = true;
      console.log(`[limit] Switching to DRY_RUN.`);
      return;
    }
    process.exit(0);
  }

  // === EXECUTION HOOK (wire your router call here) ===
  // await executeWithRouter(best);
  // On success:
  // recordSend();
  console.log(`[send] (sim) would execute ${best.dir} notional=${f(best.notionalA, TOK[best.pair.a].decimals)} ${best.pair.a}`);
  recordSend();
  console.log(`[limit] TX recorded. Remaining=${remaining() === Infinity ? "∞" : remaining()}.`);

  if (!canSend()) {
    if (CONFIG.ON_TX_LIMIT === "dry_run") {
      dryRun = true;
      console.log(`[limit] Cap reached; switching to DRY_RUN.`);
    } else {
      process.exit(0);
    }
  }
}

async function main() {
  await init();
  let last = await provider.getBlockNumber();
  console.log("Start polling from block", last);
  setInterval(async () => {
    try {
      const cur = await provider.getBlockNumber();
      if (cur !== last) {
        // reduce RPC load: scan latest only (optional toggle)
        if (CONFIG.SCAN_LATEST_ONLY) {
          await scanBlock(cur);
        } else {
          for (let b = last + 1; b <= cur; b++) await scanBlock(b);
        }
        last = cur;
      }
    } catch (e) {
      console.error("poll err", e);
    }
  }, CONFIG.POLL_INTERVAL_MS);
}

main().catch(e => { console.error(e); process.exit(1); });
