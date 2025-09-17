// src/searcher/dynamicSizing.ts
import { ethers } from "ethers";
import { CONFIG } from "./config";

const POOL_ABI = [
  "function liquidity() view returns (uint128)",
] as const;

/**
 * Find the ARB/WETH v3 pool address for a given fee from CONFIG.uni.pools.
 */
export function findArbWethPoolAddressByFee(fee: number): string | undefined {
  const ARB = (CONFIG as any)?.tokens?.ARB?.toLowerCase?.();
  const WETH = (CONFIG as any)?.tokens?.WETH?.toLowerCase?.();
  if (!ARB || !WETH) return undefined;

  const match = (a?: string, b?: string) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();

  return (CONFIG.uni.pools || []).find((p) => {
    if (p.fee !== fee) return false;
    const t0 = p.token0?.toLowerCase?.();
    const t1 = p.token1?.toLowerCase?.();
    return (
      (match(t0, ARB) && match(t1, WETH)) ||
      (match(t0, WETH) && match(t1, ARB))
    );
  })?.address;
}

/**
 * Heuristic dynamic sizing using Uniswap V3 pool "liquidity" (uint128).
 * NOTE: v3 liquidity is NOT in ETH; we only use it as a relative signal.
 *
 * For fee=500 (0.05%) we scale more conservatively based on measured liquidity.
 * For fee=3000 (0.3%) we keep 100%; for fee=10000 (1.0%) we use 75%.
 *
 * Returns bigint `adjustedSize` (in ARB 18d), chosen `sizeFactor`, and raw liquidity.
 */
export async function getDynamicTradeSize(
  provider: ethers.Provider,
  poolAddress: string,
  baseTradeSize: bigint,
  feeRate: number,
  opts?: { log?: boolean }
): Promise<{ adjustedSize: bigint; sizeFactor: number; liquidity: bigint }> {
  const log = opts?.log ?? false;

  try {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const liquidity: bigint = await pool.liquidity(); // v6 returns bigint

    // Heuristic only: normalize to a float for human-readable logs & thresholds.
    // (This is NOT "ETH"; just a convenient scale.)
    const liqScaled = Number(ethers.formatUnits(liquidity, 18));

    let sizeFactor: number;
    if (feeRate === 500) {
      if (liqScaled < 10)      sizeFactor = 0.10;  // very low liquidity → 10%
      else if (liqScaled < 100) sizeFactor = 0.25; // medium-low → 25%
      else                      sizeFactor = 0.50; // decent → 50%
    } else if (feeRate === 3000) {
      sizeFactor = 1.00; // typical most liquid
    } else if (feeRate === 10000) {
      sizeFactor = 0.75;
    } else {
      sizeFactor = 0.50; // conservative default
    }

    // Integer-safe scaling: use 2-decimal precision to avoid float→bigint issues
    const hundred = 100n;
    const pct = BigInt(Math.floor(sizeFactor * 100));
    const adjustedSize = (baseTradeSize * pct) / hundred;

    if (log) {
      console.log(`Pool ${poolAddress} (${feeRate / 100}%):`);
      console.log(`  liquidity(raw, ~scaled) ≈ ${liqScaled.toFixed(2)}`);
      console.log(`  sizeFactor             = ${sizeFactor}`);
      console.log(`  trade size (ARB)       = ${ethers.formatUnits(adjustedSize, 18)}`);
    }

    return { adjustedSize, sizeFactor, liquidity };
  } catch (e: any) {
    if (log) console.log(`Failed to read liquidity for ${poolAddress}:`, e?.message || e);
    // Very conservative fallback on error
    return { adjustedSize: baseTradeSize / 10n, sizeFactor: 0.1, liquidity: 0n };
  }
}
