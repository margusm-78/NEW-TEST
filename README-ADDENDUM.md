# Backrunner Addendum (Arbitrum V3↔V2)

This patch adds a *workable* backrunner **opportunity scanner** plus a **preflight** that prints token balances, allowances, discovered pools, and dry‑run quotes.

## New scripts

```bash
pnpm ts-node src/searcher/preflightArb.ts
pnpm ts-node src/searcher/arbBackrun.ts
```

## .env additions

```ini
# --- Required ---
ARB_RPC_URL=
PRIVATE_KEY=

# --- Optional overrides (defaults are correct for Arbitrum One) ---
UNIV2_ROUTER_ARBITRUM=0xc873fEcbd354f5A56E00E710B90EF4201db2448d
UNIV3_QUOTER_ARBITRUM=0x61fFE014bA17989E743c5F6cB21bF9697530B21e
UNIV3_SWAPROUTER02_ARBITRUM=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
UNIV3_FACTORY_ARBITRUM=0x1F98431c8aD98523631AE4a59f267346ea31F984

# --- Tunables ---
MIN_PROFIT_USDC=2.5
PROBE_NOTIONAL_A=0.25
POLL_INTERVAL_MS=1200
DRY_RUN=true
```

## Notes

* Execution wiring is left as a single TODO in `arbBackrun.ts` to connect to your on‑chain router (e.g., `ArbiSearcherRouter.sol`) for *atomic* two‑leg swaps. The scanner logs attractive opportunities each block.
* Use `preflightArb.ts` to confirm balances, allowances (to **Camelot v2** and **Uniswap v3 SwapRouter02**), pool discovery and quotes before going live.
