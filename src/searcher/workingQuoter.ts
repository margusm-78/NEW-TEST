// src/searcher/workingQuoter.ts
import { ethers } from "ethers";
import type { LogDescription, InterfaceAbi } from "ethers";
import { CONFIG, ROUTERS } from "./config";
import { makeExecEncoder, type Step } from "./execEncoder";

/**
 * Runtime config (overridable via .env)
 */
export const WORKING_CONFIG = {
  // Pools & tokens
  POOL_ADDRESS_03: (process.env.ARB_WETH_POOL_03 ??
    "0x92c63d0e701CAAe670C9415d91C474F686298f00").trim(), // 0.3%
  POOL_ADDRESS_005: (process.env.ARB_WETH_POOL_005 ??
    "0xC6F780497A95e246EB9449f5e4770916DCd6396A").trim(), // 0.05% (optional)
  ARB: (process.env.TOKEN_ARB ??
    "0x912CE59144191C1204E64559FE8253a0e49E6548").trim(),
  WETH: (process.env.TOKEN_WETH ??
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1").trim(),
  QUOTER: (process.env.UNI_QUOTER ??
    "0x61fFE014bA17989E743c5F6cB21bF9697530B21e").trim(),

  // Routes to test (left = ARB->WETH fee, right = WETH->ARB fee)
  ROUTE_FEES: (process.env.ROUTE_FEES ??
    "3000>3000,500>3000,3000>500").trim(),

  // Trade sizing
  TRADE_SIZE: (process.env.PROBE_NOTIONAL_A || "").trim() || "0.001",
  MAX_BPS_OF_LIQ: Math.max(0, Number(process.env.MAX_BPS_OF_LIQ ?? "3")), // cap <= 0.03% of pseudo-liquidity
  BASE_TRADE_ARB: (process.env.BASE_TRADE_ARB || "").trim() || "0.001",

  // Gates
  MIN_EDGE_BPS: Number(process.env.MIN_EDGE_BPS ?? "70"), // require edge ≥ 0.70% before gas
  SLIPPAGE_BPS: Number(process.env.SLIPPAGE_BPS ?? "30"), // default 0.30%
  MIN_TICK_MOVE: Math.max(0, Number(process.env.MIN_TICK_MOVE ?? "4")), // ignore tiny swaps

  // Poller (getLogs, chunk-splitting)
  POLL_MS: Math.max(500, Number(process.env.WORKING_POOL_POLL_MS ?? "1500")),
  FROMBLOCK_LAG: Math.max(0, Number(process.env.WORKING_POOL_FROMBLOCK_LAG ?? "1")),
  CONFIRMATIONS: Math.max(0, Number(process.env.WORKING_POOL_CONFIRMATIONS ?? "0")),
  MAX_SPAN: Math.max(1, Number(process.env.WORKING_POOL_MAX_SPAN ?? "200")),

  // Execution (optional)
  EXECUTE: ((process.env.WORKING_EXECUTE ?? "false").toLowerCase() === "true"),
  MIN_PROFIT_ARB: (process.env.MIN_PROFIT_ARB || "").trim() || "0",
};

const QUOTER_V2_ABI = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "quoteExactInputSingle",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** Minimal interface to parse Swap logs (no filter IDs). */
const POOL_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

const SWAP_TOPIC = ethers.id(
  "Swap(address,address,int256,int256,uint160,uint128,int24)"
);

const { abi: ArbiRouterAbi }   = require("./abi/ArbiSearcherRouter.json") as { abi: InterfaceAbi };
const { abi: SwapRouter02Abi } = require("./abi/SwapRouter02.json")        as { abi: InterfaceAbi };

function errMsg(e: any): string {
  return e?.shortMessage || e?.message || e?.info?.error?.message || String(e);
}
function applySlippageBps(amount: bigint, bps: number): bigint {
  const BPS = 10_000n;
  const clamp = Math.max(0, Math.min(10_000, Number.isFinite(bps) ? bps : 0));
  const keep = BigInt(10_000 - clamp);
  return (amount * keep) / BPS;
}

/** Normalize/validate hex address; auto-add 0x if 40-hex chars were provided. */
function normAddr(label: string, v: string): string {
  const s = (v ?? "").trim();
  if (ethers.isAddress(s)) return ethers.getAddress(s);
  if (/^[0-9a-fA-F]{40}$/.test(s)) return ethers.getAddress("0x" + s);
  throw new Error(`${label} must be a hex address (got: "${s}")`);
}
function resolvedAddrs() {
  return {
    ARB: normAddr("TOKEN_ARB", WORKING_CONFIG.ARB),
    WETH: normAddr("TOKEN_WETH", WORKING_CONFIG.WETH),
    QUOTER: normAddr("UNI_QUOTER", WORKING_CONFIG.QUOTER),
    POOL03: normAddr("ARB_WETH_POOL_03", WORKING_CONFIG.POOL_ADDRESS_03),
    POOL005: ethers.isAddress(WORKING_CONFIG.POOL_ADDRESS_005)
      ? ethers.getAddress(WORKING_CONFIG.POOL_ADDRESS_005)
      : (undefined as unknown as string),
    ROUTER: normAddr("CONFIG.router", CONFIG.router),
    SWAP02: normAddr("ROUTERS.swapRouter02", ROUTERS.swapRouter02),
  };
}

type FeeRoute = { hopA: number; hopB: number; label: string };
function parseRouteFees(env = WORKING_CONFIG.ROUTE_FEES): FeeRoute[] {
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const [a, b] = p.split(">").map((x) => Number(x.trim()));
      if (![500, 3000, 10000].includes(a) || ![500, 3000, 10000].includes(b)) {
        throw new Error(`Bad ROUTE_FEES entry: ${p}`);
      }
      return { hopA: a, hopB: b, label: `${a / 10000}%→${b / 10000}%` };
    });
}

