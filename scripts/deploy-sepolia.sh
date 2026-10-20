#!/usr/bin/env bash
# Deploy the contracts to Sepolia with the wallet in oracle/.env (made by scripts/new-wallet.py).
# The key is passed to Hardhat through the environment of this one command only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/oracle/.env"
[ -f "$ENV_FILE" ] || { echo "No oracle/.env. Run: oracle/.venv/bin/python scripts/new-wallet.py"; exit 1; }

get() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
SEPOLIA_RPC_URL="$(get GRIDPROOF_RPC_URL)"
SEPOLIA_PRIVATE_KEY="$(get GRIDPROOF_PRIVATE_KEY)"
export SEPOLIA_RPC_URL SEPOLIA_PRIVATE_KEY
[ -n "$SEPOLIA_PRIVATE_KEY" ] || { echo "GRIDPROOF_PRIVATE_KEY is empty in oracle/.env"; exit 1; }

cd "$ROOT/contracts"
npx hardhat run scripts/deploy.ts --network sepolia
python3 -c "
import json; d=json.load(open('$ROOT/deployments/sepolia.json'))
for k,v in d['contracts'].items(): print(f'  {k:20} {d[\"explorer\"]}/address/{v[\"address\"]}')"
