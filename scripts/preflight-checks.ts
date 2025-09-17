// src/searcher/preflight-checks.ts
import "dotenv/config";
import { ethers } from "ethers";
import {
  makeProvider,
  makeWallet,
  TOKENS_LC,
  toAddress,
  formatUnitsSafe,
  asTrimmedString,
  isHex40,
  ERC20_ABI,
} from "./utils";

async function main() {
  const provider = makeProvider();
  const wallet = makeWallet(provider);
  const me = await wallet.getAddress();

  const spenderArg = process.env.ROUTER_ADDRESS || "";
  const spender = toAddress(spenderArg);

  // Use ARB_REF_TOKENS or default to ARB,WETH (USDC removed)
  const list = (process.env.ARB_REF_TOKENS || "ARB,WETH")
    .split(",")
    .map(asTrimmedString)
    .filter(Boolean);

  console.log("EOA:", me);
  console.log("Spender (router):", spender);
  console.log("Tokens:", list.join(", "));

  // Native ETH balance (on Arbitrum)
  const eth = await provider.getBalance(me);
  console.log(`ETH: ${ethers.formatEther(eth)} ETH`);

  for (const it of list) {
    let tokenAddr: string;
    if (isHex40(it)) tokenAddr = ethers.getAddress(it);
    else {
      tokenAddr = TOKENS_LC[it.toLowerCase()];
      if (!tokenAddr) {
        console.log(`- ${it}: unknown symbol (set in .env or TOKENS map)`);
        continue;
      }
    }

    const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const [sym, dec, bal, allowance] = await Promise.all([
      erc20.symbol().catch(() => "ERC20"),
      erc20.decimals().catch(() => 18),
      erc20.balanceOf(me),
      erc20.allowance(me, spender),
    ]);
    const dp = Number(dec);

    console.log(`- ${it} -> ${tokenAddr} (${sym}, ${dp} dp)`);
    console.log(`  balance   : ${bal} (${formatUnitsSafe(bal, dp)})`);
    console.log(`  allowance : ${allowance} (${formatUnitsSafe(allowance, dp)})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