/** QuoterV2 (full struct result: amountOut + gasEstimate) */
async function quoteV2Full(
  provider: ethers.Provider,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint
): Promise<{ amountOut: bigint; gasEstimate: bigint }> {
  const { QUOTER } = resolvedAddrs();
  const q = new ethers.Contract(QUOTER, QUOTER_V2_ABI, provider);
  const res = await q.quoteExactInputSingle.staticCall({
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0n,
  });
  const r = res as any;
  return {
    amountOut: r?.amountOut ?? 0n,
    gasEstimate: r?.gasEstimate ?? 0n,
  };
}

/** Convenience: amount-only wrapper. */
async function quoteV2(
  provider: ethers.Provider,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint
): Promise<bigint> {
  const q = await quoteV2Full(provider, tokenIn, tokenOut, fee, amountIn);
  return q.amountOut;
}

/** Heuristic sizer to avoid reverts / big impact on 0.05% pool. */
const POOL_ABI = ["function liquidity() view returns (uint128)"];
async function sizeForLiquidity(
  provider: ethers.Provider,
  poolAddr: string,
  base: bigint,
  maxBpsOfLiq = WORKING_CONFIG.MAX_BPS_OF_LIQ
): Promise<bigint> {
  try {
    const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const L: bigint = await (pool.liquidity() as Promise<bigint>);
    // Very rough heuristic: pseudo "WETH capacity" ≈ L / 1e12
    const pseudoWeth = L / 1_000_000_000_000n;
    const capByBps = (pseudoWeth * BigInt(maxBpsOfLiq)) / 10_000n;
    const chosen = base <= capByBps ? base : (capByBps > 0n ? capByBps : base / 10n);
    return chosen > 0n ? chosen : base;
  } catch {
    return base;
  }
}

