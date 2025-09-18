import { ethers } from "ethers";
import { providerStrategy, type ProviderDefinition, type ProviderRequestOptions, type ProviderExecutionContext } from "./providerStrategy";
import { cuMonitor } from "./cuMonitor";

export type LogFilter = {
  addresses?: string[];
  topics?: (string | null)[];
  pollIntervalMs?: number;
  fromBlockLag?: number;
};

interface ProviderPreset {
  name: string;
  displayName: string;
  priority: number;
  role: "primary" | "secondary" | "tertiary" | "emergency";
  httpKeys: string[];
  wsKeys: string[];
  dailyLimit: number;
  monthlyLimit: number;
  alertThreshold?: number;
  emergencyThreshold?: number;
  trafficCap?: number;
  costWeight?: number;
  emergencyOnly?: boolean;
}

interface LoadedProvider extends ProviderDefinition {
  httpUrls: string[];
  wsUrls: string[];
}

interface ProviderRuntime {
  config: LoadedProvider;
  httpProviders: ethers.JsonRpcProvider[];
  wsProviders: ethers.WebSocketProvider[];
  httpIndex: number;
  wsIndex: number;
}

const ARB_NETWORK: ethers.Networkish = { name: "arbitrum", chainId: Number(process.env.CHAIN_ID ?? 42161) };

function envList(keys: string[]): string[] {
  const vals = new Set<string>();
  for (const key of keys) {
    const raw = (process.env[key] || "").trim();
    if (!raw) continue;
    for (const part of raw.split(/[,\s]+/g)) {
      const candidate = part.trim();
      if (!candidate) continue;
      vals.add(candidate.replace(/\/+$/, ""));
    }
  }
  return Array.from(vals).filter((value) => value.startsWith("http"));
}

function envWsList(keys: string[]): string[] {
  const vals = new Set<string>();
  for (const key of keys) {
    const raw = (process.env[key] || "").trim();
    if (!raw) continue;
    for (const part of raw.split(/[,\s]+/g)) {
      const candidate = part.trim();
      if (!candidate) continue;
      vals.add(candidate.replace(/\/+$/, ""));
    }
  }
  return Array.from(vals).filter((value) => value.startsWith("ws"));
}

function mask(url: string): string {
  return url.replace(/[A-Za-z0-9_-]{16,}/g, "***");
}

