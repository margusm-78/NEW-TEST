import { ethers } from "ethers";

/**
 * Resilient provider manager for Arbitrum One (42161).
 * - Pins network to avoid "failed to detect network" issues.
 * - Probes multiple HTTP + WS endpoints and rotates on errors.
 * - Exposes ensureReady() to await bootstrap.
 * - Uses WS for heads (if available) and HTTP log polling as fallback.
 */

type LogFilter = {
  addresses?: string[];
  topics?: (string | null)[];
  pollIntervalMs?: number;
  fromBlockLag?: number; // N blocks behind "latest"
};

const ARB_NETWORK: ethers.Networkish = { name: "arbitrum", chainId: 42161 };

/* ---------------- env helpers ---------------- */

function envList(...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const v = (process.env[name] || "").trim();
    if (v) out.push(v);
  }
  return out;
}

function collectHttpUrls(): string[] {
  const keys = [
    "ARB_RPC_URL",
    "ARB_RPC_URL_PRIMARY",
    "ARB_RPC_URL_BACKUP_1",
    "ARB_RPC_URL_BACKUP_2",
    "ARB_RPC_URL_BACKUP_3",
    "ARB_RPC_URL_BACKUP_4",
    "ARB_RPC_URL_BACKUP_5",
    "ARB_RPC_URL_BACKUP_6",
    "ARB_RPC_URL_BACKUP_7",
    "ARB_RPC_URL_BACKUP_8",
    "ARB_RPC_URL_BACKUP_9",
    "ARB_RPC_URL_BACKUP_10",
  ];
  const vals = keys.flatMap((k) => envList(k));
  const dedup = Array.from(
    new Set(
      vals
        .map((u) => u.trim())
        .filter((u) => u.startsWith("http"))
        .map((u) => (u.endsWith("/") ? u.slice(0, -1) : u))
    )
  );
  return dedup;
}

function collectWsUrls(): string[] {
  const keys = [
    "ARB_WS_URL",
    "ARB_WS_URL_PRIMARY",
    "ARB_WS_URL_BACKUP_1",
    "ARB_WS_URL_BACKUP_2",
    "ARB_WS_URL_BACKUP_3",
    "ARB_WS_URL_BACKUP_4",
    "ARB_WS_URL_BACKUP_5",
  ];
  const vals = keys.flatMap((k) => envList(k));
  const dedup = Array.from(
    new Set(
      vals
        .map((u) => u.trim())
        .filter((u) => u.startsWith("ws"))
        .map((u) => (u.endsWith("/") ? u.slice(0, -1) : u))
    )
  );
  return dedup;
}

function maskKey(u: string): string {
  // mask 16+ char token-like substrings
  return u.replace(/[A-Za-z0-9_-]{16,}/g, "***");
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms);
    });
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function testHttp(url: string): Promise<ethers.JsonRpcProvider | null> {
  try {
    const p = new ethers.JsonRpcProvider(url, ARB_NETWORK);
    await withTimeout(p.getBlockNumber(), 2000);
    return p;
  } catch {
    return null;
  }
}

async function testWs(url: string): Promise<ethers.WebSocketProvider | null> {
  try {
    const p = new ethers.WebSocketProvider(url, ARB_NETWORK);
    await withTimeout(p.getBlockNumber(), 2500);
    return p;
  } catch {
    return null;
  }
}

class RPClass {
  private http: ethers.JsonRpcProvider[] = [];
  private ws: ethers.WebSocketProvider[] = [];
  private httpIdx = 0;

  private headPollTimer: NodeJS.Timeout | null = null;
  private _ready: Promise<void>;

  constructor() {
    this._ready = this.bootstrap();
  }

