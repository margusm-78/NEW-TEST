import "dotenv/config";
import { ethers } from "ethers";
import type { InterfaceAbi } from "ethers";
import { CONFIG } from "./config";

const AAVE_POOL_ABI: InterfaceAbi = [
  // liquidationCall(address collateral, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)
  "function liquidationCall(address,address,address,uint256,bool)"
];

function requireAddr(label: string, v?: string): string {
  const s = (v || "").trim();
  if (!ethers.isAddress(s)) throw new Error(`Missing/invalid ${label}: ${v}`);
  return ethers.getAddress(s);
}

/** Returns an Aave pool contract with the minimal ABI for liquidationCall */
export function getAavePool(signerOrProvider: ethers.Signer | ethers.Provider) {
  const addr =
    process.env.AAVE_POOL ||
    (CONFIG as any)?.lending?.aave?.pool ||
    (CONFIG as any)?.aave?.pool;

  const poolAddr = requireAddr("AAVE_POOL", addr);
  return new ethers.Contract(poolAddr, AAVE_POOL_ABI, signerOrProvider);
}
