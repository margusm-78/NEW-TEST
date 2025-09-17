import type { InterfaceAbi } from "ethers";

/** Narrow any readonly ABI literal to ethers v6 InterfaceAbi cleanly */
export function asInterfaceAbi<T extends ReadonlyArray<string>>(abi: T): InterfaceAbi {
  return abi as unknown as InterfaceAbi;
}
