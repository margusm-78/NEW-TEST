import { EventEmitter } from "events";
import { cuTracker, type AggregatedUsageSnapshot, type ProviderUsageSnapshot } from "./cuTracker";
import { providerStrategy } from "./providerStrategy";
import type { ProviderHealth, ProviderRole } from "./providerStrategy";

export interface ProviderMetrics extends ProviderUsageSnapshot {
  health: ProviderHealth;
  role: ProviderRole;
  priority: number;
  averageLatencyMs: number;
  totalFailures: number;
  totalSuccesses: number;
  consecutiveFailures: number;
  offlineUntil?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

export interface CuMetrics {
  timestamp: string;
  providers: ProviderMetrics[];
  totals: AggregatedUsageSnapshot["totals"];
  emergency: ReturnType<typeof providerStrategy.getEmergencyContext>;
}

const MONITOR_INTERVAL_MS = Math.max(10_000, Number(process.env.CU_MONITOR_INTERVAL ?? process.env.CU_STATUS_INTERVAL ?? "30") * 1000);

class CuMonitor extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private latest: CuMetrics | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    cuTracker.on("usage", () => this.debounceCollect());
    providerStrategy.on("provider-failure", () => this.debounceCollect());
    providerStrategy.on("emergency-mode-changed", () => this.debounceCollect());
  }

  start(): void {
    if (this.timer) return;
    providerStrategy.start();
    const handle = setInterval(() => this.collect(), MONITOR_INTERVAL_MS);
    if (typeof (handle as any).unref === "function") {
      (handle as any).unref();
    }
    this.timer = handle;
    this.collect();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  getLatestMetrics(): CuMetrics | null {
    return this.latest;
  }

  requestImmediateUpdate(): void {
    this.collect();
  }

  toggleEmergency(force: boolean, reason?: string): void {
    providerStrategy.forceEmergencyMode(force, reason);
    this.collect();
  }

  private debounceCollect(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.collect();
    }, 750);
  }

  private collect(): void {
    const state = providerStrategy.getStrategyState();
    const metrics: CuMetrics = {
      timestamp: new Date().toISOString(),
      providers: state.providers.map((p) => ({
        ...p.usage,
        health: p.health,
        role: p.role,
        priority: p.priority,
        averageLatencyMs: p.averageLatencyMs,
        totalFailures: p.totalFailures,
        totalSuccesses: p.totalSuccesses,
        consecutiveFailures: p.consecutiveFailures,
        offlineUntil: p.offlineUntil,
        lastSuccessAt: p.lastSuccessAt,
        lastFailureAt: p.lastFailureAt,
      })),
      totals: state.providers.reduce(
        (acc, provider) => {
          acc.dailyUsed += provider.usage.dailyUsed;
          acc.dailyLimit += provider.usage.dailyLimit;
          acc.monthlyUsed += provider.usage.monthlyUsed;
          acc.monthlyLimit += provider.usage.monthlyLimit;
          acc.cacheHits += provider.usage.cacheHits;
          acc.cacheSavedCu += provider.usage.cacheSavedCu;
          acc.requestCount += provider.usage.requestCount;
          return acc;
        },
        {
          dailyUsed: 0,
          dailyLimit: 0,
          dailyPercent: 0,
          monthlyUsed: 0,
          monthlyLimit: 0,
          monthlyPercent: 0,
          cacheHits: 0,
          cacheSavedCu: 0,
          requestCount: 0,
        }
      ),
      emergency: state.emergency,
    };

    metrics.totals.dailyPercent = metrics.totals.dailyLimit === 0 ? 0 : (metrics.totals.dailyUsed / metrics.totals.dailyLimit) * 100;
    metrics.totals.monthlyPercent = metrics.totals.monthlyLimit === 0 ? 0 : (metrics.totals.monthlyUsed / metrics.totals.monthlyLimit) * 100;

    this.latest = metrics;
    this.emit("update", metrics);
  }
}

export const cuMonitor = new CuMonitor();
