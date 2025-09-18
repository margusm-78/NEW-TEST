import { EventEmitter } from "events";
import { cuTracker, estimateMethodCu, type ProviderUsageSnapshot, type ProviderRegistration, type CuStatusLevel } from "./cuTracker";

export type ProviderRole = "primary" | "secondary" | "tertiary" | "emergency";
export type ProviderHealth = "healthy" | "degraded" | "offline";

export interface ProviderDefinition extends ProviderRegistration {
  priority: number;
  role: ProviderRole;
  trafficCap?: number; // 0-1 weight to cap share of traffic
  costWeight?: number; // relative cost for cost_optimized strategy (lower = cheaper)
  emergencyOnly?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ProviderExecutionContext {
  provider: ProviderState;
  estimatedCu: number;
  emergency: boolean;
  attempt: number;
  totalAttempts: number;
  cacheHit: boolean;
}

export interface ProviderRequestOptions {
  method?: string;
  params?: unknown[];
  cuOverride?: number;
  label?: string;
  cacheable?: boolean;
  cacheKey?: string;
  ttlSeconds?: number;
  forceProvider?: string;
  preferredProvider?: string;
  allowNearLimit?: boolean;
  respectEmergencyRestrictions?: boolean;
  maxAttempts?: number; // across providers
  maxProviderAttempts?: number; // per provider
  emergencyBypass?: boolean;
}

interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  expiresAt: number;
  providerName: string;
  estimatedCu: number;
  hits: number;
  createdAt: number;
  method: string;
}

interface ProviderState extends ProviderDefinition {
  health: ProviderHealth;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  lastSelectedAt?: number;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  averageLatencyMs: number;
  offlineUntil?: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  stored: number;
  evictions: number;
  savedCu: number;
}

interface EmergencyContext {
  active: boolean;
  manual: boolean;
  reason: string | null;
  since: number | null;
  adjustments: {
    scanIntervalMultiplier: number;
    operationLimiter: number;
    cacheTtlMultiplier: number;
  };
}

const DEFAULT_STRATEGY = (process.env.PROVIDER_STRATEGY || "capacity_based").toLowerCase();
const STATUS_INTERVAL_MS = Math.max(5_000, Number(process.env.CU_STATUS_INTERVAL ?? "30") * 1000);
const PROVIDER_FAILURE_THRESHOLD = Number(process.env.PROVIDER_FAILURE_THRESHOLD ?? "3");
const PROVIDER_OFFLINE_COOLDOWN_MS = Number(process.env.PROVIDER_OFFLINE_COOLDOWN_MS ?? "45000");
const CACHE_ENABLED = ((process.env.CACHING_ENABLED ?? "true").trim().toLowerCase() !== "false");
const CACHE_BASE_TTL_SECONDS = Math.max(1, Number(process.env.CACHE_TTL_SECONDS ?? "30"));
const CACHE_MAX_SIZE = Math.max(10, Number(process.env.CACHE_MAX_SIZE ?? "1000"));
const AGGRESSIVE_CACHING = ((process.env.ENABLE_AGGRESSIVE_CACHING ?? "false").trim().toLowerCase() === "true");
const EMERGENCY_PROVIDER_COUNT = Math.max(1, Number(process.env.EMERGENCY_PROVIDER_COUNT ?? "2"));
const EMERGENCY_DAILY_THRESHOLD = Number(process.env.EMERGENCY_DAILY_THRESHOLD ?? process.env.CU_EMERGENCY_THRESHOLD ?? "95");
const EMERGENCY_MONTHLY_THRESHOLD = Number(process.env.EMERGENCY_MONTHLY_THRESHOLD ?? process.env.CU_EMERGENCY_THRESHOLD ?? "95");

function buildDefaultDefinition(reg: ProviderRegistration): ProviderDefinition {
  return {
    ...reg,
    priority: 0,
    role: "primary",
  };
}

function serialiseParams(params?: unknown[]): string {
  if (!params || params.length === 0) return "";
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}

function normaliseName(name: string): string {
  return name.toLowerCase();
}

function scoreFromUsage(snapshot: ProviderUsageSnapshot): number {
  const dailyRemaining = snapshot.dailyLimit === 0 ? 0 : (snapshot.dailyLimit - snapshot.dailyUsed) / snapshot.dailyLimit;
  const monthlyRemaining = snapshot.monthlyLimit === 0 ? 0 : (snapshot.monthlyLimit - snapshot.monthlyUsed) / snapshot.monthlyLimit;
  return (dailyRemaining + monthlyRemaining) / 2;
}

