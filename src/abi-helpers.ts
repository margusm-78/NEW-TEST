// src/abi-helpers.ts
import type { InterfaceAbi } from "ethers";

/** Narrow anything (json abi, readonly tuple, etc.) to ethers v6 InterfaceAbi */
export function asInterfaceAbi(abi: unknown): InterfaceAbi {
  return abi as unknown as InterfaceAbi;
}
