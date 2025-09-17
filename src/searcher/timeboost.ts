// src/searcher/timeboost.ts
import { ethers } from "ethers";
import { RP } from "./resilientProvider";

/**
 * Minimal stub that just sends the signed raw tx via the rotating HTTP provider.
 * Keeps the signature used elsewhere: (provider, signedTx, bidWei) -> txHash
 */
export async function sendWithTimeboostStub(
  _provider: ethers.JsonRpcProvider,
  signedTx: string,
  _bidWei: bigint
): Promise<string> {
  const hash = await RP.withProvider(async (p) => {
    const h = (await p.send("eth_sendRawTransaction", [signedTx])) as string;
    return h;
  });
  return String(hash);
}
