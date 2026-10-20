#!/usr/bin/env bash
# Publish the contracts' source code on Etherscan (Sepolia), using deployments/sepolia.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEP="$ROOT/deployments/sepolia.json"
read -r ADMIN REG REW GC < <(python3 -c "
import json; d=json.load(open('$DEP')); c=d['contracts']
print(d['admin'], c['DeviceRegistry']['address'], c['ShiftReward']['address'], c['GranularCertificate']['address'])")
cd "$ROOT/contracts"
npx hardhat verify --network sepolia "$REG" "$ADMIN"
npx hardhat verify --network sepolia "$REW" "$ADMIN"
npx hardhat verify --network sepolia "$GC" "$ADMIN" "$REG" "$REW"
