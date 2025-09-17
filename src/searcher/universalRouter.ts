// src/searcher/universalRouter.ts
import "dotenv/config";
import { ethers } from "ethers";
import type { InterfaceAbi } from "ethers";
import { ROUTERS, CONFIG } from "./config";
import { tokenAddress } from "./univ3";

// Pull ONLY the ABI array (InterfaceAbi for ethers v6)
const { abi: UNIVERSAL_ROUTER_ABI } = require("./abi/UniversalRouter.json") as {
  abi: InterfaceAbi;
};

// 0x00 = V3_SWAP_EXACT_IN
export const Commands = { V3_SWAP_EXACT_IN: 0x00 } as const;

export const TOKENS = {
  ARB: tokenAddress("ARB"),
  WETH: tokenAddress("WETH"),
} as const;

export function defaultArbWethFee(): number {
  const cfg = Number((CONFIG as any)?.uni?.priceFee);
  return Number.isFinite(cfg) && cfg > 0 ? cfg : 500;
}

/** Get Universal Router (or fallback to SwapRouter02 address if your config lacks UR). */
export function getUniversalRouter(
  providerOrSigner: ethers.Provider | ethers.Signer
) {
  const raw =
    (ROUTERS as any).universalRouter ||
    (ROUTERS as any).swapRouter02; // <-- fallback
  if (!raw || !ethers.isAddress(raw)) {
    throw new Error("Router address not set or invalid in config (universalRouter/swapRouter02)");
  }
  const addr = ethers.getAddress(raw);
  return new ethers.Contract(addr, UNIVERSAL_ROUTER_ABI, providerOrSigner);
}

/** Encode Uniswap V3 multi-hop path. */
export function encodeV3Path(tokens: string[], fees: number[]): string {
  if (!Array.isArray(tokens) || !Array.isArray(fees)) throw new Error("Invalid path args");
  if (tokens.length !== fees.length + 1)
    throw new Error("Invalid path: tokens.length must equal fees.length + 1");
  let pathHex = "0x";
  for (let i = 0; i < fees.length; i++) {
    const t = tokens[i];
    if (!ethers.isAddress(t)) throw new Error(`Invalid token address at index ${i}: ${t}`);
    const fee = fees[i];
    if (!Number.isFinite(fee) || fee < 0 || fee > 1_000_000) {
      throw new Error(`Invalid fee at index ${i}: ${fee}`);
    }
    const feeHex = fee.toString(16).padStart(6, "0");
    pathHex += t.slice(2);
    pathHex += feeHex;
  }
  const last = tokens[tokens.length - 1];
  if (!ethers.isAddress(last)) throw new Error(`Invalid token address at tail: ${last}`);
  pathHex += last.slice(2);
  return pathHex.toLowerCase();
}

export function buildArbToWethPath(fee = defaultArbWethFee()): string {
  return encodeV3Path([TOKENS.ARB, TOKENS.WETH], [fee]);
}

export function encodeV3ExactIn(
  path: string,
  recipient: string,
  amountIn: bigint,
  amountOutMinimum: bigint
): string {
  const rcpt = ethers.getAddress(recipient);
  const types = ["bytes", "address", "uint256", "uint256"] as const;
  const values = [path, rcpt, amountIn, amountOutMinimum] as const;
  return ethers.AbiCoder.defaultAbiCoder().encode(types, values);
}

export function bytesConcat(arr: number[]): string {
  const u8 = new Uint8Array(arr);
  return ethers.hexlify(u8);
}

export function deadlineFromNow(seconds: number): bigint {
  const now = Math.floor(Date.now() / 1000);
  return BigInt(now + Math.max(0, Math.floor(seconds)));
}