async function quoteRoundTripARB(
  provider: ethers.Provider,
  inARB: bigint,
  hopA: number, // ARB->WETH fee
  hopB: number  // WETH->ARB fee
) {
  const { ARB, WETH } = resolvedAddrs();
  const outWETH = await quoteV2(provider, ARB, WETH, hopA, inARB);
  if (outWETH === 0n) return { ok: false, outARB: 0n };
  const outARB = await quoteV2(provider, WETH, ARB, hopB, outWETH);
  return { ok: outARB > 0n, outARB };
}

function routeHas500(r: FeeRoute) {
  return r.hopA === 500 || r.hopB === 500;
}

/** Try each route; for 500 routes, downsize using POOL005 liquidity. Rank by (outARB - inARB). */
async function bestRouteByEdge(
  provider: ethers.Provider,
  baseInARB: bigint
): Promise<{ route: FeeRoute; inARB: bigint; outARB: bigint } | null> {
  const routes = parseRouteFees();
  const { POOL005 } = resolvedAddrs();

  let best: { route: FeeRoute; inARB: bigint; outARB: bigint } | null = null;

  for (const r of routes) {
    let inARB = baseInARB;

    if (routeHas500(r) && POOL005) {
      inARB = await sizeForLiquidity(provider, POOL005, baseInARB);
    }

    try {
      const rt = await quoteRoundTripARB(provider, inARB, r.hopA, r.hopB);
      if (!rt.ok) continue;
      if (!best || rt.outARB - inARB > best.outARB - best.inARB) {
        best = { route: r, inARB, outARB: rt.outARB };
      }
    } catch {
      // ignore failing route
    }
  }
  return best;
}

function bpsDelta(out: bigint, inp: bigint): number {
  if (inp === 0n) return -Infinity;
  const num = Number(out - inp) / Number(inp);
  return Math.round(num * 10_000 * 100) / 100; // 2 decimals (bps)
}

/** Gas price helper (Arbitrum-safe) */
async function getGasPriceWei(provider: ethers.Provider): Promise<bigint> {
  const fd = await provider.getFeeData();
  let gp: bigint | null = (fd.maxFeePerGas as bigint | null) ?? (fd.gasPrice as bigint | null) ?? null;
  if (gp == null) {
    try {
      const raw = await (provider as any).send?.("eth_gasPrice", []);
      if (raw) gp = BigInt(raw);
    } catch {}
  }
  if (gp == null) throw new Error("gasPrice unavailable");
  return gp;
}

/** Gas estimate → ARB using WETH→ARB quote. With fallback to QuoterV2 gasEstimate. */
async function estimateGasArbPreview(
  provider: ethers.Provider,
  tx: ethers.TransactionRequest,
  route: FeeRoute,
  inARB: bigint,
  hop1OutWETH: bigint
): Promise<{ gasUnits: bigint; gasPriceWei: bigint; gasAsArb: bigint; approx: boolean }> {
  const gp = await getGasPriceWei(provider);

  // 1) Primary: real estimate of the composed router call
  try {
    const gasUnits = await provider.estimateGas(tx);
    const gasCostWei = gasUnits * gp;
    const { ARB, WETH } = resolvedAddrs();
    const gasAsArb = await quoteV2(provider, WETH, ARB, route.hopB, gasCostWei);
    return { gasUnits, gasPriceWei: gp, gasAsArb, approx: false };
  } catch {
    // 2) Fallback: sum QuoterV2 gasEstimate for both hops + small overhead
    const { ARB, WETH } = resolvedAddrs();
    const q1 = await quoteV2Full(provider, ARB, WETH, route.hopA, inARB);
    const q2 = await quoteV2Full(provider, WETH, ARB, route.hopB, hop1OutWETH);

    // Overhead for exec wrapper + calldata (conservative buffer)
    const OVERHEAD = 80_000n;
    const gasUnits = (q1.gasEstimate ?? 0n) + (q2.gasEstimate ?? 0n) + OVERHEAD;

    const gasCostWei = gasUnits * gp;
    const gasAsArb = await quoteV2(provider, WETH, ARB, route.hopB, gasCostWei);
    return { gasUnits, gasPriceWei: gp, gasAsArb, approx: true };
  }
}

