// src/searcher/price.ts
import { ethers } from "ethers";
import { CONFIG } from "./config";
import { tokenAddress } from "./univ3";
import type { InterfaceAbi } from "ethers";
import { asInterfaceAbi } from "../abi-helpers";
import { RP } from "./resilientProvider";

/**
 * Correct QuoterV2 ABI with struct order:
 * tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96
 */
const QUOTER_V2_ABI_JSON = [
  {
    "type": "function",
    "stateMutability": "nonpayable",
    "outputs": [
      { "type": "uint256", "name": "amountOut", "internalType": "uint256" },
      { "type": "uint160", "name": "sqrtPriceX96After", "internalType": "uint160" },
      { "type": "uint32",  "name": "initializedTicksCrossed", "internalType": "uint32" },
      { "type": "uint256", "name": "gasEstimate", "internalType": "uint256" }
    ],
    "name": "quoteExactInputSingle",
    "inputs": [
      {
        "type": "tuple",
        "name": "params",
        "components": [
          { "type": "address", "name": "tokenIn", "internalType": "address" },
          { "type": "address", "name": "tokenOut", "internalType": "address" },
          { "type": "uint256", "name": "amountIn", "internalType": "uint256" },
          { "type": "uint24",  "name": "fee", "internalType": "uint24" },
          { "type": "uint160", "name": "sqrtPriceLimitX96", "internalType": "uint160" }
        ],
        "internalType": "struct IQuoterV2.QuoteExactInputSingleParams"
      }
    ]
  }
] as const;

function feesToTry(): number[] {
  const cfg = Number((CONFIG as any)?.uni?.priceFee);
  return [Number.isFinite(cfg) && cfg > 0 ? cfg : 500, 500, 3000, 10000].filter(
    (v, i, a) => typeof v === "number" && v > 0 && a.indexOf(v) === i
  );
}

function decodeErr(err: any): string {
  const short = err?.shortMessage || err?.message;
  const data = err?.info?.error?.data || err?.error?.data;
  const code = err?.code || err?.info?.code;
  if (short) return String(short);
  if (data) return `reverted (data len=${String(data).length})`;
  if (code) return `error code ${code}`;
  return String(err ?? "unknown error");
}

type QuoteParams = {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
  sqrtPriceLimitX96?: bigint;
};

async function staticQuote(
  p: ethers.JsonRpcProvider,
  params: QuoteParams
): Promise<bigint> {
  const quoter = new ethers.Contract(
    (CONFIG as any).uni.quoter,
    asInterfaceAbi(QUOTER_V2_ABI_JSON) as InterfaceAbi,
    p
  );
  try {
    const res = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      fee: params.fee,
      sqrtPriceLimitX96: params.sqrtPriceLimitX96 ?? 0n,
    });
    const out = (res as any)?.amountOut ?? (res as bigint);
    return BigInt(out);
  } catch (e: any) {
    throw new Error(
      `QuoterV2 revert (fee ${params.fee}) ${params.tokenIn}->${params.tokenOut}: ${decodeErr(
        e
      )}`
    );
  }
}

export async function quoteExactInputBestFee(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint
): Promise<{ amountOut: bigint; feeUsed: number }> {
  let lastErr: unknown = null;
  for (const [i, fee] of feesToTry().entries()) {
    try {
      const amountOut = await RP.withProvider((p) =>
        staticQuote(p, { tokenIn, tokenOut, fee, amountIn })
      );
      return { amountOut, feeUsed: fee };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 120 + i * 60));
    }
  }
  throw new Error(
    `Quoter failed ${tokenIn}->${tokenOut}. Last error: ${
      (lastErr as any)?.message ?? String(lastErr)
    }`
  );
}

/** Primary: ARB -> WETH quote */
export async function quoteArbToWeth(amountInArb: bigint) {
  const ARB = tokenAddress("ARB");
  const WETH = tokenAddress("WETH");
  return quoteExactInputBestFee(ARB, WETH, amountInArb);
}