function loadProviderPresets(): ProviderPreset[] {
  const baseDaily = Number(process.env.DAILY_CU_LIMIT ?? "1000000");
  const baseMonthly = Number(process.env.MONTHLY_CU_LIMIT ?? "30000000");

  const presets: ProviderPreset[] = [
    {
      name: "alchemy",
      displayName: "Alchemy",
      priority: 0,
      role: "primary",
      httpKeys: [
        "ALCHEMY_HTTP_URL",
        "ALCHEMY_RPC_URL",
        "ARB_RPC_URL",
        "ARB_RPC_URL_PRIMARY",
        "ARB_RPC_URL_BACKUP_1",
        "ARB_RPC_URL_BACKUP_2",
        "ARB_RPC_URL_BACKUP_3",
      ],
      wsKeys: ["ALCHEMY_WS_URL", "ARB_WS_URL", "ARB_WS_URL_PRIMARY"],
      dailyLimit: Number(process.env.ALCHEMY_DAILY_LIMIT ?? baseDaily),
      monthlyLimit: Number(process.env.ALCHEMY_MONTHLY_LIMIT ?? baseMonthly),
      alertThreshold: Number(process.env.ALCHEMY_ALERT_THRESHOLD ?? process.env.CU_ALERT_THRESHOLD ?? "80"),
      emergencyThreshold: Number(process.env.ALCHEMY_EMERGENCY_THRESHOLD ?? process.env.CU_EMERGENCY_THRESHOLD ?? "95"),
      trafficCap: Number(process.env.CAP_ALCHEMY ?? "1.0"),
      costWeight: Number(process.env.ALCHEMY_COST_WEIGHT ?? "1"),
    },
    {
      name: "quicknode",
      displayName: "QuickNode",
      priority: 1,
      role: "secondary",
      httpKeys: ["QUICKNODE_HTTP_URL", "QUICKNODE_RPC_URL", "ARB_RPC_URL_BACKUP_4", "ARB_RPC_URL_BACKUP_5"],
      wsKeys: ["QUICKNODE_WS_URL", "ARB_WS_URL_BACKUP_1"],
      dailyLimit: Number(process.env.QUICKNODE_DAILY_LIMIT ?? "500000"),
      monthlyLimit: Number(process.env.QUICKNODE_MONTHLY_LIMIT ?? "15000000"),
      alertThreshold: Number(process.env.QUICKNODE_ALERT_THRESHOLD ?? process.env.CU_ALERT_THRESHOLD ?? "80"),
      emergencyThreshold: Number(process.env.QUICKNODE_EMERGENCY_THRESHOLD ?? process.env.CU_EMERGENCY_THRESHOLD ?? "95"),
      trafficCap: Number(process.env.CAP_QUICKNODE ?? "0.8"),
      costWeight: Number(process.env.QUICKNODE_COST_WEIGHT ?? "1.2"),
    },
    {
      name: "llama",
      displayName: "Llama",
      priority: 2,
      role: "tertiary",
      httpKeys: ["LLAMA_HTTP_URL", "LLAMA_RPC_URL", "ARB_RPC_URL_BACKUP_6", "ARB_RPC_URL_BACKUP_7"],
      wsKeys: ["LLAMA_WS_URL", "ARB_WS_URL_BACKUP_2"],
      dailyLimit: Number(process.env.LLAMA_DAILY_LIMIT ?? "300000"),
      monthlyLimit: Number(process.env.LLAMA_MONTHLY_LIMIT ?? "9000000"),
      alertThreshold: Number(process.env.LLAMA_ALERT_THRESHOLD ?? process.env.CU_ALERT_THRESHOLD ?? "80"),
      emergencyThreshold: Number(process.env.LLAMA_EMERGENCY_THRESHOLD ?? process.env.CU_EMERGENCY_THRESHOLD ?? "95"),
      trafficCap: Number(process.env.CAP_LLAMA ?? "0.8"),
      costWeight: Number(process.env.LLAMA_COST_WEIGHT ?? "1.4"),
    },
    {
      name: "infura",
      displayName: "Infura",
      priority: 3,
      role: "emergency",
      httpKeys: ["INFURA_HTTP_URL", "INFURA_RPC_URL", "ARB_RPC_URL_BACKUP_8", "ARB_RPC_URL_BACKUP_9", "ARB_RPC_URL_BACKUP_10"],
      wsKeys: ["INFURA_WS_URL", "ARB_WS_URL_BACKUP_3"],
      dailyLimit: Number(process.env.INFURA_DAILY_LIMIT ?? "100000"),
      monthlyLimit: Number(process.env.INFURA_MONTHLY_LIMIT ?? "3000000"),
      alertThreshold: Number(process.env.INFURA_ALERT_THRESHOLD ?? process.env.CU_ALERT_THRESHOLD ?? "80"),
      emergencyThreshold: Number(process.env.INFURA_EMERGENCY_THRESHOLD ?? process.env.CU_EMERGENCY_THRESHOLD ?? "95"),
      trafficCap: Number(process.env.CAP_INFURA ?? "0.05"),
      costWeight: Number(process.env.INFURA_COST_WEIGHT ?? "1.6"),
      emergencyOnly: true,
    },
  ];

  return presets;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    });
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function testHttp(url: string): Promise<ethers.JsonRpcProvider | null> {
  try {
    const provider = new ethers.JsonRpcProvider(url, ARB_NETWORK);
    await withTimeout(provider.getBlockNumber(), Number(process.env.PROVIDER_PROBE_TIMEOUT_MS ?? "2500"));
    return provider;
  } catch {
    return null;
  }
}

async function testWs(url: string): Promise<ethers.WebSocketProvider | null> {
  try {
    const provider = new ethers.WebSocketProvider(url, ARB_NETWORK);
    await withTimeout(provider.getBlockNumber(), Number(process.env.PROVIDER_PROBE_TIMEOUT_MS ?? "3000"));
    return provider;
  } catch {
    return null;
  }
}

