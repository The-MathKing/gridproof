#!/usr/bin/env bash
# Serve the dashboard against the Sepolia deployment (reads oracle/.env).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$ROOT/web/dist" ] || (cd "$ROOT/web" && npm run --silent build)
cd "$ROOT/oracle"
GRIDPROOF_NETWORK=sepolia exec .venv/bin/uvicorn gridproof.api:app --port "${PORT:-8000}" --log-level warning
