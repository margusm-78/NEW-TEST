import "dotenv/config";
import { ethers } from "ethers";

type Check = { ok: boolean; msg: string };

function env(k: string) {
  const v = (process.env[k] || "").trim();
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}
function addrOf(name: string) {
  const v = env(name);
  if (!ethers.isAddress(v)) throw new Error(`Invalid ${name}: ${v}`);
  return ethers.getAddress(v);
}

// Minimal ERC20 ABI
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

// Coerce any decimals-like value to a number safely
function asNumber(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "string") return Number(x);
  return Number(x as any);
}

async function main() {
  const ARB_RPC_URL = env("ARB_RPC_URL");
  const PRIVATE_KEY = env("PRIVATE_KEY");

  // Prefer explicit Uniswap v3 quoter var; fallback to legacy name if present
  const ROUTER_ADDRESS = addrOf("ROUTER_ADDRESS");
  const QUOTER = (() => {
    const q = (process.env.UNIV3_QUOTER_ARBITRUM || process.env.UNI_QUOTER_V2 || "").trim();
    if (!ethers.isAddress(q)) throw new Error(`Missing/invalid quoter address. Set UNIV3_QUOTER_ARBITRUM in .env`);
    return ethers.getAddress(q);
  })();

  const ARB  = addrOf("ARB");
  const WETH = addrOf("WETH");
  const USDC = addrOf("USDC");

  const provider = new ethers.JsonRpcProvider(ARB_RPC_URL, { name: "arbitrum", chainId: 42161 });
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const me       = await wallet.getAddress();

  const checks: Check[] = [];

  const net = await provider.getNetwork();
  checks.push({ ok: net.chainId === 42161n, msg: `ChainId=${net.chainId} (expect 42161)` });

  const routerCode = await provider.getCode(ROUTER_ADDRESS);
  checks.push({ ok: routerCode !== "0x", msg: `Router code present @ ${ROUTER_ADDRESS}` });

  const quoterCode = await provider.getCode(QUOTER);
  checks.push({ ok: quoterCode !== "0x", msg: `Quoter code present @ ${QUOTER}` });

  const ethBal = await provider.getBalance(me);
  checks.push({ ok: ethBal > 0n, msg: `EOA ${me} ETH balance=${ethers.formatEther(ethBal)}` });

  const erc = (a: string) => new ethers.Contract(a, ERC20_ABI, provider);

  const [arbDecRaw, arbSym]   = await Promise.all([erc(ARB).decimals(),  erc(ARB).symbol()]);
  const [wethDecRaw, wethSym] = await Promise.all([erc(WETH).decimals(), erc(WETH).symbol()]);
  const [usdcDecRaw, usdcSym] = await Promise.all([erc(USDC).decimals(), erc(USDC).symbol()]);

  const arbDec  = asNumber(arbDecRaw);
  const wethDec = asNumber(wethDecRaw);
  const usdcDec = asNumber(usdcDecRaw);

  checks.push({ ok: arbDec  === 18, msg: `ARB   decimals=${arbDec} (expect 18)` });
  checks.push({ ok: wethDec === 18, msg: `WETH  decimals=${wethDec} (expect 18)` });
  checks.push({ ok: usdcDec === 6,  msg: `USDC  decimals=${usdcDec} (expect 6)` });

  const [aARB, aWETH] = await Promise.all([
    erc(ARB).allowance(me, ROUTER_ADDRESS),
    erc(WETH).allowance(me, ROUTER_ADDRESS),
  ]);

  checks.push({ ok: aARB > 0n,  msg: `ARB   allowance -> router: ${aARB.toString()}` });
  checks.push({ ok: aWETH > 0n, msg: `WETH  allowance -> router: ${aWETH.toString()}` });

  const allOk = checks.every(c => c.ok);
  for (const c of checks) console.log(`${c.ok ? "✅" : "❌"} ${c.msg}`);
  if (!allOk) throw new Error("Preflight failed. Fix ❌ items and re-run.");
  console.log("✔️  Preflight PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
