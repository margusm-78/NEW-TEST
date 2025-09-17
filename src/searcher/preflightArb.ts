// src/searcher/preflightArb.ts
import "dotenv/config";
import { ethers } from "ethers";
import { ADDR, PAIRS, validateAddresses, debugAddressResolution } from "./dex/addresses.arb";
import { ERC20_ABI, UNIV2_ROUTER_ABI, UNIV3_QUOTER_V2_ABI, UNIV3_FACTORY_ABI } from "./dex/abis";
import { CONFIG } from "./backrunConfig";

const http = new ethers.JsonRpcProvider(process.env.ARB_RPC_URL!, { name: "arbitrum", chainId: 42161 });
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, http);

function f(x: bigint, d: number) { return ethers.formatUnits(x, d); }

async function ercInfo(token: string) {
  const erc = new ethers.Contract(token, ERC20_ABI, http);
  const [name, symbol, decimals, balance] = await Promise.all([
    erc.name(), erc.symbol(), erc.decimals(), erc.balanceOf(wallet.address)
  ]);
  return { name, symbol, decimals: Number(decimals), balance: balance as bigint };
}

async function allowance(owner: string, token: string, spender: string) {
  const erc = new ethers.Contract(token, ERC20_ABI, http);
  return (await erc.allowance(owner, spender)) as bigint;
}

async function v2Out(amountIn: bigint, path: string[]) {
  const v2 = new ethers.Contract(ADDR.V2_ROUTER, UNIV2_ROUTER_ABI, http);
  const amounts: bigint[] = await v2.getAmountsOut(amountIn, path);
  return amounts[amounts.length - 1];
}
async function v2Best(amountIn: bigint, from: string, to: string): Promise<{ path: string[]; out: bigint }> {
  const tries: string[][] = [[from, to]];
  if (ADDR.USDC) tries.push([from, ADDR.USDC, to]);
  if (ADDR.USDCe) tries.push([from, ADDR.USDCe, to]);
  let best: { path: string[]; out: bigint } | null = null;
  for (const p of tries) {
    try {
      const out = await v2Out(amountIn, p);
      if (!best || out > best.out) best = { path: p, out };
    } catch { /* ignore */ }
  }
  if (!best) throw new Error("no v2 path succeeded");
  return best;
}

async function v3Single(tokenIn: string, tokenOut: string, fee: number, amountIn: bigint) {
  const v3Quoter = new ethers.Contract(ADDR.V3_QUOTER, UNIV3_QUOTER_V2_ABI, http);
  const params = { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 };
  // QuoterV2 must be static-called in ethers v6
  const res = await v3Quoter.quoteExactInputSingle.staticCall(params);
  return res[0] as bigint;
}

async function v3Pool(A: string, B: string, fee: number) {
  const fac = new ethers.Contract(ADDR.V3_FACTORY, UNIV3_FACTORY_ABI, http);
  return await fac.getPool(A, B, fee);
}

async function main() {
  console.log("=== ARBITRUM PREFLIGHT ===");
  console.log("RPC:", process.env.ARB_RPC_URL || "(missing)");
  console.log("Account:", wallet.address);
  console.log("MinProfit USDC:", CONFIG.MIN_PROFIT_USDC, "Probe Notional A:", CONFIG.PROBE_NOTIONAL_A);

  const table = debugAddressResolution();
  console.log("\nAddress resolution:");
  console.log(JSON.stringify(table, null, 2));

  validateAddresses();

  const tokens = ["ARB","WETH","USDC","USDCe"].filter(k => (ADDR as any)[k]);
  const info: Record<string, { name: string; symbol: string; decimals: number; balance: bigint }> = {};
  for (const t of tokens) {
    const addr = (ADDR as any)[t] as string;
    const i = await ercInfo(addr);
    info[t] = i;
    console.log(`\nToken ${t} @ ${addr}`);
    console.log(`  name=${i.name} symbol=${i.symbol} decimals=${i.decimals}`);
    console.log(`  balance=${f(i.balance, i.decimals)}`);
  }

  for (const t of tokens) {
    const addr = (ADDR as any)[t] as string;
    const alV2 = await allowance(wallet.address, addr, ADDR.V2_ROUTER);
    const alV3 = await allowance(wallet.address, addr, ADDR.V3_ROUTER02);
    console.log(`Allowance ${t}:`);
    console.log(`  V2_ROUTER(${ADDR.V2_ROUTER}) = ${alV2.toString()}`);
    console.log(`  V3_ROUTER02(${ADDR.V3_ROUTER02}) = ${alV3.toString()}`);
  }

  // Pool discovery for v3 (should be 0xc6f78049...d6396a for ARB/WETH@500)
  const pools: string[] = [];
  for (const p of PAIRS) {
    const A = (ADDR as any)[p.a] as string;
    const B = (ADDR as any)[p.b] as string;
    const pool = await v3Pool(A, B, p.v3Fee);
    if (pool && pool !== ethers.ZeroAddress) pools.push(ethers.getAddress(pool));
  }
  console.log("\nDiscovered Uniswap V3 pools:", pools.length ? pools : "(none)");

  // Quotes
  const probe = CONFIG.PROBE_NOTIONAL_A;
  console.log(`\n--- Dry-run quotes (probe = ${probe} of token A) ---`);
  for (const p of PAIRS) {
    const A = (ADDR as any)[p.a] as string;
    const B = (ADDR as any)[p.b] as string;
    const decA = info[p.a].decimals;
    const decB = info[p.b].decimals;
    const notionalA = ethers.parseUnits(probe.toString(), decA);

    try {
      const v3Out = await v3Single(A, B, p.v3Fee, notionalA);
      const bestBack = await v2Best(v3Out, B, A);  // V3->V2
      const gross1 = bestBack.out - notionalA;

      const bestOut = await v2Best(notionalA, A, B); // V2->V3
      const v3Back  = await v3Single(B, A, p.v3Fee, bestOut.out);
      const gross2  = v3Back - notionalA;

      console.log(`\nPair ${p.a}/${p.b} (fee ${p.v3Fee})`);
      console.log(`  A->B (V3): ${p.a} ${probe} -> ${p.b} ${ethers.formatUnits(v3Out, decB)}`);
      console.log(`  B->A (V2): via [${bestBack.path.join(" -> ")}] -> ${p.a} ${ethers.formatUnits(bestBack.out, decA)} | grossΔ=${ethers.formatUnits(gross1, decA)} ${p.a}`);
      console.log(`  A->B (V2): via [${bestOut.path.join(" -> ")}] -> ${p.b} ${ethers.formatUnits(bestOut.out, decB)}`);
      console.log(`  B->A (V3): -> ${p.a} ${ethers.formatUnits(v3Back, decA)} | grossΔ=${ethers.formatUnits(gross2, decA)} ${p.a}`);
    } catch (e: any) {
      console.warn(`  [warn] quotes failed for ${p.a}/${p.b}: ${e?.shortMessage || e?.message || e}`);
    }
  }

  console.log("\nPreflight complete.");
}

main().catch(e => { console.error(e); process.exit(1); });
