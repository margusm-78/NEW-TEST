# Live Run Checklist (Arbitrum, MEV bot)

Use these steps to go from simulation to live submissions safely.

## 1) Environment

`.env` must include:
```
ARB_RPC_URL=https://arbitrum-mainnet.infura.io/v3/<PROJECT_ID>
PRIVATE_KEY=0x<YOUR_BURNER_PRIVATE_KEY>
ROUTER_ADDRESS=0x<YOUR_DEPLOYED_ROUTER>
```

## 2) Approvals

Grant router allowances for tokens that may be received/spent mid-tx:
```
npx ts-node scripts/erc20-approve.ts --tokens WETH,ARB
npx ts-node scripts/erc20-allowance.ts --tokens WETH,ARB
```
Expect `Allowance: MAX_UINT256` (or your chosen cap).

## 3) Preflight checks (run every time before flipping live)

```
npx ts-node scripts/preflight-checks.ts --tokens WETH,ARB --min-eth 0.002 --require-max
```
This verifies:
- RPC connectivity & Arbitrum chainId (42161)
- Wallet address and ETH balance (>= 0.002 suggested)
- Code present at `ROUTER_ADDRESS`
- Token contract code present
- Current allowances owner->router

If any item fails, fix it and re-run the preflight.

## 4) Flip to LIVE

Set your send flag to live. You can do this via env var or your watcher config.
- **Env:** `SEND_MODE=live`
- **Config (example)** `watcher.config.json`:
```json
{
  "send": "live",
  "hotTxLimiter": { "max": 1, "persistent": true, "statePath": ".state/hot_tx_counter.json" },
  "minProfit": "0.0001",  // example; set per your strategy
  "notional": { "ARB": "0.01" }
}
```

## 5) Start the watcher

Try:
```
bash scripts/start-live.sh
```
This exports `SEND_MODE=live` and tries `pnpm run watcher`, `pnpm start`, or falls back to `ts-node watcher.ts`.

## 6) What logs to expect

- Simulation: `[send] (sim) would execute ...`
- **Live:** `[send] live tx submitted ...` and a tx hash.
- Hot limiter: `Remaining=` should decrement on each broadcast.

## 7) Rollback / safety

- To pause quickly, set `SEND_MODE=sim` or revert config `send: "sim"`.
- Reduce notional and increase `minProfit` if you see borderline arb traces.
- To stop: `Ctrl+C` or `pkill -f watcher`.

## 8) Troubleshooting

- **invalid address / ENS** → Our utils normalize and avoid ENS; check `.env` for stray quotes/spaces.
- **insufficient funds** → Add ETH on Arbitrum.
- **No code at ROUTER_ADDRESS** → Deploy your router and paste its address in `.env`.
- **Allowance too low** → Re-run `erc20-approve.ts` or `erc20-set-allowance.ts`.

Stay safe: use a burner bot wallet, keep approvals scoped to your router, and monitor gas.