class ProviderStrategy extends EventEmitter {
  private providers = new Map<string, ProviderState>();
  private cache = new Map<string, CacheEntry>();
  private cacheStats: CacheStats = { hits: 0, misses: 0, stored: 0, evictions: 0, savedCu: 0 };
  private manualEmergency = false;
  private emergencyActive = false;
  private emergencyReason: string | null = null;
  private emergencySince: number | null = null;
  private roundRobinCounter = 0;
  private timer: NodeJS.Timeout | null = null;

  configureProviders(defs: ProviderDefinition[]): void {
    const seen = new Set<string>();
    for (const def of defs) {
      const existing = this.providers.get(def.name);
      const registration = buildDefaultDefinition(def);
      registration.priority = def.priority;
      registration.role = def.role;
      registration.trafficCap = def.trafficCap;
      registration.costWeight = def.costWeight;
      registration.emergencyOnly = def.emergencyOnly;
      registration.metadata = def.metadata;

      if (existing) {
        this.providers.set(def.name, {
          ...existing,
          ...registration,
        });
      } else {
        this.providers.set(def.name, {
          ...registration,
          health: "healthy",
          consecutiveFailures: 0,
          totalFailures: 0,
          totalSuccesses: 0,
          averageLatencyMs: 0,
        });
      }
      seen.add(def.name);
      cuTracker.registerProvider(def);
    }

    for (const key of Array.from(this.providers.keys())) {
      if (!seen.has(key)) this.providers.delete(key);
    }

    this.evaluateEmergency("configure");
  }

