import fs from "fs";
import path from "path";
import JSON5 from "json5";

type Limiter = { max: number; persistent?: boolean; statePath?: string };
type Cfg = {
  send?: string;
  minProfit?: string | number;
  notional?: Record<string, string | number>;
  hotTxLimiter?: Limiter;
  [k: string]: any;
};

function argvValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const MIN_PROFIT = argvValue("--minProfit") ?? "0.0002";
const NOTIONAL_ARB = argvValue("--notionalARB") ?? "0.005";
const ENSURE_LIMITER = process.argv.includes("--ensureLimiter");

const file = path.resolve("watcher.config.json");
const raw = fs.readFileSync(file, "utf8");

// Parse tolerantly (comments / trailing commas OK)
let cfg: Cfg;
try {
  cfg = JSON5.parse(raw);
} catch (e: any) {
  console.error("Could not parse watcher.config.json. Error:\n", e?.message ?? e);
  process.exit(1);
}

// Apply changes
cfg.minProfit = String(MIN_PROFIT);
cfg.notional = { ...(cfg.notional ?? {}), ARB: String(NOTIONAL_ARB) };

// Ensure limiter is fully initialized with correct typing
function ensureLimiter(cur: unknown): Limiter {
  const src = (cur ?? {}) as Partial<Limiter>;
  return {
    max: 1,
    persistent: src.persistent ?? true,
    statePath: src.statePath ?? ".state/hot_tx_counter.json",
  };
}

if (ENSURE_LIMITER || !cfg.hotTxLimiter) {
  cfg.hotTxLimiter = ensureLimiter(cfg.hotTxLimiter);
}

// Backup and write strict JSON
const bak = file + ".bak";
fs.writeFileSync(bak, raw, "utf8");
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");

console.log("✅ watcher.config.json normalized and updated.");
console.log("   Backup saved at:", bak);
console.log("   minProfit:", cfg.minProfit);
console.log("   notional.ARB:", cfg.notional?.ARB);
console.log("   hotTxLimiter:", cfg.hotTxLimiter);
