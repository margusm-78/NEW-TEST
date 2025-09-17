import "dotenv/config";
import { ethers } from "ethers";
import type { InterfaceAbi } from "ethers";
import { CONFIG } from "./config";

const RADIANT_POOL_ABI: InterfaceAbi = [
  // Many Radiant deployments mirror Aave's liquidation signature
  "function liquidationCall(address,address,address,uint256,bool)"
];

function requireAddr(label: string, v?: string): string {
  const s = (v || "").trim();
  if (!ethers.isAddress(s)) throw new Error(`Missing/invalid ${label}: ${v}`);
  return ethers.getAddress(s);
}

/** Returns a Radiant pool contract with the minimal ABI for liquidationCall */
export function getRadiantPool(signerOrProvider: ethers.Signer | ethers.Provider) {
  const addr =
    process.env.RADIANT_POOL ||
    (CONFIG as any)?.lending?.radiant?.pool ||
    (CONFIG as any)?.radiant?.pool;

  const poolAddr = requireAddr("RADIANT_POOL", addr);
  return new ethers.Contract(poolAddr, RADIANT_POOL_ABI, signerOrProvider);
}
