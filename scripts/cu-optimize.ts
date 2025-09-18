#!/usr/bin/env ts-node
import * as dotenv from "dotenv";
dotenv.config();

import { cuTracker, type ProviderUsageSnapshot } from "../src/searcher/cuTracker";
import { providerStrategy } from "../src/searcher/providerStrategy";
import { cuMonitor } from "../src/searcher/cuMonitor";
import { RP } from "../src/searcher/resilientProvider";

function banner(title: string): void {
  console.log("\n" + title);
  console.log("━".repeat(title.length));
}

function summarizeProvider(p: ProviderUsageSnapshot): string {
  return `${p.displayName.padEnd(10)} | daily ${p.dailyUsed.toLocaleString()} / ${p.dailyLimit.toLocaleString()} (${p.dailyPercent.toFixed(1)}%)`;
}

function buildRecommendations(providers: ProviderUsageSnapshot[], totalsDailyPercent: number): string[] {
  const recs: string[] = [];
  const highUsage = providers.filter((p) => p.dailyPercent >= 80);
  if (highUsage.length) {
    for (const provider of highUsage) {
      recs.push(
        `Reduce load on ${provider.displayName} (at ${provider.dailyPercent.toFixed(1)}%). Consider routing to lower-tier providers or increasing CACHE_TTL_SECONDS.`
      );
    }
  }

  const lowCache = providers.filter((p) => p.dailyPercent > 40 && p.cacheHits < 10);
  for (const provider of lowCache) {
    recs.push(
      `${provider.displayName}: cache hit rate is low (${provider.cacheHits} hits). Enable aggressive caching or increase cache TTL to cut CU consumption.`
    );
  }

  if (totalsDailyPercent >= 70) {
    recs.push(
      `Cluster usage at ${totalsDailyPercent.toFixed(1)}% of total capacity. Enable emergency guardrails earlier (set EMERGENCY_DAILY_THRESHOLD=${Math.max(80, Math.min(95, Math.round(totalsDailyPercent + 5)))}) and consider lowering scan concurrency.`
    );
  }

  if (recs.length === 0) {
    recs.push("Usage is well within limits. Maintain current configuration and monitor periodically.");
  }
  return recs;
}

function suggestConfig(providers: ProviderUsageSnapshot[], totalsDailyPercent: number) {
  const baseTtl = Number(process.env.CACHE_TTL_SECONDS ?? "30");
  const recommendedTtl = totalsDailyPercent > 75 ? Math.max(baseTtl, 60) : totalsDailyPercent > 60 ? Math.max(baseTtl, 45) : baseTtl;
  const aggressive = totalsDailyPercent > 65 ? "true" : String(process.env.ENABLE_AGGRESSIVE_CACHING ?? "false");
  const strategy = totalsDailyPercent > 70 ? "capacity_based" : (process.env.PROVIDER_STRATEGY ?? "capacity_based");
  const snippet = [
    "# Suggested CU optimization overrides",
    `PROVIDER_STRATEGY=${strategy}`,
    `CACHE_TTL_SECONDS=${recommendedTtl}`,
    `ENABLE_AGGRESSIVE_CACHING=${aggressive}`,
    `EMERGENCY_DAILY_THRESHOLD=${Math.round(Math.min(95, Math.max(85, totalsDailyPercent + 5)))}`,
    `EMERGENCY_PROVIDER_COUNT=${Math.max(2, providers.filter((p) => p.dailyPercent > 60).length || 2)}`,
  ];
  console.log(snippet.join("\n"));
}

async function recommend() {
  const { providers, totals } = cuTracker.getAggregatedUsage();
  banner("Provider summary");
  for (const provider of providers.sort((a, b) => a.dailyPercent - b.dailyPercent)) {
    console.log(summarizeProvider(provider));
  }

  banner("Top recommendations");
  const recs = buildRecommendations(providers, totals.dailyPercent);
  for (const rec of recs) console.log(`• ${rec}`);

  banner("Emergency posture");
  const emergency = providerStrategy.getEmergencyContext();
  console.log(
    emergency.active
      ? `Emergency mode ACTIVE since ${emergency.since ? new Date(emergency.since).toISOString() : "unknown"}`
      : "Emergency mode inactive"
  );
  console.log(
    `Auto-threshold daily: ${(process.env.EMERGENCY_DAILY_THRESHOLD ?? process.env.CU_EMERGENCY_THRESHOLD ?? "95")}%, monthly: ${
      process.env.EMERGENCY_MONTHLY_THRESHOLD ?? process.env.CU_EMERGENCY_THRESHOLD ?? "95"
    }%`
  );
}

async function analyze() {
  const { providers, totals } = cuTracker.getAggregatedUsage();
  banner("Detailed provider metrics");
  for (const provider of providers) {
    console.log(
      `${provider.displayName.padEnd(10)} | status=${provider.status.padEnd(10)} | daily=${provider.dailyUsed.toLocaleString()}/${provider.dailyLimit.toLocaleString()} (${provider.dailyPercent.toFixed(1)}%) | monthly=${provider.monthlyUsed.toLocaleString()} (${provider.monthlyPercent.toFixed(1)}%) | cacheSaved=${provider.cacheSavedCu.toLocaleString()} CU (${provider.cacheHits} hits)`
    );
  }
  banner("Totals");
  console.log(
    `Daily: ${totals.dailyUsed.toLocaleString()} / ${totals.dailyLimit.toLocaleString()} (${totals.dailyPercent.toFixed(1)}%)`
  );
  console.log(
    `Monthly: ${totals.monthlyUsed.toLocaleString()} / ${totals.monthlyLimit.toLocaleString()} (${totals.monthlyPercent.toFixed(1)}%)`
  );
}

async function applyEmergency() {
  providerStrategy.forceEmergencyMode(true, "optimizer");
  cuMonitor.start();
  console.log("🚨 Forced emergency mode. Scan intervals doubled and cache TTL boosted.");
}

async function exportConfig() {
  const { providers, totals } = cuTracker.getAggregatedUsage();
  suggestConfig(providers, totals.dailyPercent);
}

async function main() {
  const command = (process.argv[2] || "recommend").toLowerCase();
  await RP.ensureReady();
  cuMonitor.start();

  switch (command) {
    case "recommend":
      await recommend();
      break;
    case "analyze":
      await analyze();
      break;
    case "apply-emergency":
      await applyEmergency();
      break;
    case "export-config":
      await exportConfig();
      break;
    default:
      console.error(`Unknown command '${command}'. Use recommend | analyze | apply-emergency | export-config.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("cu-optimize failed", err);
  process.exit(1);
});
