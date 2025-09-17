// scripts/quote-test.ts
import "dotenv/config";
import { ethers } from "ethers";
import { CONFIG } from "../src/searcher/config";
import { makeProvider, TOKENS_LC } from "./utils";

// Correct QuoterV2 ABI (struct order: amountIn before fee)
const QUOTER_V2_ABI = [
  {
    "type": "function",
    "stateMutability": "nonpayable",
    "outputs": [
      { "type": "uint256", "name": "amountOut", "internalType": "uint256" },
      { "type": "uint160", "name": "sqrtPriceX96After", "internalType": "uint160" },
      { "type": "uint32",  "name": "initializedTicksCrossed", "internalType": "uint32" },
      { "type": "uint256", "name": "gasEstimate", "internalType": "uint256" }
    ],
    "name": "quoteExactInputSingle",
    "inputs": [
      {
        "type": "tuple",
        "name": "params",
        "components": [
          { "type": "address", "name": "tokenIn", "internalType": "address" },
          { "type": "address", "name": "tokenOut", "internalType": "address" },
          { "type": "uint256", "name": "amountIn", "internalType": "uint256" },
          { "type": "uint24",  "name": "fee", "internalType": "uint24" },
          { "type": "uint160", "name": "sqrtPriceLimitX96", "internalType": "uint160" }
        ],
        "internalType": "struct IQuoterV2.QuoteExactInputSingleParams"
      }
    ]
  }
] as const;

function parseArgs(argv = process.argv.slice(2)) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const eq = t.indexOf("=");
    if (eq > -1) out[t.slice(2, eq)] = t.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      out[t.slice(2)] = argv[i + 1];
      i++;
    } else out[t.slice(2)] = "true";
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const amountArb = args.amount ?? "0.02"; // default 0.02 ARB
  const fee = Number(args.fee ?? CONFIG.uni.priceFee ?? 3000);

  const provider = makeProvider();

  const ARB = TOKENS_LC["arb"];
  const WETH = TOKENS_LC["weth"];
  if (!ARB || !WETH) throw new Error("Missing ARB/WETH in TOKENS_LC");

  const quoter = new ethers.Contract(CONFIG.uni.quoter, QUOTER_V2_ABI, provider);
  const amountIn = ethers.parseUnits(amountArb, 18);

  const res = await quoter.quoteExactInputSingle.staticCall({
    tokenIn: ARB,
    tokenOut: WETH,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0n,
  });

  const out = (res as any)?.amountOut ?? (res as bigint);
  console.log(`Quote ARB->WETH: amountIn=${amountArb} ARB via fee=${fee}`);
  console.log(`amountOut (wei) = ${out.toString()}`);
  console.log(`amountOut (WETH)= ${ethers.formatUnits(out, 18)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
