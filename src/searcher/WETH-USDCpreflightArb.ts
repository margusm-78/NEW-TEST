// src/searcher/preflightArb.ts
import "dotenv/config";
import { ethers } from "ethers";
import { ADDR, PAIRS, validateAddresses, debugAddressResolution } from "./dex/addresses.arb";
import { ERC20_ABI, UNIV2_ROUTER_ABI, UNIV3_QUOTER_V2_ABI, UNIV3_FACTORY_ABI } from "./dex/abis";
import { CONFIG } from "./backrunConfig";
import { withRetry } from "./rpc";

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

async function quoteV2(v2: ethers.Contract, amountIn: bigint, path: string[]) {
  const amounts: bigint[] = await withRetry("v2.getAmountsOut", () => v2.getAmountsOut(amountIn, path));
  return amounts[amounts.length - 1];
}

// QuoterV2 must be static-called in ethers v6, and retried on 429s
async function quoteV3Single(v3Quoter: ethers.Contract, tokenIn: string, tokenOut: string, fee: number, amountIn: bigint) {
  const params = { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 };
  const res = await withRetry("v3.quoteExactInputSingle", () => v3Quoter.quoteExactInputSingle.staticCall(params));
  return res[0] as bigint;
}

async function getV3PoolsForPairs(v3Factory: ethers.Contract): Promise<string[]> {
  const pools: string[] = [];
  for (const p of PAIRS) {
    const A = (ADDR as any)[p.a] as string;
    const B = (ADDR as any)[p.b] as string;
    const pool: string = await v3Factory.getPool(A, B, p.v3Fee);
    if (pool && pool !== ethers.ZeroAddress) pools.push(ethers.getAddress(pool));
  }
  return pools;
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

  const v2        = new ethers.Contract(ADDR.V2_ROUTER, UNIV2_ROUTER_ABI, http);
  const v3Quoter  = new ethers.Contract(ADDR.V3_QUOTER, UNIV3_QUOTER_V2_ABI, http);
  const v3Factory = new ethers.Contract(ADDR.V3_FACTORY, UNIV3_FACTORY_ABI, http);

  const tokens = ["WETH","USDC","USDCe"].filter(k => (ADDR as any)[k]);
  const infos: Record<string, Awaited<ReturnType<typeof ercInfo>>> = {};
  for (const t of tokens) {
    const addr = (ADDR as any)[t] as string;
    const info = await ercInfo(addr);
    infos[t] = info;
    console.log(`\nToken ${t} @ ${addr}`);
    console.log(`  name=${info.name} symbol=${info.symbol} decimals=${info.decimals}`);
    console.log(`  balance=${f(info.balance, info.decimals)}`);
  }

  for (const t of tokens) {
    const addr = (ADDR as any)[t] as string;
    const alV2 = await allowance(wallet.address, addr, ADDR.V2_ROUTER);
    const alV3 = await allowance(wallet.address, addr, ADDR.V3_ROUTER02);
    console.log(`Allowance ${t}:`);
    console.log(`  V2_ROUTER(${ADDR.V2_ROUTER}) = ${alV2.toString()}`);
    console.log(`  V3_ROUTER02(${ADDR.V3_ROUTER02}) = ${alV3.toString()}`);
  }

  const pools = await getV3PoolsForPairs(v3Factory);
  console.log("\nDiscovered Uniswap V3 pools:", pools.length ? pools : "(none)");

  const probe = CONFIG.PROBE_NOTIONAL_A;

  console.log(`\n--- Dry-run quotes (probe = ${probe} of token A) ---`);
  for (const p of PAIRS) {
    const A = (ADDR as any)[p.a] as string;
    const B = (ADDR as any)[p.b] as string;
    const decA = infos[p.a].decimals;
    const decB = infos[p.b].decimals;

    const notionalA = ethers.parseUnits(probe.toString(), decA);
    const pathAB = [A, B];
    const pathBA = [B, A];

    try {
      const v3Out = await quoteV3Single(v3Quoter, A, B, p.v3Fee, notionalA);
      const v2Back= await quoteV2(v2, v3Out, pathBA);
      const gross1 = v2Back - notionalA;

      const v2Out = await quoteV2(v2, notionalA, pathAB);
      const v3Back= await quoteV3Single(v3Quoter, B, A, p.v3Fee, v2Out);
      const gross2 = v3Back - notionalA;

      console.log(`\nPair ${p.a}/${p.b} (fee ${p.v3Fee})`);
      console.log(`  A->B (V3): ${p.a} ${probe} -> ${p.b} ${ethers.formatUnits(v3Out, decB)}`);
      console.log(`  B->A (V2): -> ${p.a} ${ethers.formatUnits(v2Back, decA)} | grossΔ=${ethers.formatUnits(gross1, decA)} ${p.a}`);
      console.log(`  A->B (V2): ${p.a} ${probe} -> ${p.b} ${ethers.formatUnits(v2Out, decB)}`);
      console.log(`  B->A (V3): -> ${p.a} ${ethers.formatUnits(v3Back, decA)} | grossΔ=${ethers.formatUnits(gross2, decA)} ${p.a}`);
    } catch (e: any) {
      console.warn(`  [warn] quotes failed for ${p.a}/${p.b}: ${e?.shortMessage || e?.message || e}`);
    }
  }

  console.log("\nPreflight complete.");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
