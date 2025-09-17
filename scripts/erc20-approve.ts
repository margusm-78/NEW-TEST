// scripts/erc20-approve.ts
import "dotenv/config";
import { ethers } from "ethers";
import {
  makeProvider,
  makeWallet,
  TOKENS_LC,
  toAddress,
  asTrimmedString,
  isHex40,
  ERC20_ABI,
  formatUnitsSafe,
} from "./utils";

/**
 * Simple argv parser:
 *  - Supports:  --key=value   and   --key value
 *  - Bare flags become boolean true (e.g., --dry)
 *  - We NEVER treat bare flags as values for required options
 */
function parseArgs(argv = process.argv.slice(2)) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;

    const eq = tok.indexOf("=");
    if (eq > -1) {
      const key = tok.slice(2, eq);
      const val = tok.slice(eq + 1);
      out[key] = val;
      continue;
    }

    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++; // consume value
    } else {
      out[key] = true; // bare flag
    }
  }
  return out;
}

function getOptString(args: Record<string, string | boolean>, key: string): string | undefined {
  const v = args[key];
  if (typeof v === "string") {
    const trimmed = v.trim();
    // Treat empty string or "true" (bare flag) as undefined (missing value)
    if (!trimmed || trimmed.toLowerCase() === "true") return undefined;
    // Strip surrounding quotes if someone passed quoted value
    return trimmed.replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

function hasFlag(args: Record<string, string | boolean>, key: string): boolean {
  return args[key] === true;
}

async function main() {
  const args = parseArgs();

  const provider = makeProvider();
  const wallet = makeWallet(provider);
  const me = await wallet.getAddress();

  // tokens list (default ARB,WETH)
  const tokensArg =
    getOptString(args, "tokens") ?? process.env.ARB_REF_TOKENS ?? "ARB,WETH";
  const tokenKeys = tokensArg
    .split(",")
    .map(asTrimmedString)
    .filter(Boolean);

  // spender (router): prefer CLI, then ENV
  const spenderRaw =
    getOptString(args, "spender") ??
    (process.env.ROUTER_ADDRESS ? process.env.ROUTER_ADDRESS.trim() : "");
  if (!spenderRaw) {
    throw new Error(
      "Missing --spender and ROUTER_ADDRESS. Pass --spender 0x... or set ROUTER_ADDRESS in .env"
    );
  }
  const spender = toAddress(spenderRaw);

  // amount: default MAX (approve unlimited). Use 0 to revoke.
  const amountArg = (getOptString(args, "amount") ?? "MAX").trim().toLowerCase();
  const force = hasFlag(args, "force");
  const dry = hasFlag(args, "dry");

  console.log("EOA:", me);
  console.log("Spender (router):", spender);
  console.log("Tokens:", tokenKeys.join(", "));
  console.log("Amount:", amountArg === "max" ? "MAX_UINT256" : amountArg);
  console.log("Force:", force ? "yes" : "no", "| Dry-run:", dry ? "yes" : "no");

  // Native ETH balance (for gas)
  const eth = await provider.getBalance(me);
  console.log(`ETH: ${ethers.formatEther(eth)} ETH`);

  for (const key of tokenKeys) {
    let tokenAddr: string | undefined;
    if (isHex40(key)) tokenAddr = ethers.getAddress(key);
    else tokenAddr = TOKENS_LC[key.toLowerCase()];

    if (!tokenAddr) {
      console.log(`- ${key}: unknown symbol (add to TOKENS_LC or use 0x address)`);
      continue;
    }

    const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
    // Read metadata with fallbacks
    const [sym, decimals, balance, currentAllowance] = await Promise.all([
      erc20.symbol().catch(() => "ERC20"),
      erc20.decimals().catch(() => 18),
      erc20.balanceOf(me).catch(() => 0n),
      erc20.allowance(me, spender).catch(() => 0n),
    ]);
    const dp = Number(decimals);
    let targetAllowance: bigint;

    if (amountArg === "max") {
      targetAllowance = ethers.MaxUint256;
    } else {
      // allow 0 (revoke) or decimal strings in token units
      try {
        targetAllowance = ethers.parseUnits(amountArg, dp);
      } catch {
        console.log(`- ${sym}: invalid --amount "${amountArg}" for ${dp} decimals; skipping`);
        continue;
      }
    }

    console.log(
      `- ${key} -> ${tokenAddr} (${sym}, ${dp} dp)\n` +
        `  balance   : ${balance} (${formatUnitsSafe(balance, dp)})\n` +
        `  allowance : ${currentAllowance} (${formatUnitsSafe(currentAllowance, dp)})\n` +
        `  target    : ${
          targetAllowance === ethers.MaxUint256
            ? "MAX_UINT256"
            : `${targetAllowance} (${formatUnitsSafe(targetAllowance, dp)})`
        }`
    );

    if (!force && currentAllowance >= targetAllowance) {
      console.log(`  ✔ already >= target; skipping (use --force to re-approve)`);
      continue;
    }

    if (dry) {
      console.log(
        `  [DRY] would call approve(${spender}, ${
          targetAllowance === ethers.MaxUint256 ? "MAX_UINT256" : targetAllowance
        })`
      );
      continue;
    }

    // Send approve
    const tx = await erc20.approve(spender, targetAllowance);
    console.log(`  → sent ${tx.hash}`);
    const rc = await tx.wait();
    console.log(`  ✓ confirmed in block ${rc?.blockNumber}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
