// src/searcher/liquidation.ts
import "dotenv/config";
import { ethers } from "ethers";
import type { InterfaceAbi } from "ethers";

import { CONFIG } from "./config";
import { getAavePool } from "./aave";
import { getRadiantPool } from "./radiant";
import {
  getUniversalRouter,
  encodeV3ExactIn,
  bytesConcat,
  Commands,
  encodeV3Path,
} from "./universalRouter";

// Pull ONLY the ABI array for ethers v6
const { abi: ArbiRouterAbi } = require("./abi/ArbiSearcherRouter.json") as {
  abi: InterfaceAbi;
};

type Step = { target: string; data: string; value: bigint };

function reqAddr(label: string, v?: string): string {
  const s = (v || "").trim();
  if (!ethers.isAddress(s)) throw new Error(`Invalid ${label}: ${v}`);
  return ethers.getAddress(s);
}
function toBigIntSafe(v: unknown, fallback = 0n): bigint {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    if (typeof v === "string") {
      const t = v.trim();
      return t.startsWith("0x") ? BigInt(t) : BigInt(t);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Execute liquidation and swap seized collateral -> ... -> WETH via Universal Router V3.
 * Assumptions:
 * - debtAsset is WETH (repay in WETH).
 * - v3PathTokens MUST end with WETH (same addr as debtAsset).
 * - amountIn for UR V3 swap is set to 0 (spend balance pattern), minOut enforced via minOutWETH.
 */
export async function execLiquidation({
  signer,
  protocol,
  collateral,
  debtAsset,
  user,
  debtToCover,
  v3PathTokens,
  v3PathFees,
  minOutWETH,
}: {
  signer: ethers.Wallet;
  protocol: "aave" | "radiant";
  collateral: string;
  debtAsset: string;        // WETH on Arbitrum
  user: string;
  debtToCover: bigint;      // amount of WETH to repay
  v3PathTokens: string[];   // must end with WETH
  v3PathFees: number[];
  minOutWETH: bigint;       // required min WETH out from UR swap
}): Promise<ethers.TransactionRequest> {
  if (!signer.provider) throw new Error("Signer must be connected to a provider");

  const routerAddr =
    (process.env.ROUTER_ADDRESS && reqAddr("ROUTER_ADDRESS", process.env.ROUTER_ADDRESS)) ||
    reqAddr("CONFIG.router", (CONFIG as any)?.router);

  const collateralAddr = reqAddr("collateral", collateral);
  const debtAssetAddr  = reqAddr("debtAsset (WETH)", debtAsset);
  const userAddr       = reqAddr("user", user);

  if (!Array.isArray(v3PathTokens) || v3PathTokens.length < 2) {
    throw new Error("v3PathTokens must have at least 2 addresses");
  }
  if (v3PathFees.length !== v3PathTokens.length - 1) {
    throw new Error("v3PathFees length must equal v3PathTokens.length - 1");
  }

  const pathTokens = v3PathTokens.map((t, i) => reqAddr(`v3PathTokens[${i}]`, t));
  const pathTail = pathTokens[pathTokens.length - 1];
  if (ethers.getAddress(pathTail) !== ethers.getAddress(debtAssetAddr)) {
    throw new Error(
      `defaultPath must end with WETH (debtAsset). Tail=${pathTail}, debtAsset=${debtAssetAddr}`
    );
  }

  // Protocol pool & Universal Router
  const pool = protocol === "aave" ? getAavePool(signer) : getRadiantPool(signer);
  const ur   = getUniversalRouter(signer);

  // Your custom searcher router
  const router = new ethers.Contract(routerAddr, ArbiRouterAbi, signer);

  // (1) Encode liquidation (repay in WETH)
  const liqData = pool.interface.encodeFunctionData("liquidationCall", [
    collateralAddr,
    debtAssetAddr,
    userAddr,
    toBigIntSafe(debtToCover, 0n),
    false, // receiveAToken=false
  ]);

  // (2) Encode UniversalRouter V3 exact-in swap from liquidation proceeds -> WETH
  const path     = encodeV3Path(pathTokens, v3PathFees);
  const deadline = Math.floor(Date.now() / 1000) + 60;
  const commands = bytesConcat([Commands.V3_SWAP_EXACT_IN]);

  // UR receives from router (so proceeds land there), amountIn=0 (spend balance), enforce minOutWETH
  const urInput = encodeV3ExactIn(path, routerAddr, 0n, minOutWETH);
  const urData  = ur.interface.encodeFunctionData("execute", [commands, [urInput], deadline]);

  const steps: Step[] = [
    { target: pool.target as string, data: liqData, value: 0n },
    { target: ur.target as string,   data: urData,  value: 0n },
  ];

  // Try exec(tokenOut, minOut, steps) first; fall back to exec(steps)
  let data: string;
  try {
    data = router.interface.encodeFunctionData("exec", [
      debtAssetAddr,               // tokenOut = WETH
      toBigIntSafe(minOutWETH, 0n),
      steps,
    ]);
  } catch {
    data = router.interface.encodeFunctionData("exec", [steps]);
  }

  return signer.populateTransaction({
    to: router.target as string,
    data,
    value: 0n,
  });
}
