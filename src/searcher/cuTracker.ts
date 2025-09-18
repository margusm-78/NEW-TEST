import fs from "fs";
import path from "path";

export type CuCounters = {
  usage: number;
  cacheHits: number;
};

const DATA_DIR = path.join(process.cwd(), "data");
export const COUNTERS_FILE = path.join(DATA_DIR, "cu-tracker.json");
const PERSIST_DELAY_MS = 25;

function readInitial(): CuCounters {
  if (!fs.existsSync(COUNTERS_FILE)) return { usage: 0, cacheHits: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(COUNTERS_FILE, "utf-8"));
    const usage = typeof raw.usage === "number" ? raw.usage : 0;
    const cacheHits = typeof raw.cacheHits === "number" ? raw.cacheHits : 0;
    return { usage, cacheHits };
  } catch {
    return { usage: 0, cacheHits: 0 };
  }
}

let counters: CuCounters = readInitial();
let dirty = false;
let pendingTimer: NodeJS.Timeout | null = null;
let flushPromise: Promise<void> | null = null;

function markDirty() {
  dirty = true;
}

async function persistOnce(snapshot: string) {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(COUNTERS_FILE, snapshot);
}

function startFlush(): Promise<void> {
  if (flushPromise) return flushPromise;
  if (!dirty) return Promise.resolve();

  const run = (async () => {
    try {
      do {
        dirty = false;
        const snapshot = JSON.stringify(counters, null, 2);
        await persistOnce(snapshot);
      } while (dirty);
    } finally {
      flushPromise = null;
      if (dirty) schedulePersist(true);
    }
  })();

  flushPromise = run;
  return run;
}

function schedulePersist(immediate = false): Promise<void> {
  if (flushPromise) {
    dirty = true;
    return flushPromise;
  }

  if (!dirty) {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    return Promise.resolve();
  }

  if (immediate) {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    return startFlush();
  }

  if (pendingTimer) return Promise.resolve();

  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (!dirty) return;
    startFlush();
  }, PERSIST_DELAY_MS);

  return Promise.resolve();
}

export function recordUsage(units = 1) {
  counters.usage += units;
  markDirty();
  schedulePersist();
}

export function recordCacheHit(count = 1) {
  counters.cacheHits += count;
  markDirty();
  schedulePersist();
}

export function resetUsage() {
  if (counters.usage === 0) return;
  counters.usage = 0;
  markDirty();
  schedulePersist(true);
}

export function resetCacheHits() {
  if (counters.cacheHits === 0) return;
  counters.cacheHits = 0;
  markDirty();
  schedulePersist(true);
}

export function resetAll() {
  counters = { usage: 0, cacheHits: 0 };
  markDirty();
  schedulePersist(true);
}

export function currentCounters(): CuCounters {
  return { ...counters };
}

export async function flushNow(): Promise<void> {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  await schedulePersist(true);
}

export async function waitForIdle(): Promise<void> {
  if (pendingTimer) {
    await new Promise((resolve) => setTimeout(resolve, PERSIST_DELAY_MS + 5));
    return waitForIdle();
  }
  if (flushPromise) {
    try {
      await flushPromise;
    } finally {
      if (dirty || pendingTimer) {
        return waitForIdle();
      }
    }
  }
}