  private async bootstrap() {
    const httpUrls = collectHttpUrls();
    const wsUrls   = collectWsUrls();

    if (httpUrls.length === 0) throw new Error("No HTTP RPC URL set (.env ARB_RPC_URL*)");

    console.log("[RP] HTTP URLs:", httpUrls.map(maskKey).join(", "));
    if (wsUrls.length) console.log("[RP]  WS  URLs:", wsUrls.map(maskKey).join(", "));

    const httpProbes = await Promise.all(httpUrls.map(testHttp));
    this.http = httpProbes.filter((p): p is ethers.JsonRpcProvider => !!p);

    if (this.http.length === 0) {
      // keep the first (even if not probed as healthy) so the app can still attempt
      this.http = [new ethers.JsonRpcProvider(httpUrls[0], ARB_NETWORK)];
    }

    if (wsUrls.length) {
      const wsProbes = await Promise.all(wsUrls.map(testWs));
      this.ws = wsProbes.filter((p): p is ethers.WebSocketProvider => !!p);
    }
  }

  /** Await initial probing */
  async ensureReady(): Promise<void> {
    await this._ready;
  }

  get provider(): ethers.JsonRpcProvider {
    if (this.http.length === 0) {
      // last resort
      const dummy = new ethers.JsonRpcProvider("http://127.0.0.1:8545", ARB_NETWORK);
      this.http = [dummy];
    }
    return this.http[this.httpIdx % this.http.length];
  }

  /** Execute with rotation on error */
  async withProvider<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>, tries = 3): Promise<T> {
    let lastErr: any = null;
    for (let i = 0; i < Math.max(1, Math.min(tries, this.http.length || 1)); i++) {
      const p = this.provider;
      try {
        return await fn(p);
      } catch (e) {
        lastErr = e;
        this.httpIdx = (this.httpIdx + 1) % this.http.length;
      }
    }
    throw lastErr ?? new Error("withProvider failed");
  }

  /** New heads via WS (if available) or HTTP polling fallback */
  onNewHeads(handler: (blockNumber: number) => void): () => void {
    const wsProv = this.ws.length ? this.ws[0] : null;

    if (wsProv) {
      const onBlock = (bn: number) => {
        try { handler(Number(bn)); } catch {}
      };
      wsProv.on("block", onBlock);
      return () => { try { wsProv.off("block", onBlock); } catch {} };
    }

    let last = -1;
    const tick = async () => {
      try {
        const bn = await this.withProvider((p) => p.getBlockNumber());
        if (bn !== last) { last = bn; handler(bn); }
      } catch {}
    };
    this.headPollTimer = setInterval(tick, Number(process.env.POLL_INTERVAL_MS ?? "1500"));
    tick().catch(() => {});
    return () => { if (this.headPollTimer) { clearInterval(this.headPollTimer); this.headPollTimer = null; } };
  }

  /** Robust HTTP log polling */
  subscribeLogs(filter: LogFilter, handler: (log: ethers.Log) => void): () => void {
    const pollMs  = Math.max(800, Number(filter.pollIntervalMs ?? 1500));
    const fromLag = Math.max(0, Number(filter.fromBlockLag ?? 2));
    const addrs   = (filter.addresses ?? []).map(ethers.getAddress);
    const topics  = filter.topics ?? [];

    let lastSeen = 0;

    const tick = async () => {
      try {
        const latest = await this.withProvider((p) => p.getBlockNumber());
        let from = Math.max(0, latest - fromLag);
        if (lastSeen > 0 && from <= lastSeen) from = lastSeen + 1;
        if (from > latest) return;

        const logs = await this.withProvider((p) =>
          p.getLogs({
            address: addrs.length === 0 ? undefined : addrs.length === 1 ? addrs[0] : addrs,
            topics,
            fromBlock: from,
            toBlock: latest,
          })
        );

        if (logs.length) lastSeen = Number(logs[logs.length - 1].blockNumber);
        else lastSeen = latest;

        for (const lg of logs) { try { handler(lg); } catch {} }
      } catch {}
    };

    const t = setInterval(tick, pollMs);
    tick().catch(() => {});
    return () => clearInterval(t);
  }
}

export const RP = new RPClass();
