import { ethers } from "ethers";
import { CONFIG } from "./config";
import { tokenAddress, quoteExactInputSingle, applySlippage } from "./univ3";

/**
 * Simulate ARB->WETH on feeA, then WETH->ARB on feeB.
 * Returns gross/min outputs in ARB plus intermediate WETH.
 */
export async function simulateTwoHopArbWeth(
  fees: [number, number],
  amountInARB: bigint
) {
  const ARB  = tokenAddress("ARB");
  const WETH = tokenAddress("WETH");

  // Hop 1: ARB -> WETH on feeA
  const hop1OutWETH = await quoteExactInputSingle(null as unknown as ethers.JsonRpcProvider, fees[0], ARB, WETH, amountInARB);

  // Hop 2: WETH -> ARB on feeB
  const grossOutARB = await quoteExactInputSingle(null as unknown as ethers.JsonRpcProvider, fees[1], WETH, ARB, hop1OutWETH);

  const minOutARB = applySlippage(grossOutARB, Number(process.env.MAX_SLIPPAGE_BPS ?? "50"), true);

  return { inARB: amountInARB, hop1OutWETH, grossOutARB, minOutARB };
}

/** EV in ARB: gross - in - gasInARB (we convert gas WETH→ARB) */
export function evEstimateARB(grossOutARB: bigint, inARB: bigint, gasARB: bigint): bigint {
  return grossOutARB - inARB - gasARB;
}