function loadProvidersFromEnv(): LoadedProvider[] {
  const presets = loadProviderPresets();
  const providers: LoadedProvider[] = [];

  for (const preset of presets) {
    const httpUrls = envList(preset.httpKeys);
    const wsUrls = envWsList(preset.wsKeys);
    if (httpUrls.length === 0 && wsUrls.length === 0) continue;

    providers.push({
      name: preset.name,
      displayName: preset.displayName,
      dailyLimit: preset.dailyLimit,
      monthlyLimit: preset.monthlyLimit,
      alertThreshold: preset.alertThreshold,
      emergencyThreshold: preset.emergencyThreshold,
      priority: preset.priority,
      role: preset.role,
      trafficCap: preset.trafficCap,
      costWeight: preset.costWeight,
      emergencyOnly: preset.emergencyOnly,
      metadata: { httpUrls: httpUrls.length, wsUrls: wsUrls.length },
      httpUrls,
      wsUrls,
    });
  }

  if (providers.length === 0) {
    throw new Error("No RPC providers configured. Set ALCHEMY_HTTP_URL or ARB_RPC_URL in your .env");
  }

  return providers;
}

class ResilientProviderManager {
  private providers = new Map<string, ProviderRuntime>();
  private ready: Promise<void>;
  private primaryProviderName: string | null = null;

