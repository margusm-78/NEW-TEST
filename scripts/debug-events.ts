// scripts/debug-events.ts
import "dotenv/config";
import { ethers } from "ethers";

const POOL_05 = "0xC6F780497A95e246EB9449f5e4770916DCd6396A"; // 0.05% ARB/WETH
const POOL_03 = "0x92c63d0e701CAAe670C9415d91C474F686298f00"; // 0.3%  ARB/WETH

const MIN_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
] as const;

function getProvider(): ethers.Provider {
  const url = (process.env.ARB_RPC_URL || "").trim();
  if (!url) throw new Error("Set ARB_RPC_URL in .env");
  return new ethers.JsonRpcProvider(url, { name: "arbitrum", chainId: 42161 });
}

async function main() {
  const provider = getProvider();

  const poolAddr = (process.argv[2]?.toLowerCase() === "0.3" ? POOL_03 : POOL_05);
  console.log("=== DEBUGGING EVENT SUBS ===");
  console.log("Pool:", poolAddr);

  const pool = new ethers.Contract(poolAddr, MIN_ABI, provider);

  // basic read to confirm ABI is sane
  try {
    const [f, t0, t1] = await Promise.all([
      pool.fee(),
      pool.token0(),
      pool.token1(),
    ]);
    console.log(`OK: fee=${f} token0=${t0} token1=${t1}`);
  } catch (e:any) {
    console.log("❌ pool view failed:", e?.message || e);
  }

  // Method A: pool.on("Swap", ...)
  const safeListener = (...args: any[]) => {
    console.log(`[pool.on] Swap(args=${args.length})`);
    try {
      if (args.length < 7) { console.log("  ! not enough args"); return; }
      const [sender, recipient, amount0, amount1] = args;
      console.log(`  sender=${sender} recipient=${recipient} a0=${amount0?.toString?.()} a1=${amount1?.toString?.()}`);
    } catch (e:any) { console.log("  parse err:", e?.message || e); }
  };
  pool.on("Swap", safeListener);
  console.log("Attached pool.on Swap listener (5s)");

  // Method B: provider.on(raw filter)
  const swapTopic = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
  const filter = { address: poolAddr, topics: [swapTopic] };
  const rawListener = (log: any) => {
    console.log(`[provider.on] raw log: topics=${log.topics?.length ?? 0} data.len=${String(log.data ?? "").length}`);
  };
  provider.on(filter, rawListener);
  console.log("Attached provider.on raw listener (5s)");

  await new Promise(res => setTimeout(res, 5000));

  pool.off("Swap", safeListener);
  provider.off(filter, rawListener);
  console.log("Detached listeners; done.");
}

main().catch(e => { console.error(e); process.exit(1); });
