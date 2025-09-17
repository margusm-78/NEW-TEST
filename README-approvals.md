# Approvals Kit (Arbitrum, Ethers v6) — v3 (TS fix)

**This version fixes `TS2339: Property 'toUpperCase' does not exist on type 'never'`**
by adding a type predicate (`isNonEmptyString`) and explicit `string[]` typing for the token list.

## Usage

See scripts in `scripts/` and ensure `.env` has:
```
ARB_RPC_URL=...
PRIVATE_KEY=0x...
ROUTER_ADDRESS=0x...
```

Run:
```
npx ts-node scripts/erc20-approve.ts
npx ts-node scripts/erc20-allowance.ts
npx ts-node scripts/erc20-revoke.ts --token WETH
```
