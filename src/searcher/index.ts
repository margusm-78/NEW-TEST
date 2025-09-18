import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import type { InterfaceAbi } from "ethers";

import { CONFIG, ROUTERS } from "./config";
import { RP } from "./resilientProvider";
import { resolveTwoArbWethPools } from "./univ3";
import { evEstimateARB } from "./simulator";
import { estimateGasARB } from "./gas";
import { getQuoteWithFallback } from "./quoteStrategy";
import { getDynamicTradeSize, findArbWethPoolAddressByFee } from "./dynamicSizing";
import { makeExecEncoder, type Step } from "./execEncoder";
import { runWorkingBot } from "./workingQuoter"; // <-- NEW

// ABIs
const { abi: ArbiRouterAbi }    = require("./abi/ArbiSearcherRouter.json") as { abi: InterfaceAbi };
const { abi: SwapRouter02Abi }  = require("./abi/SwapRouter02.json")        as { abi: InterfaceAbi };

function requireAddress(label: string, value?: string) {
  const v = (value || "").trim();
  if (!ethers.isAddress(v)) throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  return ethers.getAddress(v);
}
function toWeiBigint(x: string | number): bigint {
  const n = Number(x);
  return BigInt(Math.round(n * 1e18));
}
function applySlippageBps(amount: bigint, bps: number): bigint {
  const BPS = 10_000n;
  const keep = BigInt(Math.max(0, 10_000 - (isFinite(bps) ? Math.max(0, Math.min(10_000, bps)) : 0)));
  return (amount * keep) / BPS;
}

