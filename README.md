# Arbitrum MEV Starter (Uniswap v3 + Universal Router + Liquidations + EV Dashboard)

Minimal, ethical MEV searcher for **Arbitrum One**, with:
- **Solidity router** (owner-only, minProfit enforcement)
- **TypeScript searcher** for Uniswap v3 cross-tier arbs using **SwapRouter02**
- **Universal Router** helper for single-path multi-hop calldata (e.g., liquidations)
- **Liquidation hooks** (Aave v3 / Radiant) – execution wiring
- **Gas→USDC estimator** via Uniswap v3 quotes
- **EV dashboard** (tiny HTTP server + Chart.js UI)
- **Watcher skeleton** (Aave/Radiant health factor polling stubs)

> Educational starter. Focuses on parity-restoring arbs & liquidations; **no sandwiches**.

## Quick Start
```bash
pnpm i
cp .env.example .env   # fill ARB_RPC_URL, PRIVATE_KEY
npx hardhat compile
npx hardhat run scripts/deploy.ts --network arbitrum
# put ROUTER_ADDRESS into .env
# approve USDC to SwapRouter02 from router (see README Approvals)
npx ts-node src/searcher/index.ts   # DRY_RUN=true by default
```

### Useful scripts
```bash
pnpm run dashboard   # starts EV dashboard at http://localhost:8787
```

### Addresses (Arbitrum One) – verify before use
- **USDC (native):** `0xAf88d065E77C8Ccc2239327C5EDb3A432268e5831`
- **WETH9:** `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`
- **Uniswap v3 QuoterV2:** `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`
- **Uniswap v3 SwapRouter02:** `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`

**Reference pools (for monitoring):**
- USDC/WETH 0.05%: `0xC31e54c7A869B9fCBeCc14363cF510D1c41FA443`
- USDC/WETH 0.30%: `0xC473E2AeE3441bF9240BE85Eb122aBb059A3B57C`

> Universal Router address varies by chain/version. Set `UNIVERSAL_ROUTER` in `.env` when you plan to use it.

## Approvals (one-time from owner)
- Fund the router with some **USDC** (send to router address).
- `approveToken(USDC, SwapRouter02, MAX)` on the router.
- If using Universal Router or liquidations, also approve UR and any collateral tokens to be spent by UR.

## EV Dashboard
```bash
pnpm run dashboard
# open http://localhost:8787
```
It reads `data/metrics.json` that the searcher updates per block/trade, and charts EV over time.

## Watcher Skeleton
`src/searcher/watcher.ts` includes minimal polling stubs for Aave/Radiant **health factor**. You’ll need to provide data provider addresses and user lists to watch.

**Safety:** start on Arbitrum Sepolia, with small notionals and DRY_RUN enabled. Add circuit breakers.
