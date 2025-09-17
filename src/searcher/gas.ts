import { ethers } from "ethers";
import { RP } from "./resilientProvider";
import { tokenAddress, quoteExactInputSingle } from "./univ3";

/** Minimal tx-like for estimation */
type TxLike = {
  to: string;
  data: string;
  value?: bigint;
  from?: string;
};

export type GasQuote = {
  gasLimit: bigint;
  gasPriceWei: bigint;
  gasWei: bigint;
  wethCostWei: bigint; // equal to gasWei (1 WETH == 1 ETH)
  gasAsArb: bigint;    // ARB-equivalent of gas (via quoter WETH->ARB)
};

/** Conservative, EIP-1559 aware gas cost; convert to ARB via WETH->ARB quote */
export async function estimateGasARB(
  _provider: ethers.JsonRpcProvider,
  tx: TxLike,
  feeForWethToArb: number // fee tier used to convert gas (WETH->ARB)
): Promise<GasQuote> {
  // 1) Estimate limit with provider rotation
  const gasLimit = await RP.withProvider((p) =>
    p.estimateGas({
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      ...(tx.from ? { from: tx.from } : {}),
    })
  );

  // 2) Gas price (prefer maxFeePerGas; fallback gasPrice)
  const feeData = await RP.withProvider((p) => p.getFeeData());
  const gasPriceWei =
    (feeData.maxFeePerGas ?? feeData.gasPrice ?? 1_000_000_000n); // 1 gwei fallback on weird nodes
  const gasWei = gasLimit * gasPriceWei;

  // 3) Convert WETH->ARB for gas amount (gasWei is wei, same decimals as WETH/ETH)
  const WETH = tokenAddress("WETH");
  const ARB  = tokenAddress("ARB");
  let gasAsArb = 0n;

  try {
    gasAsArb = await quoteExactInputSingle(null as unknown as ethers.JsonRpcProvider, feeForWethToArb, WETH, ARB, gasWei);
  } catch {
    // If quoter fails sporadically, use a conservative *2x* safety on gas
    gasAsArb = 0n; // leave 0 and upstream will keep higher EV guard via minProfit
  }

  return {
    gasLimit,
    gasPriceWei,
    gasWei,
    wethCostWei: gasWei,
    gasAsArb,
  };
}
