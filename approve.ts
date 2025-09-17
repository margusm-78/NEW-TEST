import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
// Import the JSON artifact (object with { abi, bytecode, ... })
import RouterArtifact from "./src/searcher/abi/ArbiSearcherRouter.json";

// Use ONLY the ABI array
const RouterABI = (RouterArtifact as any).abi;

async function main() {
  // Provider
  const rpc = process.env.ARB_RPC_URL!;
  if (!rpc) throw new Error("Missing ARB_RPC_URL");
  const provider = new ethers.JsonRpcProvider(rpc);

  // Wallet
  const rawPk = (process.env.PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || "").trim();
  if (!rawPk) throw new Error("Missing PRIVATE_KEY (or WALLET_PRIVATE_KEY)");
  const pk = rawPk.startsWith("0x") ? rawPk : `0x${rawPk}`;
  const wallet = new ethers.Wallet(pk, provider);

  // Addresses
  const routerAddr = process.env.ROUTER_ADDRESS!;
  const profitToken = process.env.PROFIT_TOKEN!;
  const swapRouter02 = process.env.SWAP_ROUTER02!;
  if (!routerAddr || !profitToken || !swapRouter02) {
    throw new Error("Missing ROUTER_ADDRESS / PROFIT_TOKEN / SWAP_ROUTER02");
  }

  // Contract using the ABI array
  const router = new ethers.Contract(routerAddr, RouterABI, wallet);
  const MAX = ethers.MaxUint256;

  console.log("Using wallet:", await wallet.getAddress());
  console.log("Approving token:", profitToken, "spender:", swapRouter02);

  const tx = await router.approveToken(profitToken, swapRouter02, MAX);
  console.log("tx hash:", tx.hash);
  await tx.wait();
  console.log("✔ Approval confirmed");
}

main().catch((e) => { console.error(e); process.exit(1); });

