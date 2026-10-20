# Running GridProof locally

Needs Node 20+ and Python 3.11+. No API keys: both data sources are free and open.

## One-time setup

```bash
cd contracts && npm install && cd ..
cd web && npm install && npm run build && cd ..
python3 -m venv oracle/.venv && oracle/.venv/bin/pip install -r oracle/requirements.txt
```

## Run the whole demo

```bash
./scripts/demo.sh
```

This script:

1. starts a fresh local blockchain (Hardhat),
2. deploys `DeviceRegistry`, `GranularCertificate` and `ShiftReward`,
3. runs the oracle pipeline over the last 7 days, using real weather and real GB grid data:
   - simulates meters for 4 devices, including one with a tampered meter,
   - runs the AI integrity check on every reading,
   - signs each reading with the device's own key, then issues or quarantines it on-chain,
   - reports buyer load, allocates certificates hour by hour and retires them on-chain,
   - trains the day-ahead carbon forecaster,
4. serves the dashboard at **http://localhost:8000**.

Use `DAYS=14 ./scripts/demo.sh` for a longer window. A full 7-day run takes about 30 seconds after the first data download.

## Pieces on their own

```bash
cd contracts && npx hardhat test          # 16 contract tests
cd contracts && npx hardhat node          # local chain
cd contracts && npm run deploy:local      # deploy, writes deployments/localhost.json
cd oracle && PYTHONPATH=. .venv/bin/python -m gridproof.pipeline --days 7
cd oracle && .venv/bin/uvicorn gridproof.api:app --port 8000
cd web && npm run dev                     # dashboard with hot reload on :5173 (proxies /api to :8000)
```

The pipeline expects a fresh deployment: restart the node and redeploy before running it again.

## Deploying to a public testnet (for judges)

1. Make a **new** wallet only for this, and get free Sepolia test ETH from a faucet.
2. Store the secrets in Hardhat's encrypted keystore. They never go in the repo.
   ```bash
   cd contracts
   npx hardhat keystore set SEPOLIA_RPC_URL
   npx hardhat keystore set SEPOLIA_PRIVATE_KEY
   npx hardhat run scripts/deploy.ts --network sepolia
   ```
3. Point the oracle at it: `Chain(network="sepolia", rpc=<url>)`. On a public network, accounts aren't unlocked, so the oracle needs to sign transactions locally. That's the next code change to make before a testnet run.