  constructor() {
    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    const configs = loadProvidersFromEnv();

    const strategyDefs: ProviderDefinition[] = configs.map((cfg) => ({
      name: cfg.name,
      displayName: cfg.displayName,
      dailyLimit: cfg.dailyLimit,
      monthlyLimit: cfg.monthlyLimit,
      alertThreshold: cfg.alertThreshold,
      emergencyThreshold: cfg.emergencyThreshold,
      priority: cfg.priority,
      role: cfg.role,
      trafficCap: cfg.trafficCap,
      costWeight: cfg.costWeight,
      emergencyOnly: cfg.emergencyOnly,
      metadata: cfg.metadata,
    }));

    providerStrategy.configureProviders(strategyDefs);
    providerStrategy.start();
    cuMonitor.start();

    for (const cfg of configs) {
      const httpProbes = await Promise.all(cfg.httpUrls.map((url) => testHttp(url)));
      const httpProviders = httpProbes.filter((p): p is ethers.JsonRpcProvider => !!p);
      if (httpProviders.length === 0 && cfg.httpUrls.length > 0) {
        // fallback to first even if probe failed
        httpProviders.push(new ethers.JsonRpcProvider(cfg.httpUrls[0], ARB_NETWORK));
      }

      const wsProbes = await Promise.all(cfg.wsUrls.map((url) => testWs(url)));
      const wsProviders = wsProbes.filter((p): p is ethers.WebSocketProvider => !!p);

      if (httpProviders.length === 0 && wsProviders.length === 0) continue;

      this.providers.set(cfg.name, {
        config: cfg,
        httpProviders,
        wsProviders,
        httpIndex: 0,
        wsIndex: 0,
      });

      if (!this.primaryProviderName && cfg.role === "primary") {
        this.primaryProviderName = cfg.name;
      }

      console.log(
        `[RP] ${cfg.displayName} http=${cfg.httpUrls.map(mask).join(", ")} ws=${cfg.wsUrls.map(mask).join(", ")}`
      );

    }

    if (!this.primaryProviderName) {
      const primary = configs.find((cfg) => cfg.role === "primary") ?? configs[0];
      this.primaryProviderName = primary?.name ?? null;
    }
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  get provider(): ethers.JsonRpcProvider {
    const primary = this.primaryProviderName;
    if (primary) {
      const runtime = this.providers.get(primary);
      if (runtime && runtime.httpProviders.length > 0) {
        return runtime.httpProviders[runtime.httpIndex % runtime.httpProviders.length];
      }
    }

    const fallback = this.providers.values().next().value as ProviderRuntime | undefined;
    if (fallback && fallback.httpProviders.length > 0) {
      return fallback.httpProviders[fallback.httpIndex % fallback.httpProviders.length];
    }

    throw new Error("No HTTP providers available");
  }

  getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  async withProvider<T>(
    fn: (provider: ethers.JsonRpcProvider, context: ProviderExecutionContext) => Promise<T>,
    options: ProviderRequestOptions = {}
  ): Promise<T> {
    await this.ensureReady();
    const method = options.method ?? "custom";
    const params = options.params ?? [];
    return providerStrategy.executeWithBestProvider(
      method,
      params,
      async (providerName, context) => {
        const runtime = this.providers.get(providerName);
        if (!runtime || runtime.httpProviders.length === 0) {
          throw new Error(`Provider ${providerName} has no healthy HTTP endpoints`);
        }

        const tries = Math.max(1, options.maxProviderAttempts ?? Math.min(runtime.httpProviders.length, 3));
        let lastErr: unknown = null;

        for (let i = 0; i < tries; i++) {
          const idx = (runtime.httpIndex + i) % runtime.httpProviders.length;
          const provider = runtime.httpProviders[idx];
          try {
            const result = await fn(provider, context);
            runtime.httpIndex = idx;
            return result;
          } catch (err) {
            lastErr = err;
          }
        }

        runtime.httpIndex = (runtime.httpIndex + 1) % Math.max(1, runtime.httpProviders.length);
        throw lastErr ?? new Error(`All HTTP endpoints failed for provider ${providerName}`);
      },
      options
    );
  }

  async useProviderByName<T>(
    providerName: string,
    fn: (provider: ethers.JsonRpcProvider) => Promise<T>,
    options: ProviderRequestOptions = {}
  ): Promise<T> {
    await this.ensureReady();
    const runtime = this.providers.get(providerName);
    if (!runtime || runtime.httpProviders.length === 0) {
      throw new Error(`Provider ${providerName} not available`);
    }

    const tries = Math.max(1, options.maxProviderAttempts ?? Math.min(runtime.httpProviders.length, 3));
    let lastErr: unknown = null;

    for (let i = 0; i < tries; i++) {
      const idx = (runtime.httpIndex + i) % runtime.httpProviders.length;
      const provider = runtime.httpProviders[idx];
      try {
        const result = await fn(provider);
        runtime.httpIndex = idx;
        return result;
      } catch (err) {
        lastErr = err;
      }
    }

    runtime.httpIndex = (runtime.httpIndex + 1) % Math.max(1, runtime.httpProviders.length);
    throw lastErr ?? new Error(`All HTTP endpoints failed for provider ${providerName}`);
  }

  onNewHeads(handler: (blockNumber: number) => void): () => void {
    const wsCapable = Array.from(this.providers.values()).find((prov) => prov.wsProviders.length > 0);
    if (wsCapable) {
      const provider = wsCapable.wsProviders[wsCapable.wsIndex % wsCapable.wsProviders.length];
      const onBlock = (blockNumber: number) => {
        try {
          handler(Number(blockNumber));
        } catch {}
      };
      provider.on("block", onBlock);
      return () => {
        try {
          provider.off("block", onBlock);
        } catch {}
      };
    }

    let running = true;
    let last = -1;
    const interval = Math.max(1000, Number(process.env.HEAD_POLL_INTERVAL_MS ?? "1500"));

    const tick = async () => {
      if (!running) return;
      try {
        const bn = await this.withProvider((p) => p.getBlockNumber(), { method: "eth_blockNumber" });
        if (bn !== last) {
          last = bn;
          handler(Number(bn));
        }
      } catch {}
    };

    const timer = setInterval(tick, interval);
    tick().catch(() => {});
    return () => {
      running = false;
      clearInterval(timer);
    };
  }

  subscribeLogs(filter: LogFilter, handler: (log: ethers.Log) => void): () => void {
    const pollMs = Math.max(800, Number(filter.pollIntervalMs ?? process.env.LOG_POLL_INTERVAL_MS ?? "1500"));
    const fromLag = Math.max(0, Number(filter.fromBlockLag ?? 2));
    const addresses = (filter.addresses ?? []).map((addr) => ethers.getAddress(addr));
    const topics = filter.topics ?? [];
    let lastSeen = 0;
    let running = true;

    const tick = async () => {
      if (!running) return;
      try {
        const latest = await this.withProvider((p) => p.getBlockNumber(), { method: "eth_blockNumber" });
        let from = Math.max(0, latest - fromLag);
        if (lastSeen > 0 && from <= lastSeen) from = lastSeen + 1;
        if (from > latest) return;

        const logs = await this.withProvider(
          (provider) =>
            provider.getLogs({
              address: addresses.length === 0 ? undefined : addresses.length === 1 ? addresses[0] : addresses,
              topics,
              fromBlock: from,
              toBlock: latest,
            }),
          { method: "eth_getLogs" }
        );

        if (logs.length) {
          lastSeen = Number(logs[logs.length - 1].blockNumber);
        } else {
          lastSeen = latest;
        }

        for (const log of logs) {
          try {
            handler(log);
          } catch {}
        }
      } catch {}
    };

    const timer = setInterval(tick, pollMs);
    tick().catch(() => {});

    return () => {
      running = false;
      clearInterval(timer);
    };
  }
}

export const RP = new ResilientProviderManager();
