// src/searcher/run_watcher.ts
import "dotenv/config";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

import { Watcher } from "./watcher";
import { execLiquidation } from "./liquidation";
import { CONFIG } from "./config";
import { recordMetric } from "./metrics";

type WatcherConfig = {
  aaveData?: string;
  radiantData?: string;
  users?: string[];
  defaultPath?: { tokens: string[]; fees: number[] }; // ends with WETH
  pollSeconds?: number;
};

function loadConfig(): WatcherConfig {
  const p = path.join(process.cwd(), "watcher.config.json");
  if (!fs.existsSync(p)) throw new Error(`watcher.config.json not found at ${p}`);
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw) as WatcherConfig;
}

function getRpcUrl(): string {
  const env = (process.env.ARB_RPC_URL || "").trim();
  if (env) return env;
  const cfg = (CONFIG as any)?.rpcUrl;
  if (typeof cfg === "string" && cfg.trim()) return cfg.trim();
  throw new Error("Missing RPC URL (ARB_RPC_URL / CONFIG.rpcUrl).");
}

function parseWethEnvAmount(name: string, fallback: string): bigint {
  const raw = (process.env[name] || fallback).toString().trim();
  return ethers.parseUnits(raw, 18);
}

async function main() {
  const cfg = loadConfig();

  const provider = new ethers.JsonRpcProvider(getRpcUrl(), { name: "arbitrum", chainId: 42161 });

  const pk = (process.env.PRIVATE_KEY || "").trim();
  if (!pk) throw new Error("Missing PRIVATE_KEY");
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  const me = await wallet.getAddress();

  const users: string[] = Array.isArray(cfg.users) ? cfg.users : [];
  const poll = Math.max(5, Number(cfg.pollSeconds ?? 15));
  const dryRun = (process.env.DRY_RUN ?? "true").toString().toLowerCase() === "true";

  const WETH = (CONFIG as any)?.tokens?.WETH;
  if (!WETH || !ethers.isAddress(WETH)) {
    throw new Error("CONFIG.tokens.WETH missing/invalid for Arbitrum.");
  }

  const watcher = new Watcher(provider, {
    aaveData: cfg.aaveData,
    radiantData: cfg.radiantData,
    users,
  });

  console.log(`Watcher running. Poll=${poll}s | Users=${users.length} | DRY_RUN=${dryRun} | EOA=${me}`);

  // Validate path
  if (!cfg.defaultPath || !Array.isArray(cfg.defaultPath.tokens) || !Array.isArray(cfg.defaultPath.fees)) {
    console.warn("⚠️ defaultPath missing; liquidations will be skipped.");
  } else if (cfg.defaultPath.tokens.length !== cfg.defaultPath.fees.length + 1) {
    console.warn("⚠️ defaultPath length mismatch; liquidations will be skipped.");
  } else {
    const tail = cfg.defaultPath.tokens[cfg.defaultPath.tokens.length - 1];
    if (ethers.getAddress(tail) !== ethers.getAddress(WETH)) {
      console.warn("⚠️ defaultPath should end with WETH.");
    }
  }

  const debtToCoverWETH = parseWethEnvAmount("DEBT_TO_COVER_WETH", "0.1");
  const minOutWETH = (debtToCoverWETH * 99n) / 100n;

  while (true) {
    try {
      const candidates: Array<{
        protocol: "aave" | "radiant";
        user: string;
        healthFactorRay?: bigint | number | string;
      }> = await watcher.tick();

      if (Array.isArray(candidates) && candidates.length) {
        const summary = candidates.map((c) => {
          const hf =
            typeof c.healthFactorRay === "bigint"
              ? Number(c.healthFactorRay) / 1e27
              : typeof c.healthFactorRay === "number"
              ? c.healthFactorRay
              : typeof c.healthFactorRay === "string"
              ? Number(c.healthFactorRay)
              : NaN;
          const hfStr = isFinite(hf) ? hf.toFixed(6) : "n/a";
          return `${c.protocol}:${c.user} hf≈${hfStr}`;
        });
        console.log("candidates:", summary.join(" | "));
      }

      for (const c of candidates || []) {
        const pathCfg = cfg.defaultPath;
        if (
          !pathCfg ||
          !Array.isArray(pathCfg.tokens) ||
          !Array.isArray(pathCfg.fees) ||
          pathCfg.tokens.length !== pathCfg.fees.length + 1
        ) {
          console.warn("Skip: invalid/missing defaultPath");
          continue;
        }
        const tail = pathCfg.tokens[pathCfg.tokens.length - 1];
        if (!tail || ethers.getAddress(tail) !== ethers.getAddress(WETH)) {
          console.warn("Skip: defaultPath must end with WETH.");
          continue;
        }

        const collateral = pathCfg.tokens[0];
        const debtAsset = WETH;

        if (dryRun) {
          console.log(
            `[DRY_RUN] Would liquidate user=${c.user} protocol=${c.protocol} covering ${ethers.formatUnits(
              debtToCoverWETH,
              18
            )} WETH`
          );
          // Cast to any to avoid Metric type field restrictions
          recordMetric({
            ts: Date.now(),
            block: 0,
            route: "LIQ",
            executed: false,
            user: c.user,
            protocol: c.protocol,
            notionalWETH: Number(ethers.formatUnits(debtToCoverWETH, 18)),
            grossWETH: Number(ethers.formatUnits(minOutWETH, 18)),
            evWETH: Number(ethers.formatUnits(minOutWETH - debtToCoverWETH, 18)),
            gasWETH: 0,
          } as any);
          continue;
        }

        const txReq = await execLiquidation({
          signer: wallet,
          protocol: c.protocol,
          collateral,
          debtAsset,
          user: c.user,
          debtToCover: debtToCoverWETH,
          v3PathTokens: pathCfg.tokens,
          v3PathFees: pathCfg.fees,
          minOutWETH,
        });

        const resp = await wallet.sendTransaction(txReq);
        console.log(`[liq] sent ${resp.hash}`);
        const rc = await resp.wait();
        console.log(`[liq] confirmed in block ${rc?.blockNumber}`);

        recordMetric({
          ts: Date.now(),
          block: Number(rc?.blockNumber ?? 0),
          route: "LIQ",
          executed: true,
          txHash: resp.hash,
          success: true,
          user: c.user,
          protocol: c.protocol,
          notionalWETH: Number(ethers.formatUnits(debtToCoverWETH, 18)),
          grossWETH: Number(ethers.formatUnits(minOutWETH, 18)),
          evWETH: Number(ethers.formatUnits(minOutWETH - debtToCoverWETH, 18)),
          gasWETH: 0,
        } as any);
      }
    } catch (e: any) {
      console.error("watcher loop error:", e?.message || e);
    }

    await new Promise((r) => setTimeout(r, poll * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