export async function getWorkingQuote(provider: ethers.Provider) {
  const inARB = ethers.parseUnits(WORKING_CONFIG.TRADE_SIZE, 18);
  console.log(
    `Getting best-route quote for ${WORKING_CONFIG.TRADE_SIZE} ARB across routes: ${WORKING_CONFIG.ROUTE_FEES}`
  );
  const best = await bestRouteByEdge(provider, inARB);
  if (!best) {
    console.log("❌ Quote: no viable route (all failed)");
    return { amountIn: inARB, amountOut: 0n, fee: 0, success: false };
  }
  console.log(
    `✅ Best route ${best.route.label} → outARB=${ethers.formatUnits(best.outARB, 18)}`
  );
  return {
    amountIn: best.inARB,
    amountOut: best.outARB,
    fee: best.route.hopA, // informational
    success: true,
  };
}

/** Build the two-hop exec call for the selected route & sizes. */
function buildTwoHopSteps(
  swap: ethers.Contract,
  route: FeeRoute,
  inARB: bigint,
  hop1OutWETH: bigint,
  minOutARB: bigint,
  recipient: string
): Step[] {
  const { ARB, WETH } = resolvedAddrs();
  const deadline = Math.floor(Date.now() / 1000) + 30;

  const step1 = swap.interface.encodeFunctionData("exactInputSingle", [
    {
      tokenIn: ARB,
      tokenOut: WETH,
      fee: route.hopA,
      recipient,
      deadline,
      amountIn: inARB,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    },
  ]);

  const step2 = swap.interface.encodeFunctionData("exactInputSingle", [
    {
      tokenIn: WETH,
      tokenOut: ARB,
      fee: route.hopB,
      recipient,
      deadline,
      amountIn: hop1OutWETH,
      amountOutMinimum: minOutARB,
      sqrtPriceLimitX96: 0,
    },
  ]);

  return [
    { target: swap.target as string, data: step1, value: 0n },
    { target: swap.target as string, data: step2, value: 0n },
  ];
}

/**
 * OPTION B: Log would-be trade (no tx).
 * Also supports optional execution if WORKING_EXECUTE=true and gates pass.
 */
