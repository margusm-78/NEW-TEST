// scripts/print-config.ts
import "dotenv/config";
import { ethers } from "ethers";
import { CONFIG, ROUTERS } from "../src/searcher/config";

function fmtWei(bi?: bigint) {
  if (typeof bi !== "bigint") return "(unset)";
  return `${bi.toString()} wei (${ethers.formatEther(bi)} ETH)`;
}

console.log("=== CONFIG.uni ===");
console.log("factory           =", CONFIG.uni.factory);
console.log("quoter            =", CONFIG.uni.quoter);
console.log("priceFee          =", CONFIG.uni.priceFee);
console.log("minProfitARBWei   =", fmtWei(CONFIG.uni.minProfitARBWei));
console.log("minProfitWETHWei  =", fmtWei(CONFIG.uni.minProfitWETHWei));
console.log("pools (n)         =", CONFIG.uni.pools?.length ?? 0);
CONFIG.uni.pools?.forEach((p, i) => {
  console.log(
    `  [${i}] ${p.name} fee=${p.fee} pool=${p.address} token0=${p.token0} token1=${p.token1}`
  );
});

console.log("\n=== ROUTERS ===");
console.log("swapRouter02      =", ROUTERS.swapRouter02);
// If your config ever adds a Universal Router, log it too:
console.log("universalRouter   =", (ROUTERS as any).universalRouter ?? "(not set)");

console.log("\n=== ENV (key items) ===");
console.log("ARB_RPC_URL set   =", !!process.env.ARB_RPC_URL);
console.log("ARB_WS_URL_PRIMARY=", process.env.ARB_WS_URL_PRIMARY ?? "(unset)");
console.log("ROUTER_ADDRESS    =", process.env.ROUTER_ADDRESS ?? "(unset)");
console.log("PRIVATE_KEY set   =", !!process.env.PRIVATE_KEY);
