import { EventEmitter } from "events";
import { promises as fs } from "fs";
import path from "path";

export type CuStatusLevel = "healthy" | "warning" | "alert" | "emergency" | "exhausted";

export interface ProviderRegistration {
  name: string;
  displayName: string;
  dailyLimit: number;
  monthlyLimit: number;
  alertThreshold?: number; // percentage (0-100)
  emergencyThreshold?: number; // percentage (0-100)
}

export interface ProviderUsageSnapshot {
  name: string;
  displayName: string;
  dailyLimit: number;
  monthlyLimit: number;
  dailyUsed: number;
  monthlyUsed: number;
  dailyRemaining: number;
  monthlyRemaining: number;
  dailyPercent: number;
  monthlyPercent: number;
  status: CuStatusLevel;
  lastUpdated: string | null;
  requestCount: number;
  cuByMethod: Record<string, number>;
  cacheHits: number;
  cacheSavedCu: number;
  alertThreshold: number;
  emergencyThreshold: number;
}

export interface AggregatedUsageSnapshot {
  providers: ProviderUsageSnapshot[];
  totals: {
    dailyUsed: number;
    dailyLimit: number;
    dailyPercent: number;
    monthlyUsed: number;
    monthlyLimit: number;
    monthlyPercent: number;
    cacheHits: number;
    cacheSavedCu: number;
    requestCount: number;
  };
}

export interface CanUseOptions {
  allowNearLimit?: boolean;
  ignoreMonthly?: boolean;
  ignoreDaily?: boolean;
}

interface ProviderUsageInternal {
  registration: ProviderRegistration;
  dailyUsed: number;
  monthlyUsed: number;
  requestCount: number;
  lastUpdated: string | null;
  lastDailyReset: string | null;
  lastMonthlyReset: string | null;
  cuByMethod: Record<string, number>;
  cacheHits: number;
  cacheSavedCu: number;
}

interface TrackerFileData {
  version: number;
  updatedAt: string;
  providers: Record<string, Omit<ProviderUsageInternal, "registration"> & { registration: ProviderRegistration }>;
}

const DEFAULT_ALERT_THRESHOLD = Number(process.env.CU_ALERT_THRESHOLD ?? "80");
const DEFAULT_EMERGENCY_THRESHOLD = Number(process.env.CU_EMERGENCY_THRESHOLD ?? "95");

const STORAGE_FILE = (() => {
  const provided = (process.env.CU_TRACKER_FILE || "").trim();
  if (provided) return path.resolve(provided);
  return path.join(process.cwd(), "cache", "cu-usage.json");
})();

const METHOD_CU_ESTIMATES = new Map<string, number>([
  ["eth_blocknumber", 10],
  ["eth_getblockbynumber", 20],
  ["eth_getbalance", 15],
  ["eth_gettransactionreceipt", 25],
  ["eth_gettransactionbyhash", 25],
  ["eth_call", 26],
  ["eth_estimategas", 26],
  ["eth_sendrawtransaction", 40],
  ["eth_getlogs", 75],
  ["eth_newfilter", 45],
  ["eth_uninstallfilter", 5],
  ["eth_getfilterchanges", 20],
  ["eth_feehistory", 28],
  ["eth_gasprice", 12],
  ["eth_maxpriorityfeepergas", 12],
  ["debug_tracetransaction", 309],
  ["trace_transaction", 309],
  ["trace_block", 309],
  ["arbtrace_transaction", 309],
]);

function normaliseMethod(method: string | undefined | null): string {
  return (method ?? "custom").trim().toLowerCase();
}

function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date = new Date()): string {
  const iso = date.toISOString();
  return iso.slice(0, 7); // YYYY-MM
}

function ensureDir(filePath: string): Promise<void> {
  return fs.mkdir(path.dirname(filePath), { recursive: true }).then(() => {});
}

export function estimateMethodCu(method: string | undefined | null, fallback = 26): number {
  const key = normaliseMethod(method);
  return METHOD_CU_ESTIMATES.get(key) ?? fallback;
}

class CuTracker extends EventEmitter {
  private filePath: string;
  private providers = new Map<string, ProviderUsageInternal>();
  private persistPromise: Promise<void> | null = null;

  constructor(filePath = STORAGE_FILE) {
    super();
    this.filePath = filePath;
  }

  async bootstrap(): Promise<void> {
    await this.loadFromDisk();
  }

  registerProvider(reg: ProviderRegistration): void {
    const alertThreshold = reg.alertThreshold ?? DEFAULT_ALERT_THRESHOLD;
    const emergencyThreshold = reg.emergencyThreshold ?? DEFAULT_EMERGENCY_THRESHOLD;
    const clampedAlert = Math.max(1, Math.min(100, alertThreshold));
    const clampedEmergency = Math.max(clampedAlert, Math.min(100, emergencyThreshold));

    const existing = this.providers.get(reg.name);
    if (existing) {
      existing.registration = {
        ...reg,
        alertThreshold: clampedAlert,
        emergencyThreshold: clampedEmergency,
      };
      this.providers.set(reg.name, existing);
      return;
    }

    this.providers.set(reg.name, {
      registration: {
        ...reg,
        alertThreshold: clampedAlert,
        emergencyThreshold: clampedEmergency,
      },
      dailyUsed: 0,
      monthlyUsed: 0,
      requestCount: 0,
      lastUpdated: null,
      lastDailyReset: todayKey(),
      lastMonthlyReset: monthKey(),
      cuByMethod: {},
      cacheHits: 0,
      cacheSavedCu: 0,
    });
  }

