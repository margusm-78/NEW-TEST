# Compute Unit Throttling System

This guide describes the CU-aware throttling stack that ships with the searcher. The system keeps Alchemy usage under **1,000,000 CU/day** while orchestrating automatic fallback across QuickNode, Llama and Infura endpoints.

## Overview

| Component | Purpose |
|-----------|---------|
| [`cuTracker.ts`](../src/searcher/cuTracker.ts) | Persists per-provider CU usage, cache savings and request counts. |
| [`providerStrategy.ts`](../src/searcher/providerStrategy.ts) | Chooses the best provider based on capacity, cost and emergency posture. |
| [`resilientProvider.ts`](../src/searcher/resilientProvider.ts) | Boots providers, rotates endpoints and feeds metrics into the strategy. |
| [`cuMonitor.ts`](../src/searcher/cuMonitor.ts) | Collects live metrics, exposes CLI dashboards and manages emergency toggles. |
| [`rpc.ts`](../src/searcher/rpc.ts) | Smart retry helper that understands CU-aware rotation. |
| [`scripts/cu-status.ts`](../scripts/cu-status.ts) | Real-time CU status dashboard with watch and emergency controls. |
| [`scripts/cu-optimize.ts`](../scripts/cu-optimize.ts) | Generates recommendations, detailed analysis and config exports. |

## Provider Topology

```
Alchemy (1M CU/day) → QuickNode (500K) → Llama (300K) → Infura (100K backup)
```

- **Alchemy** is treated as the primary provider and is pinned as the default for signer operations.
- **QuickNode** and **Llama** share secondary traffic when Alchemy approaches limits or fails probes.
- **Infura** is marked `emergencyOnly` and is automatically used when emergency mode is active.

## Installation Checklist

1. Copy `.env.example` to `.env` and fill in your API keys.
2. Run `npm install` (or `pnpm install`) if you have not already.
3. Start the searcher with `npm run searcher` – the CU stack boots automatically.
4. Monitor usage at any time with:
   ```bash
   npx ts-node scripts/cu-status.ts --watch
   ```

## Key Features

### Method-Specific CU Tracking

`cuTracker` estimates CU consumption per RPC method (`eth_call`, `eth_getLogs`, `debug_traceTransaction`, etc.), storing daily and monthly totals. Percent thresholds are configurable via the environment and persisted to `cache/cu-usage.json` to survive restarts.

### Intelligent Provider Strategy

The strategy keeps the provider pool healthy by:
- Preferring providers with the highest remaining CU capacity (`capacity_based` mode).
- Falling back to cheaper nodes when overall usage is low (`cost_optimized`).
- Enforcing round-robin or emergency-only routing when requested via the CLI or `.env`.
- Applying endpoint-level cooldowns when repeated failures are detected.

### Emergency Response

Emergency mode is engaged when any of the following happens:
- A provider exceeds `EMERGENCY_DAILY_THRESHOLD` or `EMERGENCY_MONTHLY_THRESHOLD`.
- Two or more providers enter `alert`/`emergency` status.
- Manual activation through the CLI (`--emergency on`).

While active, cache TTL doubles, recommended scan concurrency is halved, and traffic is shifted away from the primary endpoint to preserve quota.

### CU-Aware RPC Retries

`rpc.ts` wraps provider execution with jittered exponential backoff that only retries on rate-limit style failures. Providers are rotated automatically; successful calls record CU usage, while cache hits accumulate CU savings for later reporting.

## CLI Tools

### CU Status Dashboard

```bash
# One-shot summary
npx ts-node scripts/cu-status.ts

# Live updates every 20 seconds with detailed output
npx ts-node scripts/cu-status.ts --watch --interval 20 --detailed --trends

# Export JSON metrics for scripting
npx ts-node scripts/cu-status.ts --json

# Reset usage and force emergency mode
npx ts-node scripts/cu-status.ts --reset
npx ts-node scripts/cu-status.ts --emergency on
```

Sample output:

```
📊 CU Status Summary:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ alchemy     │ Daily: [🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜]  65.2%
⚠️ quicknode   │ Daily: [🟨🟨🟨🟨🟨🟨🟨🟨⬜⬜]  82.1%
✅ llama       │ Daily: [🟩🟩🟩⬜⬜⬜⬜⬜⬜⬜]  34.5%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 Total Usage: 547,832 CU today, 8,234,123 CU this month
🛡️ Emergency mode inactive
```

### Optimization Utility

```bash
# Recommendations based on current usage
npx ts-node scripts/cu-optimize.ts recommend

# Deep dive into provider metrics
npx ts-node scripts/cu-optimize.ts analyze

# Force emergency posture immediately
npx ts-node scripts/cu-optimize.ts apply-emergency

# Generate a tuned .env snippet
npx ts-node scripts/cu-optimize.ts export-config
```

The optimizer inspects cache hit rates, CU headroom and emergency thresholds to suggest TTL tweaks, provider strategy adjustments and emergency guardrails.

## Configuration Reference

All relevant environment variables are documented in [`.env.example`](../.env.example). Important knobs include:

- **CU limits**: `DAILY_CU_LIMIT`, `MONTHLY_CU_LIMIT`, `CU_ALERT_THRESHOLD`, `CU_EMERGENCY_THRESHOLD`.
- **Per-provider quotas**: `ALCHEMY_DAILY_LIMIT`, `QUICKNODE_DAILY_LIMIT`, etc.
- **Strategy mode**: `PROVIDER_STRATEGY=capacity_based|cost_optimized|round_robin|emergency`.
- **Caching**: `CACHE_TTL_SECONDS`, `CACHE_MAX_SIZE`, `ENABLE_AGGRESSIVE_CACHING`.
- **Emergency triggers**: `EMERGENCY_DAILY_THRESHOLD`, `EMERGENCY_PROVIDER_COUNT`.
- **Retry policy**: `RPC_RETRIES`, `RPC_BACKOFF_BASE_MS`, `RPC_BACKOFF_MAX_MS`.

## Integration Notes

- `RP.withProvider` now accepts an optional options object (`{ method, params, cacheable, ttlSeconds, allowNearLimit }`). All in-tree calls specify the RPC method so CU accounting is accurate.
- The default provider (`RP.provider`) still exposes an `ethers.JsonRpcProvider` for wallet binding, but requests are tracked individually via the strategy.
- Cache usage and emergency mode are exposed through `cuMonitor`, allowing bots to adapt runtime behaviour (e.g., reduce concurrent scans when `cuMonitor.getLatestMetrics()?.emergency.active` is `true`).

## Maintenance Tips

- Run `npx ts-node scripts/cu-optimize.ts analyze` weekly to review real CU savings.
- Lower `EMERGENCY_DAILY_THRESHOLD` during high-volatility events to pre-empt quota breaches.
- When adding new RPC-heavy code paths, wrap calls with `RP.withProvider` and set the proper `method` so usage is tracked automatically.

With these components in place, the searcher maintains high availability across four providers while keeping Alchemy usage comfortably below 1M CU per day.