  start(): void {
    if (this.timer) return;
    const handle = setInterval(() => this.evaluateEmergency("interval"), STATUS_INTERVAL_MS);
    if (typeof (handle as any).unref === "function") {
      (handle as any).unref();
    }
    this.timer = handle;
    this.evaluateEmergency("start");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  getProviderState(name: string): ProviderState | undefined {
    return this.providers.get(name);
  }

  isEmergencyMode(): boolean {
    return this.emergencyActive;
  }

  getEmergencyContext(): EmergencyContext {
    return {
      active: this.emergencyActive,
      manual: this.manualEmergency,
      reason: this.emergencyReason,
      since: this.emergencySince,
      adjustments: {
        scanIntervalMultiplier: this.emergencyActive ? 2 : 1,
        operationLimiter: this.emergencyActive ? 0.5 : 1,
        cacheTtlMultiplier: this.emergencyActive ? 2 : 1,
      },
    };
  }

  forceEmergencyMode(force: boolean, reason?: string): void {
    this.manualEmergency = force;
    this.emergencyReason = force ? reason ?? "manual" : null;
    if (force) {
      if (!this.emergencyActive) {
        this.emergencyActive = true;
        this.emergencySince = Date.now();
        this.emit("emergency-mode-changed", this.getEmergencyContext());
      }
    } else {
      this.evaluateEmergency("manual-toggle");
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.cacheStats = { hits: 0, misses: 0, stored: 0, evictions: 0, savedCu: 0 };
  }

  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  async executeWithBestProvider<T>(
    method: string,
    params: unknown[] | undefined,
    executor: (providerName: string, context: ProviderExecutionContext) => Promise<T>,
    options: ProviderRequestOptions = {}
  ): Promise<T> {
    const methodName = options.method ?? method;
    const estimatedCu = Math.max(1, Math.floor(options.cuOverride ?? estimateMethodCu(methodName)));
    const label = options.label ?? methodName;

    const cacheKey = options.cacheable && CACHE_ENABLED
      ? options.cacheKey ?? `${methodName}|${serialiseParams(params)}`
      : null;

    if (cacheKey) {
      const entry = this.cache.get(cacheKey);
      if (entry && entry.expiresAt > Date.now()) {
        this.cacheStats.hits += 1;
        this.cacheStats.savedCu += entry.estimatedCu;
        entry.hits += 1;
        cuTracker.recordCacheHit(entry.providerName, entry.estimatedCu);
        return entry.value as T;
      }
      if (entry) this.cache.delete(cacheKey);
    } else if (CACHE_ENABLED) {
      this.cacheStats.misses += 1;
    }

    const candidates = this.buildProviderOrder(methodName, estimatedCu, options);
    if (candidates.length === 0) {
      throw new Error(`[providerStrategy] no providers available for ${label}`);
    }

    const maxAttempts = Math.max(1, options.maxAttempts ?? candidates.length);
    const providerAttempts = Math.max(1, options.maxProviderAttempts ?? 1);

    let attempt = 0;
    let lastError: unknown;

    for (const provider of candidates) {
      if (attempt >= maxAttempts) break;
      if (!this.canUseProvider(provider, estimatedCu, options)) {
        continue;
      }

      for (let i = 0; i < providerAttempts && attempt < maxAttempts; i++) {
        attempt += 1;
        const start = Date.now();
        try {
          const result = await executor(provider.name, {
            provider,
            estimatedCu,
            emergency: this.emergencyActive,
            attempt,
            totalAttempts: maxAttempts,
            cacheHit: false,
          });
          const latency = Date.now() - start;
          this.handleSuccess(provider, latency);
          cuTracker.recordUsage(provider.name, methodName, estimatedCu);
          this.evaluateEmergency(`usage:${provider.name}`);

          if (cacheKey && CACHE_ENABLED) {
            const ttl = this.resolveCacheTtlSeconds(options.ttlSeconds);
            const entry: CacheEntry = {
              key: cacheKey,
              value: result,
              expiresAt: Date.now() + ttl * 1000,
              providerName: provider.name,
              estimatedCu,
              hits: 0,
              createdAt: Date.now(),
              method: methodName,
            };
            this.cache.set(cacheKey, entry);
            this.cacheStats.stored += 1;
            this.enforceCacheLimit();
          }

          return result;
        } catch (err) {
          lastError = err;
          this.handleFailure(provider, err);
          this.evaluateEmergency(`error:${provider.name}`);
        }
      }
    }

    throw lastError ?? new Error(`[providerStrategy] no providers succeeded for ${label}`);
  }

  private resolveCacheTtlSeconds(ttlOverride?: number): number {
    if (!CACHE_ENABLED) return 0;
    if (ttlOverride && ttlOverride > 0) return ttlOverride;
    let ttl = CACHE_BASE_TTL_SECONDS;
    if (AGGRESSIVE_CACHING) ttl = Math.max(ttl, CACHE_BASE_TTL_SECONDS * 1.5);
    if (this.emergencyActive) ttl = Math.max(ttl, CACHE_BASE_TTL_SECONDS * 2);
    return Math.floor(ttl);
  }

  private enforceCacheLimit(): void {
    if (this.cache.size <= CACHE_MAX_SIZE) return;
    const entries = Array.from(this.cache.values()).sort((a, b) => a.expiresAt - b.expiresAt);
    const removeCount = this.cache.size - CACHE_MAX_SIZE;
    for (let i = 0; i < removeCount; i++) {
      const entry = entries[i];
      if (!entry) break;
      this.cache.delete(entry.key);
      this.cacheStats.evictions += 1;
    }
  }

  private canUseProvider(provider: ProviderState, estimatedCu: number, options: ProviderRequestOptions): boolean {
    if (provider.health === "offline" && provider.offlineUntil && provider.offlineUntil > Date.now()) {
      return false;
    }
    if (provider.emergencyOnly && !this.emergencyActive && !options.emergencyBypass) {
      return false;
    }
    if (!cuTracker.canUse(provider.name, estimatedCu, { allowNearLimit: options.allowNearLimit })) {
      return false;
    }
    return true;
  }

  private buildProviderOrder(method: string, estimatedCu: number, options: ProviderRequestOptions): ProviderState[] {
    let providers = Array.from(this.providers.values());

    if (options.forceProvider) {
      const forced = this.providers.get(options.forceProvider);
      providers = forced ? [forced] : [];
    }

    if (providers.length === 0) return providers;

    if (this.emergencyActive && options.respectEmergencyRestrictions !== false) {
      const emergencyCandidates = providers.filter((p) => p.role !== "primary" || p.emergencyOnly);
      if (emergencyCandidates.length > 0) providers = emergencyCandidates;
    }

    if (options.preferredProvider) {
      providers.sort((a, b) => {
        if (a.name === options.preferredProvider) return -1;
        if (b.name === options.preferredProvider) return 1;
        return 0;
      });
    }

    const usageSnapshots = new Map<string, ProviderUsageSnapshot>();
    for (const p of providers) {
      usageSnapshots.set(p.name, cuTracker.getUsage(p.name));
    }

    const strategy = DEFAULT_STRATEGY;

    if (strategy === "round_robin") {
      const sorted = providers.sort((a, b) => a.priority - b.priority);
      const rotated = sorted.slice(this.roundRobinCounter).concat(sorted.slice(0, this.roundRobinCounter));
      this.roundRobinCounter = (this.roundRobinCounter + 1) % Math.max(1, sorted.length);
      return rotated;
    }

    if (strategy === "cost_optimized") {
      return providers
        .slice()
        .sort((a, b) => {
          const costA = a.costWeight ?? a.priority;
          const costB = b.costWeight ?? b.priority;
          if (costA !== costB) return costA - costB;
          const usageA = usageSnapshots.get(a.name);
          const usageB = usageSnapshots.get(b.name);
          const scoreA = usageA ? scoreFromUsage(usageA) : 0;
          const scoreB = usageB ? scoreFromUsage(usageB) : 0;
          return scoreB - scoreA;
        });
    }

    if (strategy === "emergency") {
      return providers
        .filter((p) => p.role !== "primary")
        .sort((a, b) => a.priority - b.priority);
    }

    // default capacity_based
    return providers
      .slice()
      .sort((a, b) => {
        const usageA = usageSnapshots.get(a.name);
        const usageB = usageSnapshots.get(b.name);
        const scoreA = usageA ? scoreFromUsage(usageA) : 0;
        const scoreB = usageB ? scoreFromUsage(usageB) : 0;
        if (scoreA !== scoreB) return scoreB - scoreA;
        return a.priority - b.priority;
      });
  }

  private handleSuccess(provider: ProviderState, latency: number): void {
    provider.lastSuccessAt = Date.now();
    provider.lastSelectedAt = provider.lastSuccessAt;
    provider.totalSuccesses += 1;
    provider.consecutiveFailures = 0;
    provider.health = "healthy";
    const prev = provider.averageLatencyMs;
    if (prev === 0) provider.averageLatencyMs = latency;
    else provider.averageLatencyMs = Math.round(prev * 0.7 + latency * 0.3);
  }

  private handleFailure(provider: ProviderState, _err: unknown): void {
    provider.lastFailureAt = Date.now();
    provider.consecutiveFailures += 1;
    provider.totalFailures += 1;
    if (provider.consecutiveFailures >= PROVIDER_FAILURE_THRESHOLD) {
      provider.health = "offline";
      provider.offlineUntil = Date.now() + PROVIDER_OFFLINE_COOLDOWN_MS;
    } else {
      provider.health = "degraded";
    }
    this.emit("provider-failure", { provider: provider.name, failures: provider.consecutiveFailures });
  }

  private evaluateEmergency(source: string): void {
    if (this.manualEmergency) {
      if (!this.emergencyActive) {
        this.emergencyActive = true;
        this.emergencySince = Date.now();
        this.emit("emergency-mode-changed", this.getEmergencyContext());
      }
      return;
    }

    const aggregated = cuTracker.getAggregatedUsage();
    const emergencyProviders = aggregated.providers.filter(
      (p) => p.dailyPercent >= EMERGENCY_DAILY_THRESHOLD || p.monthlyPercent >= EMERGENCY_MONTHLY_THRESHOLD || p.status === "emergency"
    );
    const alerts = aggregated.providers.filter((p) => p.status === "alert" || p.status === "emergency");

    const totalEmergency =
      aggregated.totals.dailyPercent >= EMERGENCY_DAILY_THRESHOLD || aggregated.totals.monthlyPercent >= EMERGENCY_MONTHLY_THRESHOLD;

    const shouldActivate = emergencyProviders.length > 0 || alerts.length >= EMERGENCY_PROVIDER_COUNT || totalEmergency;

    if (shouldActivate && !this.emergencyActive) {
      this.emergencyActive = true;
      this.emergencySince = Date.now();
      this.emergencyReason = `${source}:${emergencyProviders.map((p) => p.name).join(",") || "threshold"}`;
      this.emit("emergency-mode-changed", this.getEmergencyContext());
    } else if (!shouldActivate && this.emergencyActive) {
      this.emergencyActive = false;
      this.emergencySince = null;
      this.emergencyReason = null;
      this.emit("emergency-mode-changed", this.getEmergencyContext());
    }
  }

  getStrategyState(): {
    providers: (ProviderState & { usage: ProviderUsageSnapshot })[];
    cache: CacheStats & { size: number };
    emergency: EmergencyContext;
  } {
    const providers = Array.from(this.providers.values()).map((provider) => ({
      ...provider,
      usage: cuTracker.getUsage(provider.name),
    }));
    return {
      providers,
      cache: { ...this.cacheStats, size: this.cache.size },
      emergency: this.getEmergencyContext(),
    };
  }

  getProvidersByStatus(status: CuStatusLevel): ProviderState[] {
    return this.getStrategyState().providers.filter((p) => p.usage.status === status);
  }
}

export const providerStrategy = new ProviderStrategy();
