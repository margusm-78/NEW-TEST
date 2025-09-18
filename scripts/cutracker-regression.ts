import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cu-tracker-test-"));
  const originalCwd = process.cwd();
  process.chdir(tmp);

  const originalWriteFile = fs.promises.writeFile;
  (fs.promises as any).writeFile = async (...args: any[]) => {
    await delay(50);
    return (originalWriteFile as any).apply(fs.promises, args);
  };

  try {
    const tracker = await import("../src/searcher/cuTracker");

    tracker.resetAll();
    await tracker.waitForIdle();

    tracker.recordUsage(1);
    const firstFlush = tracker.flushNow();

    await delay(10);
    tracker.recordUsage(1);

    await firstFlush;
    await tracker.waitForIdle();

    const json = JSON.parse(fs.readFileSync(tracker.COUNTERS_FILE, "utf-8"));
    assert.strictEqual(json.usage, 2, "usage should include both increments");
    console.log("cuTracker regression passed");
  } finally {
    (fs.promises as any).writeFile = originalWriteFile;
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
