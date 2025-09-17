import "dotenv/config";
import { ethers } from "ethers";

/** ---------- CLI parsing (no dependencies) ---------- */
export function readFlag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) {
      return argv[i + 1]; // may be undefined; caller should handle
    }
    if (a.startsWith(`--${name}=`)) {
      return a.split("=", 2)[1];
    }
  }
  return undefined;
}

/** ---------- Env & address helpers ---------- */
export function requireEnv(name: string): string {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export function optionalEnv(name: string): string | undefined {
  const v = (process.env[name] || "").trim();
  return v ? v : undefined;
}

/** Strict: require non-empty and a valid address */
export function toAddressStrict(value: string | undefined, label?: string): string {
  const v = (value || "").trim();
  if (!v) {
    const what = label ? label : "address";
    throw new Error(`Missing ${what}. Provide --${what} or set ${what.toUpperCase()} in .env`);
  }
  if (!ethers.isAddress(v)) {
    throw new Error(`Invalid ${label ?? "address"}: ${JSON.stringify(value)}`);
  }
  return ethers.getAddress(v);
}

/** Lenient: return null when not set/invalid */
export function toAddressLenient(value: string | undefined): string | null {
  const v = (value || "").trim();
  if (!v) return null;
  if (!ethers.isAddress(v)) return null;
  return ethers.getAddress(v);
}

/** Back-compat alias expected by some scripts */
export const toAddress = (v: string | undefined) => toAddressStrict(v);

/** Utility string helpers (for older scripts expecting them) */
export function asTrimmedString(v: unknown): string {
  return typeof v === "string" ? v.trim() : String(v ?? "").trim();
}
export function isHex40(v: unknown): boolean {
  const s = asTrimmedString(v);
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

/** Format BigInt with decimals safely */
export function formatUnitsSafe(value: bigint, decimals: number): string {
  // ethers v6 handles BigInt fine
  return ethers.formatUnits(value, decimals);
}

/** ---------- Provider & wallet ---------- */
export function makeProvider(): ethers.JsonRpcProvider {
  const url = requireEnv("ARB_RPC_URL");
  return new ethers.JsonRpcProvider(url, { name: "arbitrum", chainId: 42161 });
}

export function makeWallet(p?: ethers.JsonRpcProvider): ethers.Wallet {
  const pk = requireEnv("PRIVATE_KEY");
  return new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, p ?? makeProvider());
}

/** ---------- Tokens map from .env (symbols -> addresses) ---------- */
export function buildTokenMap(): Record<string, string> {
  const m: Record<string, string> = {};
  const add = (sym: string, envName: string) => {
    const v = optionalEnv(envName);
    if (v && ethers.isAddress(v)) m[sym.toUpperCase()] = ethers.getAddress(v);
  };
  add("WETH", "WETH");
  add("ARB", "ARB");
  add("USDC", "USDC");
  add("USDCE", "USDCe"); // alias
  return m;
}

/** Lowercase-keyed tokens map for back-compat (TOKENS_LC) */
export const TOKENS_LC: Record<string, string> = (() => {
  const upper = buildTokenMap();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(upper)) out[k.toLowerCase()] = v;
  return out;
})();

/**
 * Resolve either a symbol ("ARB","WETH") or a raw address.
 * Accepts unknown to avoid strict-narrowing to `never`.
 */
export function resolveTokenOrAddress(
  input: unknown,
  tokenMap: Record<string, string>,
  label = "token"
): string {
  const s: string = typeof input === "string" ? input.trim() : String(input ?? "").trim();
  if (!s) throw new Error(`Empty ${label} entry`);
  if (ethers.isAddress(s)) return ethers.getAddress(s);

  // force string ops to avoid 'never' complaints
  const k: string = (s + "").toUpperCase();
  const addr = tokenMap[k] ?? TOKENS_LC[k.toLowerCase()];
  if (!addr) {
    throw new Error(`Unknown ${label} symbol "${s}". Add ${k}=0x... to .env or pass a full address.`);
  }
  return addr;
}

/** Minimal ERC20 ABI */
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;
