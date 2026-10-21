#!/usr/bin/env bash
# Publish the contracts' source code for the Sepolia deployment (deployments/sepolia.json)
# on Etherscan, Sourcify and Blockscout.
# The Etherscan API key is read from ETHERSCAN_API_KEY in oracle/.env (or the Hardhat keystore).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEP="$ROOT/deployments/sepolia.json"
ENV_FILE="$ROOT/oracle/.env"

get() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
SEPOLIA_RPC_URL="$(get GRIDPROOF_RPC_URL)"
KEY="$(get ETHERSCAN_API_KEY)"
export SEPOLIA_RPC_URL
# Verifying sends no transactions, but the Sepolia network config wants a key; reuse the wallet's.
SEPOLIA_PRIVATE_KEY="$(get GRIDPROOF_PRIVATE_KEY)"
export SEPOLIA_PRIVATE_KEY
if [ -n "$KEY" ]; then export ETHERSCAN_API_KEY="$KEY"; else echo "No ETHERSCAN_API_KEY in oracle/.env: Etherscan will be skipped or fail; Sourcify/Blockscout still run."; fi

read -r ADMIN REG REW GC < <(python3 -c "
import json; d=json.load(open('$DEP')); c=d['contracts']
print(d['admin'], c['DeviceRegistry']['address'], c['ShiftReward']['address'], c['GranularCertificate']['address'])")

cd "$ROOT/contracts"
npx hardhat verify --network sepolia "$REG" "$ADMIN" || true
npx hardhat verify --network sepolia "$REW" "$ADMIN" || true
npx hardhat verify --network sepolia "$GC" "$ADMIN" "$REG" "$REW" || true
