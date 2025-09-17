#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root (this file is in ./scripts/)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mkdir -p .logs .state

# Load .env if present
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Sanity: required env
need() {
  local k="$1"; local v="${!k-}"
  if [[ -z "${v// }" ]]; then
    echo "❌ Missing env: $k" >&2
    exit 1
  fi
}
need ARB_RPC_URL
need PRIVATE_KEY
need ROUTER_ADDRESS
need UNIV3_QUOTER_ARBITRUM

# Risk knobs (your .env already has these; printed for clarity)
echo "▶️  DRY_RUN=${DRY_RUN:-false} | HOT_TX_MAX=${HOT_TX_MAX:-1} | MIN_PROFIT_USDC=${MIN_PROFIT_USDC:-0.05}"

PID_FILE=".state/watcher.pid"
LOG_FILE=".logs/watcher.$(date +%Y%m%d-%H%M%S).log"

# Prevent duplicates
if [[ -f "$PID_FILE" ]]; then
  if ps -p "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    echo "❌ watcher already running with PID $(cat "$PID_FILE")"
    echo "   Use scripts/live-stop.sh first."
    exit 1
  else
    rm -f "$PID_FILE"
  fi
fi

echo "▶️  Starting watcher in LIVE mode…"
echo "   Logs -> $LOG_FILE"
nohup env SEND_MODE=live pnpm run watcher >>"$LOG_FILE" 2>&1 &

PID="$!"
echo "$PID" > "$PID_FILE"
echo "✅ watcher started. PID=$PID"
echo "   Follow logs: tail -f $LOG_FILE"
