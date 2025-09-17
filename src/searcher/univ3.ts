import { ethers } from "ethers";
import type { InterfaceAbi } from "ethers";
import { asInterfaceAbi } from "../abi-helpers";
import { CONFIG } from "./config";
import { RP } from "./resilientProvider";

/* ---------- Minimal ABIs ---------- */
const QuoterV2Abi = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96)) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
] as const;

const FactoryAbi = [
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
] as const;

const PoolAbi = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
] as const;

/* ---------- Types ---------- */
export type Pool = {
  name: string;
  address: string; // informational (we look up per fee)
  token0: string;  // "ARB"
  token1: string;  // "WETH"
  fee: number;     // 500 / 3000 / 10000 etc
};

/* ---------- Helpers ---------- */
export function tokenAddress(symbol: "ARB" | "WETH"): string {
  // @ts-ignore
  const addr = CONFIG.tokens[symbol];
  if (!addr || !ethers.isAddress(addr)) throw new Error(`Bad token addr for ${symbol}: ${addr}`);
  return ethers.getAddress(addr);
}

/** Return [ {fee, pool} ] for fees that have a live pool w/ non-zero liquidity */
async function feesWithLivePools(
  tokenA: string,
  tokenB: string,
  fees: number[],
): Promise<Array<{ fee: number; pool: string }>> {
  const factoryAddr = CONFIG.uni.factory;
  const out: Array<{ fee: number; pool: string }> = [];

  for (const fee of fees) {
    try {
      const poolAddr: string = await RP.withProvider((p) =>
        new ethers.Contract(factoryAddr, asInterfaceAbi(FactoryAbi) as InterfaceAbi, p).getPool(tokenA, tokenB, fee)
      );

      if (!poolAddr || poolAddr === ethers.ZeroAddress) continue;

      const [slot0, liq] = await Promise.all([
        RP.withProvider((p) => new ethers.Contract(poolAddr, asInterfaceAbi(PoolAbi) as InterfaceAbi, p).slot0()),
        RP.withProvider((p) => new ethers.Contract(poolAddr, asInterfaceAbi(PoolAbi) as InterfaceAbi, p).liquidity()),
      ]);

      const sqrt = slot0 ? (slot0[0] as bigint) : 0n;
      const liquidity = typeof liq === "bigint" ? liq : 0n;

      if (sqrt !== 0n && liquidity > 0n) out.push({ fee, pool: poolAddr });
    } catch {
      // ignore fee tier if any call fails
    }
  }
  return out;
}

/** Hardened QuoterV2 exactInputSingle */
export async function quoteExactInputSingle(
  _provider: ethers.JsonRpcProvider, // kept for signature parity
  fee: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<bigint> {
  const quoter = CONFIG.uni.quoter;
  let lastErr: any = null;

  try {
    const quoted = await RP.withProvider((p) =>
      new ethers.Contract(quoter, asInterfaceAbi(QuoterV2Abi) as InterfaceAbi, p)
        .quoteExactInputSingle
        .staticCall({ tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96: 0 })
    );
    const amountOut = (quoted as any)?.amountOut ?? (quoted as bigint);
    return amountOut as bigint;
  } catch (e) {
    lastErr = e;
  }

  throw new Error(
    `Quoter failed inputSingle: tokenIn=${tokenIn}, tokenOut=${tokenOut}, fee=${fee}, amountIn=${amountIn.toString()} :: ${(lastErr as any)?.message || lastErr}`
  );
}

/** Pick two ARB/WETH fees (present & live) for 2-hop (ARB->WETH on feeA, WETH->ARB on feeB) */
export async function resolveTwoArbWethPools(preferredFees: number[]): Promise<{ feeA: number; feeB: number; poolA?: string; poolB?: string }> {
  const ARB = tokenAddress("ARB");
  const WETH = tokenAddress("WETH");

  // Check both directions share the same live fee set
  const live = await feesWithLivePools(ARB, WETH, preferredFees);
  if (live.length < 2) {
    // if only one available, still return it twice (exec will be skipped unless profitable)
    const f0 = live[0]?.fee ?? preferredFees[0];
    return { feeA: f0, feeB: f0, poolA: live[0]?.pool, poolB: live[0]?.pool };
  }
  // Use top two in the given priority
  const feeA = live[0].fee;
  const feeB = live[1].fee;
  return { feeA, feeB, poolA: live[0].pool, poolB: live[1].pool };
}

/** Basis-point slippage */
export function applySlippage(amount: bigint, bps: number, negative = true): bigint {
  const num = amount * BigInt(10000 + (negative ? -bps : bps));
  return num / 10000n;
}
