// src/searcher/backrunConfig.ts

export const CONFIG = {
  // Profit & scanning
  MIN_PROFIT_USDC: Number(process.env.MIN_PROFIT_USDC ?? "2.50"),
  PROBE_NOTIONAL_A: Number(process.env.PROBE_NOTIONAL_A ?? "0.25"),
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS ?? "1500"),
  SCAN_LATEST_ONLY: (process.env.SCAN_LATEST_ONLY ?? "true").toLowerCase() !== "false",

  // Execution
  DRY_RUN: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",

  // Hot-run limiter
  HOT_TX_MAX: Number(process.env.HOT_TX_MAX ?? "0"),
  HOT_TX_PERSIST: (process.env.HOT_TX_PERSIST ?? "false").toLowerCase() === "true",
  HOT_TX_STATE_PATH: process.env.HOT_TX_STATE_PATH ?? ".state/hot_tx_counter.json",
  ON_TX_LIMIT: (process.env.ON_TX_LIMIT ?? "exit").toLowerCase() as "exit" | "dry_run",

  // RPC retry/backoff
  RPC_RETRIES: Number(process.env.RPC_RETRIES ?? "3"),
  RPC_BACKOFF_BASE_MS: Number(process.env.RPC_BACKOFF_BASE_MS ?? "120"),
  RPC_BACKOFF_MAX_MS: Number(process.env.RPC_BACKOFF_MAX_MS ?? "1200"),
  RPC_BACKOFF_JITTER: Number(process.env.RPC_BACKOFF_JITTER ?? "0.25"),
} as const;