  recordUsage(providerName: string, method?: string, cuOverride?: number): void {
    const state = this.providers.get(providerName);
    if (!state) return;

    const estimated = Math.max(0, Math.floor(cuOverride ?? estimateMethodCu(method)));
    this.maybeReset(state);

    state.dailyUsed += estimated;
    state.monthlyUsed += estimated;
    state.requestCount += 1;
    const key = normaliseMethod(method);
    state.cuByMethod[key] = (state.cuByMethod[key] ?? 0) + estimated;
    state.lastUpdated = new Date().toISOString();

    this.schedulePersist();
    this.emit("usage", this.getUsage(providerName));
  }

  recordCacheHit(providerName: string, cuSaved: number): void {
    const state = this.providers.get(providerName);
    if (!state) return;
    this.maybeReset(state);
    state.cacheHits += 1;
    state.cacheSavedCu += Math.max(0, Math.floor(cuSaved));
    this.schedulePersist();
    this.emit("usage", this.getUsage(providerName));
  }

  private maybeReset(state: ProviderUsageInternal): void {
    const today = todayKey();
    const month = monthKey();

    if (state.lastDailyReset !== today) {
      state.dailyUsed = 0;
      state.requestCount = 0;
      state.cacheHits = 0;
      state.cacheSavedCu = 0;
      state.cuByMethod = {};
      state.lastDailyReset = today;
    }
    if (state.lastMonthlyReset !== month) {
      state.monthlyUsed = 0;
      state.lastMonthlyReset = month;
    }
  }

  canUse(providerName: string, cuNeeded: number, options: CanUseOptions = {}): boolean {
    const state = this.providers.get(providerName);
    if (!state) return false;
    this.maybeReset(state);
    const { registration } = state;

    const nextDaily = state.dailyUsed + cuNeeded;
    const nextMonthly = state.monthlyUsed + cuNeeded;

    const allowNear = !!options.allowNearLimit;
    const dailyOk = options.ignoreDaily ? true : nextDaily <= registration.dailyLimit || (allowNear && state.dailyUsed < registration.dailyLimit);
    const monthlyOk = options.ignoreMonthly ? true : nextMonthly <= registration.monthlyLimit || (allowNear && state.monthlyUsed < registration.monthlyLimit);
    return dailyOk && monthlyOk;
  }

  resetProvider(providerName: string): void {
    const state = this.providers.get(providerName);
    if (!state) return;
    state.dailyUsed = 0;
    state.monthlyUsed = 0;
    state.requestCount = 0;
    state.cacheHits = 0;
    state.cacheSavedCu = 0;
    state.cuByMethod = {};
    state.lastDailyReset = todayKey();
    state.lastMonthlyReset = monthKey();
    state.lastUpdated = new Date().toISOString();
    this.schedulePersist(true);
    this.emit("usage", this.getUsage(providerName));
  }

  resetAll(): void {
    for (const key of this.providers.keys()) {
      this.resetProvider(key);
    }
  }

  getUsage(providerName: string): ProviderUsageSnapshot {
    const state = this.providers.get(providerName);
    if (!state) {
      return {
        name: providerName,
        displayName: providerName,
        dailyLimit: 0,
        monthlyLimit: 0,
        dailyUsed: 0,
        monthlyUsed: 0,
        dailyRemaining: 0,
        monthlyRemaining: 0,
        dailyPercent: 0,
        monthlyPercent: 0,
        status: "healthy",
        lastUpdated: null,
        requestCount: 0,
        cuByMethod: {},
        cacheHits: 0,
        cacheSavedCu: 0,
        alertThreshold: DEFAULT_ALERT_THRESHOLD,
        emergencyThreshold: DEFAULT_EMERGENCY_THRESHOLD,
      };
    }

    this.maybeReset(state);

    const { registration } = state;
    const dailyPercent = registration.dailyLimit === 0 ? 0 : (state.dailyUsed / registration.dailyLimit) * 100;
    const monthlyPercent = registration.monthlyLimit === 0 ? 0 : (state.monthlyUsed / registration.monthlyLimit) * 100;

    const status = this.computeStatusLevel(dailyPercent, monthlyPercent, registration);

    return {
      name: registration.name,
      displayName: registration.displayName,
      dailyLimit: registration.dailyLimit,
      monthlyLimit: registration.monthlyLimit,
      dailyUsed: state.dailyUsed,
      monthlyUsed: state.monthlyUsed,
      dailyRemaining: Math.max(0, registration.dailyLimit - state.dailyUsed),
      monthlyRemaining: Math.max(0, registration.monthlyLimit - state.monthlyUsed),
      dailyPercent,
      monthlyPercent,
      status,
      lastUpdated: state.lastUpdated,
      requestCount: state.requestCount,
      cuByMethod: { ...state.cuByMethod },
      cacheHits: state.cacheHits,
      cacheSavedCu: state.cacheSavedCu,
      alertThreshold: registration.alertThreshold ?? DEFAULT_ALERT_THRESHOLD,
      emergencyThreshold: registration.emergencyThreshold ?? DEFAULT_EMERGENCY_THRESHOLD,
    };
  }

