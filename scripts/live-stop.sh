#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PID_FILE=".state/watcher.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "ℹ️  No PID file at $PID_FILE — watcher not running?"
  exit 0
fi

PID="$(cat "$PID_FILE" || true)"
if [[ -z "${PID// }" ]]; then
  echo "ℹ️  PID file empty — removing."
  rm -f "$PID_FILE"
  exit 0
fi

if ps -p "$PID" >/dev/null 2>&1; then
  echo "⏹  Stopping watcher PID=$PID…"
  kill "$PID" || true
  # wait up to 10s for graceful exit
  for _ in {1..10}; do
    if ps -p "$PID" >/dev/null 2>&1; then sleep 1; else break; fi
  done
  if ps -p "$PID" >/dev/null 2>&1; then
    echo "⚠️  Still running, sending SIGKILL"
    kill -9 "$PID" || true
  fi
else
  echo "ℹ️  No process with PID=$PID — cleaning up."
fi

rm -f "$PID_FILE"
echo "✅ watcher stopped."
