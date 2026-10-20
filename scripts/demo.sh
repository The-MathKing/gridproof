#!/usr/bin/env bash
# One command: fresh local chain -> deploy -> AI oracle pipeline -> API (serves the dashboard).
# Ctrl+C stops everything.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAYS="${DAYS:-7}"

cleanup() { kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT

echo "▶ starting local blockchain"
(cd "$ROOT/contracts" && npx hardhat node > "$ROOT/.node.log" 2>&1) &
until curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' http://127.0.0.1:8545 >/dev/null; do sleep 0.5; done

echo "▶ deploying contracts"
(cd "$ROOT/contracts" && npm run --silent deploy:local)

echo "▶ running the oracle pipeline ($DAYS days)"
(cd "$ROOT/oracle" && PYTHONPATH=. .venv/bin/python -m gridproof.pipeline --days "$DAYS" > "$ROOT/.pipeline.log")
grep -E '^[0-9]/6' "$ROOT/.pipeline.log" || true

if [ ! -d "$ROOT/web/dist" ]; then
  echo "▶ building dashboard"
  (cd "$ROOT/web" && npm run --silent build)
fi

echo "▶ GridProof is running at http://localhost:8000"
cd "$ROOT/oracle" && .venv/bin/uvicorn gridproof.api:app --port 8000 --log-level warning
