import { setTimeout as delay } from "timers/promises";
import { RP } from "./resilientProvider";
import type { ProviderRequestOptions } from "./providerStrategy";

const DEFAULT_RETRIES = Number(process.env.RPC_RETRIES ?? "3");
const DEFAULT_BASE_MS = Number(process.env.RPC_BACKOFF_BASE_MS ?? "120");
const DEFAULT_MAX_MS = Number(process.env.RPC_BACKOFF_MAX_MS ?? "1200");
const DEFAULT_JITTER = Number(process.env.RPC_BACKOFF_JITTER ?? "0.25");

export function isRateLimit(err: unknown): boolean {
  const code = (err as any)?.info?.error?.code ?? (err as any)?.code;
  const message = String((err as any)?.shortMessage ?? (err as any)?.message ?? "").toLowerCase();
  return (
    code === 429 ||
    message.includes("rate") ||
    message.includes("capacity") ||
    message.includes("compute units") ||
    message.includes("exceeded") ||
    message.includes("slow down")
  );
}

export interface RpcCallOptions extends ProviderRequestOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
}

function computeBackoff(attempt: number, options: RpcCallOptions): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_MS;
  const jitter = options.jitter ?? DEFAULT_JITTER;
  const exp = Math.min(max, base * 2 ** attempt);
  const delta = exp * jitter;
  const min = Math.max(0, exp - delta);
  const maxDelay = exp + delta;
  return Math.floor(Math.random() * (maxDelay - min + 1) + min);
}

export async function callRpc<T = unknown>(
  method: string,
  params: unknown[] = [],
  options: RpcCallOptions = {}
): Promise<T> {
  let attempt = 0;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_RETRIES);
  let lastError: unknown = null;

  while (attempt <= maxRetries) {
    try {
      return await RP.withProvider(
        (provider) => provider.send(method, params),
        { ...options, method, params }
      );
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isRateLimit(err)) {
        break;
      }
      const wait = computeBackoff(attempt, options);
      await delay(wait);
      attempt += 1;
    }
  }

  throw lastError ?? new Error(`RPC ${method} failed`);
}

export async function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  options: RpcCallOptions = {}
): Promise<T> {
  let attempt = 0;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_RETRIES);
  let lastError: unknown = null;

  while (attempt <= maxRetries) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isRateLimit(err)) {
        break;
      }
      const wait = computeBackoff(attempt, options);
      await delay(wait);
      attempt += 1;
    }
  }

  throw lastError ?? new Error(`${label} failed after ${maxRetries + 1} attempts`);
}
