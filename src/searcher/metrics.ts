import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const METRICS_FILE = path.join(DATA_DIR, "metrics.json");

export type Metric = {
  ts: number;
  block: number;
  route: string;
  notionalUSDC: number;
  grossUSDC: number;
  evUSDC: number;
  gasUSDC: number;
  executed: boolean;
  txHash?: string;
  success?: boolean;
};

export function recordMetric(m: Metric) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  let arr: Metric[] = [];
  if (fs.existsSync(METRICS_FILE)) {
    try { arr = JSON.parse(fs.readFileSync(METRICS_FILE, "utf-8")); } catch {}
  }
  arr.push(m);
  fs.writeFileSync(METRICS_FILE, JSON.stringify(arr.slice(-2000), null, 2));
}

export function readMetrics(): Metric[] {
  if (!fs.existsSync(METRICS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(METRICS_FILE, "utf-8")); } catch { return []; }
}