async function previewAndMaybeExecute(provider: ethers.Provider) {
  try {
    const baseInARB =
      ethers.parseUnits(WORKING_CONFIG.TRADE_SIZE, 18) ||
      ethers.parseUnits(WORKING_CONFIG.BASE_TRADE_ARB, 18);

    const best = await bestRouteByEdge(provider, baseInARB);
    if (!best) {
      console.log("— WOULD-BE TRADE — | no viable route (quotes failed)");
      return;
    }

    const { route, inARB } = best;
    const { ARB, WETH, ROUTER, SWAP02 } = resolvedAddrs();

    // Predict hop outputs (also needed for fallback gas)
    const hop1 = await quoteV2Full(provider, ARB, WETH, route.hopA, inARB);
    const hop1OutWETH = hop1.amountOut;
    const hop2 = await quoteV2Full(provider, WETH, ARB, route.hopB, hop1OutWETH);
    const hop2OutARB  = hop2.amountOut;

    // Edges
    const edgeBps = bpsDelta(hop2OutARB, inARB); // gross edge
    const minOutARB = applySlippageBps(hop2OutARB, WORKING_CONFIG.SLIPPAGE_BPS);

    // Build tx (for primary gas estimation)
    const router = new ethers.Contract(ROUTER, ArbiRouterAbi, provider);
    const swap   = new ethers.Contract(SWAP02,   SwapRouter02Abi, provider);
    const encodeExec = makeExecEncoder(router);
    const steps = buildTwoHopSteps(swap, route, inARB, hop1OutWETH, minOutARB, ROUTER);
    const txData = encodeExec(ARB, minOutARB, steps);

    // Use wallet address as "from" for estimation (helps RPCs)
    let fromAddr = "";
    try {
      const pkRaw = (process.env.PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || "").trim();
      if (pkRaw) {
        const pk = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`;
        fromAddr = new ethers.Wallet(pk).address;
      }
    } catch {}

    // Gas
    let gasAsArb: bigint | null = null;
    let gasArbStr = "unknown";
    try {
      const txReq: ethers.TransactionRequest = {
        to: ROUTER, data: txData, value: 0n,
        ...(fromAddr ? { from: fromAddr } : {})
      };
      const gas = await estimateGasArbPreview(provider, txReq, route, inARB, hop1OutWETH);
      gasAsArb = gas.gasAsArb;
      gasArbStr = (gas.approx ? "~" : "") + ethers.formatUnits(gasAsArb, 18);
    } catch (ge: any) {
      console.log("⚠️  Gas estimate failed completely:", errMsg(ge));
    }

    // Net edge & EV (only if gas known)
    let netEdgeBpsStr = "n/a";
    let evStr = "n/a";
    if (gasAsArb != null) {
      const netOut = hop2OutARB - gasAsArb;
      const netEdgeBps = bpsDelta(netOut, inARB);
      const ev = netOut - inARB;
      netEdgeBpsStr = `${netEdgeBps}`;
      evStr = ethers.formatUnits(ev, 18);
    }

    console.log(
      [
        "— WOULD-BE TRADE —",
        `fees: ${route.hopA / 10000}% -> ${route.hopB / 10000}%`,
        `inARB: ${ethers.formatUnits(inARB, 18)}`,
        `outARB(pred): ${ethers.formatUnits(hop2OutARB, 18)}`,
        `edgeGross(bps): ${edgeBps}`,
        `minOutARB(@slip ${WORKING_CONFIG.SLIPPAGE_BPS} bps): ${ethers.formatUnits(minOutARB, 18)}`,
        `estGas(ARB): ${gasArbStr}`,
        `edgeNetAfterGas(bps): ${netEdgeBpsStr}`,
        `EV(ARB): ${evStr}`,
      ].join(" | ")
    );

    // Execution gate (optional)
    if (!WORKING_CONFIG.EXECUTE) return;

    // Require edge above threshold
    if (edgeBps < WORKING_CONFIG.MIN_EDGE_BPS) {
      console.log(`edge < MIN_EDGE_BPS (${edgeBps} < ${WORKING_CONFIG.MIN_EDGE_BPS}) — not sending`);
      return;
    }
    // Require gas visibility
    if (gasAsArb == null) {
      console.log("No gas estimate — not sending");
      return;
    }

    // Profit gate
    const minProfitARBWei = ethers.parseUnits(WORKING_CONFIG.MIN_PROFIT_ARB, 18);
    const ev = hop2OutARB - inARB - gasAsArb;
    console.log(`EV(pred) ARB = ${ethers.formatUnits(ev, 18)} (min ${ethers.formatUnits(minProfitARBWei, 18)})`);
    if (ev <= minProfitARBWei) {
      console.log("EV below threshold — not sending");
      return;
    }

    // Send tx
    try {
      const pkRaw = (process.env.PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || "").trim();
      const pk = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`;
      const wallet = new ethers.Wallet(pk, provider);
      const routerW = new ethers.Contract(ROUTER, ArbiRouterAbi, wallet);
      const swapW   = new ethers.Contract(SWAP02,   SwapRouter02Abi, wallet);
      const encodeExecW = makeExecEncoder(routerW);

      const stepsW = buildTwoHopSteps(swapW, route, inARB, hop1OutWETH, minOutARB, ROUTER);
      const txDataW = encodeExecW(ARB, minOutARB, stepsW);

      const resp = await wallet.sendTransaction({ to: ROUTER, data: txDataW, value: 0n });
      console.log(`→ sending tx ${resp.hash}`);
      const rc = await resp.wait();
      console.log(`✓ confirmed ${resp.hash} in block ${rc?.blockNumber}`);
    } catch (se: any) {
      console.log("Send path failed:", errMsg(se));
    }
  } catch (e: any) {
    console.log("Would-be trade log error:", errMsg(e));
  }
}

/**
 * Safely fetch logs by recursively bisecting [from, to] on error until it succeeds,
 * or isolates bad blocks (which are skipped).
 */
async function getLogsSafeChunked(
  provider: ethers.Provider,
  address: string,
  topic0: string,
  fromBlock: number,
  toBlock: number
): Promise<ethers.Log[]> {
  try {
    if (toBlock < fromBlock) return [];
    return await provider.getLogs({
      address,
      topics: [topic0],
      fromBlock,
      toBlock,
    });
  } catch (e) {
    if (fromBlock === toBlock) {
      console.log(`⚠️  Skipping problematic block ${fromBlock}: ${errMsg(e)}`);
      return [];
    }
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left = await getLogsSafeChunked(provider, address, topic0, fromBlock, mid);
    const right = await getLogsSafeChunked(provider, address, topic0, mid + 1, toBlock);
    return left.concat(right);
  }
}

/**
 * Resilient pool "monitor" using polling + getLogs (no eth_newFilter).
 * - Uses MIN_TICK_MOVE gate to avoid noise.
 * - On each eligible batch, gets best route, previews trade, (optionally) executes.
 */
export function setupWorkingPoolMonitor(provider: ethers.Provider) {
  console.log(
    "Setting up pool monitor (polling getLogs; chunk-splitting) with dynamic routes..."
  );

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastTick: number | null = null;

  const run = async () => {
    try {
      const latestNow = await provider.getBlockNumber();
      let fromBlock = Math.max(0, latestNow - WORKING_CONFIG.FROMBLOCK_LAG);
      const span = WORKING_CONFIG.MAX_SPAN;
      const { POOL03 } = resolvedAddrs();

      const loop = async () => {
        if (stopped) return;

        try {
          const latest = await provider.getBlockNumber();
          const safeLatest = Math.max(0, latest - WORKING_CONFIG.CONFIRMATIONS);

          if (fromBlock > safeLatest) {
            fromBlock = Math.max(0, safeLatest - WORKING_CONFIG.FROMBLOCK_LAG);
          }

          if (safeLatest >= fromBlock) {
            let cursor = fromBlock;
            while (!stopped && cursor <= safeLatest) {
              const end = Math.min(cursor + span, safeLatest);

              const logs = await getLogsSafeChunked(
                provider,
                POOL03,
                SWAP_TOPIC,
                cursor,
                end
              );

              if (logs.length > 0) {
                for (const log of logs) {
                  try {
                    let parsed: LogDescription | null = null;
                    try {
                      parsed = POOL_IFACE.parseLog(log as any) as LogDescription;
                    } catch {
                      parsed = null;
                    }
                    if (!parsed) continue;

                    const args = parsed.args as readonly unknown[];
                    const sender = args[0] as string;
                    const amount0 = args[2] as bigint;
                    const amount1 = args[3] as bigint;
                    const tick = Number(args[6]);

                    // Tick-move gate
                    const move = lastTick == null ? null : Math.abs(tick - lastTick);
                    lastTick = tick;

                    console.log(
                      `\n🔄 Swap @ block ${log.blockNumber} (0.3% pool): sender=${sender}`
                    );
                    console.log(
                      `   amount0=${amount0?.toString?.()} amount1=${amount1?.toString?.()} tick=${tick} move=${move ?? "n/a"}`
                    );

                    if (move != null && move < WORKING_CONFIG.MIN_TICK_MOVE) {
                      // Too small, skip quoting
                      continue;
                    }

                    // Best-route preview + optional execution
                    await previewAndMaybeExecute(provider);
                  } catch (e: any) {
                    console.log("Parse/log handler error:", errMsg(e));
                  }
                }
              }

              cursor = end + 1;
            }

            fromBlock = safeLatest + 1;
          }
        } catch (err: any) {
          console.log("Poll loop error:", errMsg(err));
        } finally {
          if (!stopped) {
            timer = setTimeout(loop, WORKING_CONFIG.POLL_MS);
          }
        }
      };

      // Kick off
      timer = setTimeout(loop, WORKING_CONFIG.POLL_MS);
      console.log(
        `✅ Monitoring pool: ${POOL03} (poll ${WORKING_CONFIG.POLL_MS} ms, lag ${WORKING_CONFIG.FROMBLOCK_LAG}, maxSpan ${WORKING_CONFIG.MAX_SPAN})`
      );
    } catch (e: any) {
      console.log("Monitor init error:", errMsg(e));
    }
  };

  run();

  return () => {
    stopped = true;
    if (timer) {
      try {
        clearTimeout(timer);
      } catch {}
    }
  };
}

export function printUpdatedEnvValues() {
  console.log("\n=== RECOMMENDED .ENV OVERRIDES ===");
  console.log("WORKING_MODE=true                 # enable simplified dynamic-route path");
  console.log(`PROBE_NOTIONAL_A=${WORKING_CONFIG.TRADE_SIZE}         # base trade size`);
  console.log("ROUTE_FEES=3000>3000,500>3000,3000>500  # candidate fee routes");
  console.log(`SLIPPAGE_BPS=${WORKING_CONFIG.SLIPPAGE_BPS}                 # slippage for minOut preview`);
  console.log("MIN_TICK_MOVE=4                   # ignore tiny swaps");
  console.log("ARB_WETH_POOL_03=0x92c63d0e701CAAe670C9415d91C474F686298f00");
  console.log("ARB_WETH_POOL_005=0xC6F780497A95e246EB9449f5e4770916DCd6396A");
  console.log("UNI_QUOTER=0x61fFE014bA17989E743c5F6cB21e");
  console.log("MAX_BPS_OF_LIQ=3                  # cap size on 0.05% pool");
  console.log("BASE_TRADE_ARB=0.001              # fallback base size");
  console.log("WORKING_POOL_POLL_MS=1500         # polling interval");
  console.log("WORKING_POOL_FROMBLOCK_LAG=1      # start 1 block behind latest");
  console.log("WORKING_POOL_CONFIRMATIONS=0      # optional confirmations");
  console.log("WORKING_POOL_MAX_SPAN=200         # initial span per chunk");
  console.log("WORKING_EXECUTE=false             # set true to actually send");
  console.log("MIN_PROFIT_ARB=0.000001           # profit threshold if executing");
}

export async function runWorkingBot(provider: ethers.Provider) {
  console.log("=== STARTING WORKING BOT (0.3% only) ===");
  try {
    // 1) Sanity quote
    await getWorkingQuote(provider);

    // 2) Start resilient monitor (polling, not filters)
    const cleanup = setupWorkingPoolMonitor(provider);

    // 3) Show .env suggestions
    printUpdatedEnvValues();

    console.log("\n✅ Bot running with working configuration. Press Ctrl+C to stop.");
    process.on("SIGINT", () => {
      console.log("\n🛑 Shutting down...");
      try {
        cleanup();
      } catch {}
      process.exit(0);
    });
  } catch (e: any) {
    console.log(`❌ Bot startup failed: ${errMsg(e)}`);
    console.log("Hint: ensure addresses in .env have 0x prefix and are valid.");
    console.log("Checked keys: UNI_QUOTER, TOKEN_ARB, TOKEN_WETH, ARB_WETH_POOL_03, ARB_WETH_POOL_005, CONFIG.router, ROUTERS.swapRouter02");
    process.exit(1);
  }
}
