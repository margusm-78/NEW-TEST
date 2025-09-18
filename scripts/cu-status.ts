#!/usr/bin/env ts-node
import * as dotenv from "dotenv";
dotenv.config();

import { cuMonitor } from "../src/searcher/cuMonitor";
import { cuTracker } from "../src/searcher/cuTracker";
import { providerStrategy } from "../src/searcher/providerStrategy";
import { RP } from "../src/searcher/resilientProvider";
import type { CuMetrics, ProviderMetrics } from "../src/searcher/cuMonitor";

interface CliOptions {
  watch: boolean;
  interval: number;
  json: boolean;
  detailed: boolean;
  trends: boolean;
  reset?: string;
  emergency?: "on" | "off";
  provider?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    watch: false,
    interval: Number(process.env.CU_STATUS_INTERVAL ?? "30"),
    json: false,
    detailed: false,
    trends: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--watch":
        opts.watch = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--detailed":
        opts.detailed = true;
        break;
      case "--trends":
        opts.trends = true;
        break;
      case "--interval":
        opts.interval = Number(argv[++i] ?? opts.interval);
        break;
      case "--reset":
        opts.reset = argv[i + 1] && !argv[i + 1].startsWith("--") ? String(argv[++i]) : "all";
        break;
      case "--emergency":
        const mode = argv[++i];
        if (mode === "on" || mode === "off") opts.emergency = mode;
        break;
      case "--provider":
        opts.provider = argv[++i];
        break;
      default:
        break;
    }
  }

  opts.interval = Math.max(5, opts.interval);
  return opts;
}

function statusSymbol(status: ProviderMetrics["status"]): string {
  switch (status) {
    case "healthy":
      return "✅";
    case "warning":
      return "⚠️";
    case "alert":
      return "🟠";
    case "emergency":
      return "🚨";
    case "exhausted":
      return "❌";
    default:
      return "ℹ️";
  }
}

function blockForStatus(status: ProviderMetrics["status"]): string {
  switch (status) {
    case "healthy":
      return "🟩";
    case "warning":
      return "🟨";
    case "alert":
      return "🟧";
    case "emergency":
    case "exhausted":
      return "🟥";
    default:
      return "🟦";
  }
}

function progressBar(percent: number, status: ProviderMetrics["status"]): string {
  const filledChar = blockForStatus(status);
  const totalBlocks = 10;
  const filled = Math.min(totalBlocks, Math.max(0, Math.floor(percent / 10)));
  const segments = Array.from({ length: totalBlocks }, (_, i) => (i < filled ? filledChar : "⬜"));
  return `[${segments.join("")}]`;
}

function fmt(num: number, decimals = 1): string {
  if (!Number.isFinite(num)) return "0";
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(decimals)}M`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(decimals)}K`;
  return num.toFixed(decimals);
}

function renderProvider(provider: ProviderMetrics, prev?: ProviderMetrics, detailed = false, showTrend = false): string {
  const bar = progressBar(provider.dailyPercent, provider.status);
  const trendDelta = prev ? provider.dailyUsed - prev.dailyUsed : 0;
  const trendStr = showTrend ? ` (+${fmt(trendDelta, 0)} CU)` : "";
  const health = provider.health === "healthy" ? "" : ` ${provider.health.toUpperCase()}`;
  const monthly = detailed ? ` │ Monthly: ${progressBar(provider.monthlyPercent, provider.status)} ${provider.monthlyPercent.toFixed(1)}%` : "";
  const cacheInfo = detailed ? ` │ Cache saves: ${fmt(provider.cacheSavedCu, 0)} CU (${provider.cacheHits} hits)` : "";
  const failures = detailed && provider.totalFailures > 0 ? ` │ Failures: ${provider.totalFailures}` : "";
  return `${statusSymbol(provider.status)} ${provider.name.padEnd(10)} │ Daily: ${bar}  ${provider.dailyPercent.toFixed(1)}%${trendStr}${monthly}${health}${cacheInfo}${failures}`;
}

function renderMetrics(metrics: CuMetrics, previous?: CuMetrics, opts?: { detailed?: boolean; trends?: boolean; filter?: string }): string {
  const lines: string[] = [];
  lines.push("📊 CU Status Summary:");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const providers = metrics.providers
    .filter((p) => !opts?.filter || p.name.toLowerCase() === opts.filter.toLowerCase())
    .sort((a, b) => a.priority - b.priority);

  for (const provider of providers) {
    const prev = previous?.providers.find((p) => p.name === provider.name);
    lines.push(renderProvider(provider, prev, opts?.detailed, opts?.trends));
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(
    `📈 Total Usage: ${metrics.totals.dailyUsed.toLocaleString()} CU today, ${metrics.totals.monthlyUsed.toLocaleString()} CU this month`
  );
  const emergency = metrics.emergency;
  lines.push(
    emergency.active
      ? `🚨 Emergency mode active (${emergency.reason ?? "auto"}) — cache x${emergency.adjustments.cacheTtlMultiplier}, operations ×${emergency.adjustments.operationLimiter}`
      : "🛡️ Emergency mode inactive"
  );
  return lines.join("\n");
}

async function fetchMetrics(): Promise<CuMetrics> {
  const current = cuMonitor.getLatestMetrics();
  if (current) return current;
  return await new Promise((resolve) => {
    const handler = (metrics: CuMetrics) => {
      cuMonitor.off("update", handler);
      resolve(metrics);
    };
    cuMonitor.on("update", handler);
    cuMonitor.requestImmediateUpdate();
  });
}

async function handleReset(target?: string) {
  if (!target || target === "all") {
    cuTracker.resetAll();
    console.log("🔄 Reset CU usage for all providers");
    return;
  }
  cuTracker.resetProvider(target);
  console.log(`🔄 Reset CU usage for provider ${target}`);
}

async function handleEmergencyToggle(mode: "on" | "off") {
  if (mode === "on") {
    cuMonitor.toggleEmergency(true, "cli");
    console.log("🚨 Emergency mode forced ON");
  } else {
    cuMonitor.toggleEmergency(false, "cli");
    console.log("🛡️ Emergency mode forced OFF");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await RP.ensureReady();
  cuMonitor.start();

  if (opts.reset) await handleReset(opts.reset);
  if (opts.emergency) await handleEmergencyToggle(opts.emergency);

  if (opts.json && opts.watch) {
    console.error("--json cannot be combined with --watch");
    process.exit(1);
  }

  let previous: CuMetrics | undefined;

  const renderOnce = async () => {
    const metrics = await fetchMetrics();
    if (opts.json) {
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      console.clear();
      console.log(renderMetrics(metrics, previous, { detailed: opts.detailed, trends: opts.trends, filter: opts.provider }));
      console.log();
      console.log("Providers registered:", providerStrategy.getProviderNames().join(", "));
    }
    previous = metrics;
  };

  await renderOnce();

  if (opts.watch) {
    setInterval(renderOnce, opts.interval * 1000);
  } else {
    setTimeout(() => process.exit(0), 100).unref();
  }
}

main().catch((err) => {
  console.error("cu-status failed", err);
  process.exit(1);
});
