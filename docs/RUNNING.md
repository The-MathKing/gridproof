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
cd contracts && npx hardhat test          # 19 contract tests
cd contracts && npx hardhat node          # local chain
cd contracts && npm run deploy:local      # deploy, writes deployments/localhost.json
cd oracle && PYTHONPATH=. .venv/bin/python -m gridproof.pipeline --days 7
cd oracle && .venv/bin/uvicorn gridproof.api:app --port 8000
cd web && npm run dev                     # dashboard with hot reload on :5173 (proxies /api to :8000)
```

Running the pipeline again on the same deployment is safe: it skips readings and retirements already on-chain.

## Deploying to the Sepolia testnet (for judges)

Everything that runs locally runs on Sepolia unchanged. One wallet plays every role: it deploys the contracts, runs the oracle, holds the demo devices' certificates as a community-energy supplier, and acts as auditor. Buyers never send transactions; the supplier retires certificates on their behalf.

### Quick path (no MetaMask, no keystore)

```bash
oracle/.venv/bin/python scripts/new-wallet.py
```

This creates a throwaway Sepolia wallet in `oracle/.env` (git-ignored, readable only by you) and prints its address. Paste the address into a faucet. Then:

```bash
./scripts/deploy-sepolia.sh
```
```bash
cd oracle && PYTHONPATH=. .venv/bin/python -m gridproof.pipeline --days 7
```
```bash
./scripts/serve-sepolia.sh
```

The last command serves the dashboard at http://localhost:8000 against the Sepolia contracts. `./scripts/demo.sh` always uses the local chain, even when `oracle/.env` is set up for Sepolia, and each network keeps its own results in `oracle/state/<network>/`.

The steps below do the same thing by hand with your own wallet.

### 1. Wallet and test ETH

- Create a **new** wallet used only for this project (in MetaMask: *Add account*). Never use a wallet that holds real funds.
- Get free Sepolia ETH from a faucet, for example Google Cloud's Web3 faucet (cloud.google.com/application/web3/faucet/ethereum/sepolia).
- **How much you need.** Gas on Sepolia runs about 3.5× the local chain: a 2-day oracle run measured **68M gas**, and batches are sized to stay well under Sepolia's ~16.7M per-transaction cap. On Oct 20 2026 the deploy plus a 2-day run cost under 0.001 ETH, because the base fee was close to zero. The deploy script pays the base fee plus a 0.01 gwei tip, not ethers' default 1 gwei, so a single 0.05 ETH faucet drip goes a long way. If you're short, use `--days 1`. The pipeline prints your balance before it starts, and if it runs out halfway you can top up and run it again: it skips everything already on-chain.

### 2. Deploy the contracts

The key goes into Hardhat's encrypted keystore, not into a file in the repo.

```bash
cd contracts
npx hardhat keystore set SEPOLIA_RPC_URL
```
```bash
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
```
```bash
npx hardhat run scripts/deploy.ts --network sepolia
```

For the RPC URL, use a free Alchemy or Infura Sepolia endpoint, or the public `https://ethereum-sepolia-rpc.publicnode.com`. Deploying writes `deployments/sepolia.json`. Commit it: it only holds public addresses and ABIs, and the dashboard needs it.

### 3. Run the oracle on Sepolia

```bash
cp oracle/.env.example oracle/.env
```

Fill in `GRIDPROOF_PRIVATE_KEY` with the **same** wallet's key. `oracle/.env` is git-ignored. Then:

```bash
cd oracle && PYTHONPATH=. .venv/bin/python -m gridproof.pipeline --days 2
```

On Sepolia, every transaction hash is printed as it confirms (each takes about 12 s, so a 2-day run takes a few minutes). The run ends with the total gas and fees.

### 4. Serve the dashboard against Sepolia

```bash
cd oracle && .venv/bin/uvicorn gridproof.api:app --port 8000
```

With `GRIDPROOF_NETWORK=sepolia` in `oracle/.env`, the API reads the Sepolia deployment. **Verify on-chain** then reads Sepolia directly through the public RPC and links each certificate, the certificate contract and the device registry on Etherscan. Without a private key the API is read-only, so the auditor buttons need the key.

### 5. (Optional) Publish the source code on Etherscan

Add `ETHERSCAN_API_KEY=<your key>` as a line in `oracle/.env` (or run `npx hardhat keystore set ETHERSCAN_API_KEY` in `contracts/`). Then:

```bash
./scripts/verify-sepolia.sh
```

This also publishes to Sourcify and Blockscout, which need no key.

The API key is free from etherscan.io. Verified source lets judges read the exact code behind each certificate.
