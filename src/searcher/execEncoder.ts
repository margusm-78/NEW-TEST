// src/searcher/execEncoder.ts
import { ethers } from "ethers";

export type Step = { target: string; data: string; value: bigint };

/**
 * Build a stable exec encoder by probing your router ABI for the right overload & tuple layout.
 * It tries, in order:
 *  - exec(address,uint256,(address,bytes,uint256)[])
 *  - exec((address,bytes,uint256)[])
 *  - exec(address,uint256,(address,uint256,bytes)[])
 *  - exec((address,uint256,bytes)[])
 */
export function makeExecEncoder(router: ethers.Contract) {
  const iface = router.interface;

  // prebuild both tuple order arrays from a given Step[]
  const map_t_d_v = (steps: Step[]) => steps.map(s => [s.target, s.data, s.value]); // (address,bytes,uint256)
  const map_t_v_d = (steps: Step[]) => steps.map(s => [s.target, s.value, s.data]); // (address,uint256,bytes)

  const trySig = (sig: string, args: any[]) => {
    try { return iface.encodeFunctionData(sig, args); } catch { return undefined; }
  };

  // Probe once with a harmless dummy payload to lock the signature:
  const dummySteps: Step[] = [{ target: router.target as string, data: "0x", value: 0n }];

  const candidates: Array<{sig: string, mapper: (s: Step[])=>any[], kind: "3arg"|"1arg"}> = [
    { sig: "exec(address,uint256,(address,bytes,uint256)[])", mapper: (s)=>[(router.target as string), 0n, map_t_d_v(s)], kind: "3arg" },
    { sig: "exec((address,bytes,uint256)[])",                 mapper: (s)=>[map_t_d_v(s)],                                     kind: "1arg" },
    { sig: "exec(address,uint256,(address,uint256,bytes)[])", mapper: (s)=>[(router.target as string), 0n, map_t_v_d(s)], kind: "3arg" },
    { sig: "exec((address,uint256,bytes)[])",                 mapper: (s)=>[map_t_v_d(s)],                                     kind: "1arg" },
  ];

  let picked: { sig: string; mapper: (s: Step[])=>any[]; kind: "3arg"|"1arg" } | undefined;

  for (const c of candidates) {
    const encoded = trySig(c.sig, c.mapper(dummySteps));
    if (encoded) { picked = c; break; }
  }

  if (!picked) {
    throw new Error("ArbiSearcherRouter.exec overload not found. Check the ABI of ArbiSearcherRouter.json");
  }

  // Return a stable encoder closure
  return (tokenOut: string, minOut: bigint, steps: Step[]) => {
    if (picked!.kind === "3arg") {
      // Replace the dummy tokenOut/minOut with the real ones while preserving mapper’s tuple layout
      const args = picked!.mapper(steps).slice(); // shallow copy
      args[0] = tokenOut;
      args[1] = minOut;
      return iface.encodeFunctionData(picked!.sig, args);
    } else {
      // 1-arg exec(steps)
      return iface.encodeFunctionData(picked!.sig, picked!.mapper(steps));
    }
  };
}
