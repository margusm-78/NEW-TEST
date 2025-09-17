// src/searcher/limit/hotTxLimiter.ts
import fs from "fs";
import path from "path";

/**
 * Simple hot-TX limiter.
 * - HOT_TX_MAX=3 limits to 3 sends (0 or negative => unlimited)
 * - HOT_TX_PERSIST=true writes count to HOT_TX_STATE_PATH (default .state/hot_tx_counter.json)
 *   so a restart won't reset the counter.
 */

const MAX = Number(process.env.HOT_TX_MAX ?? "0"); // 0 => unlimited
const PERSIST = (process.env.HOT_TX_PERSIST ?? "false").toLowerCase() === "true";
const STATE_PATH = process.env.HOT_TX_STATE_PATH ?? path.join(process.cwd(), ".state", "hot_tx_counter.json");

let count = 0;

function ensureDir(p: string) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  if (!PERSIST) return;
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, "utf-8");
      const j = JSON.parse(raw);
      if (typeof j.count === "number") count = j.count;
    }
  } catch { /* ignore */ }
}

function save() {
  if (!PERSIST) return;
  try {
    ensureDir(STATE_PATH);
    fs.writeFileSync(STATE_PATH, JSON.stringify({ count, max: MAX, ts: Date.now() }, null, 2), "utf-8");
  } catch { /* ignore */ }
}

export function initHotTxLimiter() {
  load();
}

export function canSend(): boolean {
  if (MAX <= 0) return true;
  return count < MAX;
}

export function recordSend() {
  count++;
  save();
}

export function remaining(): number {
  if (MAX <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, MAX - count);
}

export function currentCount(): number { return count; }
export function currentMax(): number { return MAX; }

export function describeLimiter() {
  return {
    max: MAX,
    persistent: PERSIST,
    statePath: PERSIST ? STATE_PATH : "(none)",
    used: count,
    remaining: remaining(),
  };
}
