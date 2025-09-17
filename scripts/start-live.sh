#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV="${NODE_ENV:-production}"
export SEND_MODE="${SEND_MODE:-live}"

echo "NODE_ENV=$NODE_ENV"
echo "SEND_MODE=$SEND_MODE (expected 'live')"

# Give a quick .env peek for ROUTER_ADDRESS (length only)
if [ -f .env ]; then
  RA=$(grep -E '^ROUTER_ADDRESS=' .env | head -n1 | cut -d= -f2- | tr -d '' | tr -d '"' | tr -d "'")
  echo "ROUTER_ADDRESS len: ${#RA}"
fi

# Prefer a watcher script if present, else fallback to ts-node
if npm run | grep -qE '(^| )watcher'; then
  pnpm run watcher
elif npm run | grep -qE '(^| )start'; then
  pnpm start
else
  if [ -f "watcher.ts" ]; then
    ./node_modules/.bin/ts-node watcher.ts
  elif [ -f "dist/watcher.js" ]; then
    node dist/watcher.js
  else
    echo "Could not find a watcher entry. Try one of:"
    echo "  pnpm run watcher"
    echo "  pnpm start"
    echo "  ts-node watcher.ts"
    exit 1
  fi
fi