async function main() {
  await RP.ensureReady();
  const provider = RP.provider;

  // === SIMPLE WORKING MODE (enable via .env WORKING_MODE=true) ===
  if (((process.env.WORKING_MODE || "").trim().toLowerCase()) === "true") {
    await runWorkingBot(provider);
    return; // short-circuit into working mode
  }

  const pkRaw = (process.env.PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || "").trim();
  if (!pkRaw) throw new Error("Set PRIVATE_KEY (or WALLET_PRIVATE_KEY) in .env");
  const pk = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`;
  const wallet = new ethers.Wallet(pk, provider);

  const routerAddr      = requireAddress("CONFIG.router",        CONFIG.router);
  const swapRouter02    = requireAddress("ROUTERS.swapRouter02", ROUTERS.swapRouter02);
  const quoterAddr      = requireAddress("CONFIG.uni.quoter",    CONFIG.uni.quoter);
  const arbAddr         = requireAddress("CONFIG.tokens.ARB",    CONFIG.tokens.ARB);
  const wethAddr        = requireAddress("CONFIG.tokens.WETH",   CONFIG.tokens.WETH);

  const net = await RP.withProvider((p) => p.getNetwork(), { method: "eth_chainId", cacheable: true, ttlSeconds: 300 });
  const code = await RP.withProvider((p) => p.getCode(routerAddr), { method: "eth_getCode" });
  if (code === "0x") throw new Error(`No contract code at ROUTER_ADDRESS: ${routerAddr}`);

  console.log("Searcher wallet:", await wallet.getAddress());
  console.log("Chain:", String(net.chainId));
  console.log("Addresses:", {
    router: routerAddr, swapRouter02, quoter: quoterAddr,
    ARB: arbAddr, WETH: wethAddr
  });

  // Choose two fees to arbitrage (prefer your env order if both live)
  const prefFees = CONFIG.uni.pools.map(p => p.fee).filter(Boolean);
  const { feeA, feeB, poolA, poolB } = await resolveTwoArbWethPools(prefFees);
  console.log(
    `Using ARB/WETH fees: ${feeA} -> ${feeB}` +
    (poolA ? ` | poolA=${poolA}` : "") +
    (poolB ? ` poolB=${poolB}` : "")
  );

  const router = new ethers.Contract(routerAddr, ArbiRouterAbi, wallet);
  const swap   = new ethers.Contract(swapRouter02, SwapRouter02Abi, wallet);

  // Resolve correct exec(...) overload once
  const encodeExec = makeExecEncoder(router);

  // Base trade size in ARB (18d) — trimmed, fallback to 0.02 if unset
  const baseTradeStr = (process.env.PROBE_NOTIONAL_A || "").trim() || "0.02";
  const baseInARB = toWeiBigint(baseTradeStr);

  // Profit gate in ARB
  let minProfitARB: bigint = CONFIG.uni.minProfitARBWei || 0n;
  if (minProfitARB === 0n) {
    try {
      const conv = await getQuoteWithFallback(
        quoterAddr,
        wethAddr,
        arbAddr,
        CONFIG.uni.minProfitWETHWei,
        {
          configs: [
            { fee: feeB,  name: `${feeB/10000}%`, num: 1n, den: 1n },
            { fee: 3000,  name: "0.3%",          num: 1n, den: 1n },
            { fee: 500,   name: "0.05%",         num: 1n, den: 1n },
            { fee: 10000, name: "1.0%",          num: 1n, den: 1n },
          ],
          confirmFullAmount: false,
          log: false,
        }
      );
      minProfitARB = conv.amountOut;
    } catch {
      minProfitARB = 800_000_000_000_000n; // ~0.0008 ARB fallback
    }
  }
  console.log("Min profit gate (ARB, approx):", Number(minProfitARB) / 1e18);

  const slippageBps = Number(process.env.SLIPPAGE_BPS ?? "30"); // 0.30%

  const onHead = async (bn: number) => {
    try {
      // Dynamic sizing for hop1 based on feeA pool
      let dynInARB = baseInARB;
      let dynInfo = "";
      try {
        const poolForA = poolA || findArbWethPoolAddressByFee(feeA) || undefined;
        if (poolForA) {
          const dyn = await getDynamicTradeSize(provider, poolForA, baseInARB, feeA, { log: false });
          dynInARB = dyn.adjustedSize;
          dynInfo  = ` (dyn ${ethers.formatUnits(dynInARB, 18)} from base ${ethers.formatUnits(baseInARB, 18)})`;
        }
      } catch {}

      // Hop 1: ARB->WETH (liquidity-aware fee fallback)
      const hop1 = await getQuoteWithFallback(
        quoterAddr, arbAddr, wethAddr, dynInARB,
        {
          configs: [
            { fee: 3000,  name: "0.3%",  num: 1n, den: 1n },
            { fee: 500,   name: "0.05%", num: 1n, den: 4n },
            { fee: 10000, name: "1.0%",  num: 1n, den: 2n },
          ],
          confirmFullAmount: true,
          log: false,
        }
      );
      const inARB = hop1.amountInUsed;
      const hop1OutWETH = hop1.amountOut;

      // Hop 2: WETH->ARB (prefer feeB)
      const hop2 = await getQuoteWithFallback(
        quoterAddr, wethAddr, arbAddr, hop1OutWETH,
        {
          configs: [
            { fee: feeB,  name: `${feeB/10000}%`, num: 1n, den: 1n },
            { fee: 3000,  name: "0.3%",          num: 1n, den: 1n },
            { fee: 500,   name: "0.05%",         num: 1n, den: 1n },
            { fee: 10000, name: "1.0%",          num: 1n, den: 1n },
          ],
          confirmFullAmount: false,
          log: false,
        }
      );
      const grossOutARB = hop2.amountOut;
      const minOutARB = applySlippageBps(grossOutARB, slippageBps);

      // Gas estimate via exec(...) (resolved overload)
      const dummySteps: Step[] = [
        { target: swap.target as string, data: "0x", value: 0n },
        { target: swap.target as string, data: "0x", value: 0n },
      ];
      const dummyData = encodeExec(arbAddr, minOutARB, dummySteps);

      const gas = await estimateGasARB(
        provider,
        { to: routerAddr, data: dummyData, value: 0n, from: await wallet.getAddress() },
        hop2.feeUsed
      );

      const evARB = evEstimateARB(grossOutARB, inARB, gas.gasAsArb);

      console.log(
        `[${bn}] grossARB=${Number(grossOutARB)/1e18} | inARB=${Number(inARB)/1e18}${dynInfo} | gas(ARB)~${Number(gas.gasAsArb)/1e18} | EV(ARB)=${Number(evARB)/1e18} | fees used: ${hop1.feeUsed}/${hop2.feeUsed}`
      );

      if (evARB <= minProfitARB) return;
      if (CONFIG.dryRun) { console.log("DRY_RUN: would trade"); return; }

      const deadline = Math.floor(Date.now() / 1000) + 30;

      const step1 = swap.interface.encodeFunctionData("exactInputSingle", [{
        tokenIn: arbAddr, tokenOut: wethAddr, fee: hop1.feeUsed, recipient: routerAddr,
        deadline, amountIn: inARB, amountOutMinimum: 0, sqrtPriceLimitX96: 0
      }]);

      const step2 = swap.interface.encodeFunctionData("exactInputSingle", [{
        tokenIn: wethAddr, tokenOut: arbAddr, fee: hop2.feeUsed, recipient: routerAddr,
        deadline, amountIn: hop1OutWETH, amountOutMinimum: minOutARB, sqrtPriceLimitX96: 0
      }]);

      const steps: Step[] = [
        { target: swap.target as string, data: step1, value: 0n },
        { target: swap.target as string, data: step2, value: 0n },
      ];

      const txData = encodeExec(arbAddr, minOutARB, steps);
      const tx     = await wallet.populateTransaction({ to: routerAddr, data: txData, value: 0n });

      const signed = await wallet.signTransaction(tx);
      const resp   = await RP.withProvider((p) => p.send("eth_sendRawTransaction", [signed]), { method: "eth_sendRawTransaction", allowNearLimit: true });
      console.log("Sent:", resp);
    } catch (e: any) {
      console.error("loop", e?.shortMessage || e?.message || e);
    }
  };

  const unsubHead = RP.onNewHeads(onHead);

  // (Optional) log subscription
  const swapTopic = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
  if (poolA) {
    const unsubLogs = RP.subscribeLogs(
      {
        addresses: [poolA],
        topics: [swapTopic],
        pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? "1500"),
        fromBlockLag: 2
      },
      () => {}
    );
    console.log("Filtered log subscription active for pool:", poolA);
    const onExit = () => { try { unsubHead(); unsubLogs(); } catch {}; process.exit(0); };
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);
  } else {
    const onExit = () => { try { unsubHead(); } catch {}; process.exit(0); };
    process.on("SIGINT", onExit);
    process.on("SIGTERM", onExit);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