  getAllUsage(): ProviderUsageSnapshot[] {
    return Array.from(this.providers.keys()).map((name) => this.getUsage(name));
  }

  getRegisteredProviders(): ProviderRegistration[] {
    return Array.from(this.providers.values()).map((state) => state.registration);
  }

  countByStatus(status: CuStatusLevel): number {
    return this.getAllUsage().filter((item) => item.status === status).length;
  }

  getAggregatedUsage(): AggregatedUsageSnapshot {
    const providers = this.getAllUsage();
    const totals = providers.reduce(
      (acc, provider) => {
        acc.dailyUsed += provider.dailyUsed;
        acc.dailyLimit += provider.dailyLimit;
        acc.monthlyUsed += provider.monthlyUsed;
        acc.monthlyLimit += provider.monthlyLimit;
        acc.cacheHits += provider.cacheHits;
        acc.cacheSavedCu += provider.cacheSavedCu;
        acc.requestCount += provider.requestCount;
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
    );

    totals.dailyPercent = totals.dailyLimit === 0 ? 0 : (totals.dailyUsed / totals.dailyLimit) * 100;
    totals.monthlyPercent = totals.monthlyLimit === 0 ? 0 : (totals.monthlyUsed / totals.monthlyLimit) * 100;

    return { providers, totals };
  }

  private computeStatusLevel(dailyPercent: number, monthlyPercent: number, registration: ProviderRegistration): CuStatusLevel {
    const alertThreshold = registration.alertThreshold ?? DEFAULT_ALERT_THRESHOLD;
    const emergencyThreshold = registration.emergencyThreshold ?? DEFAULT_EMERGENCY_THRESHOLD;
    const maxPercent = Math.max(dailyPercent, monthlyPercent);

    if (maxPercent >= 100) return "exhausted";
    if (maxPercent >= emergencyThreshold) return "emergency";
    if (maxPercent >= Math.max(alertThreshold, emergencyThreshold * 0.9)) return "alert";
    if (maxPercent >= alertThreshold) return "warning";
    return "healthy";
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data: TrackerFileData = JSON.parse(raw);
      const today = todayKey();
      const month = monthKey();
      for (const [name, stored] of Object.entries(data.providers)) {
        const reg = stored.registration;
        this.providers.set(name, {
          registration: reg,
          dailyUsed: stored.dailyUsed,
          monthlyUsed: stored.monthlyUsed,
          requestCount: stored.requestCount,
          lastUpdated: stored.lastUpdated,
          lastDailyReset: stored.lastDailyReset ?? today,
          lastMonthlyReset: stored.lastMonthlyReset ?? month,
          cuByMethod: stored.cuByMethod ?? {},
          cacheHits: stored.cacheHits ?? 0,
          cacheSavedCu: stored.cacheSavedCu ?? 0,
        });
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        await ensureDir(this.filePath);
        await fs.writeFile(this.filePath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), providers: {} }, null, 2));
      } else {
        throw err;
      }
    }
  }

  private schedulePersist(force = false): void {
    if (this.persistPromise && !force) return;
    this.persistPromise = (async () => {
      await ensureDir(this.filePath);
      const payload: TrackerFileData = {
        version: 1,
        updatedAt: new Date().toISOString(),
        providers: {},
      };
      for (const [name, state] of this.providers.entries()) {
        payload.providers[name] = {
          registration: state.registration,
          dailyUsed: state.dailyUsed,
          monthlyUsed: state.monthlyUsed,
          requestCount: state.requestCount,
          lastUpdated: state.lastUpdated,
          lastDailyReset: state.lastDailyReset,
          lastMonthlyReset: state.lastMonthlyReset,
          cuByMethod: state.cuByMethod,
          cacheHits: state.cacheHits,
          cacheSavedCu: state.cacheSavedCu,
        };
      }
      await fs.writeFile(this.filePath, JSON.stringify(payload, null, 2));
      this.persistPromise = null;
      this.emit("persist");
    })().catch((err) => {
      this.persistPromise = null;
      console.error("[cuTracker] failed to persist usage", err);
    });
  }
}

export const cuTracker = new CuTracker();

(async () => {
  try {
    await cuTracker.bootstrap();
  } catch (err) {
    console.error("[cuTracker] bootstrap failed", err);
  }
})();

export { METHOD_CU_ESTIMATES };
