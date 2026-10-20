# GridProof ⚡

**Hour-by-hour clean energy certificates, checked by AI and recorded on a blockchain, so "100% renewable" has to be true every hour, not just on average over a year.**

**Track:** Renewable Energy & Energy Trading (renewable certificate tracking and tokenized incentives for clean energy), with a strong Carbon Markets & Emissions Transparency angle.

---

## The problem: "100% renewable" is usually an annual average

Today a company proves it uses renewable power by buying certificates (RECs in North America, Guarantees of Origin in Europe). Each one says "1 MWh of clean power was made somewhere this year."

That allows three loopholes:

1. **Timing.** A data centre that runs all night on gas-fired power can buy cheap certificates from sunny afternoons and still call itself 100% renewable. On paper the emissions are zero; in reality they aren't.
2. **Double counting.** The same megawatt-hour can be claimed twice: by the generator and the buyer, or in two registries that don't talk to each other.
3. **Unverified meter data.** Certificates are issued from self-reported meter readings that nobody checks against what the weather made physically possible.

Research on 24/7 carbon-free energy (for example Princeton ZERO Lab, and Google's 24/7 CFE work) finds that annual matching does little to cut real emissions, while **hourly matching** does. The industry is moving that way: EnergyTag's Granular Certificate standard, and the proposed GHG Protocol Scope 2 revision. But there is no open, tamper-evident system for issuing, checking and retiring certificates by the hour.

## The solution

GridProof issues one **Granular Certificate** for every hour of generation from every registered solar or wind device. Each certificate goes through five steps:

1. **Signed at the source.** Every device has its own key and signs each hourly meter reading.
2. **Checked by AI before it becomes a certificate.** An integrity model compares the reading with what that device *could* have produced given the real weather that hour (sunlight and wind speed from Open-Meteo) and its rated capacity. Readings that are physically implausible or statistically odd are held back and never minted.
3. **Minted on-chain at most once.** The smart contract turns each `(device, hour)` pair into exactly one token ID. A second mint for the same hour is rejected, so a certificate can't be issued twice.
4. **Retired by the hour.** A buyer matching their 9pm load can only use certificates from 9pm. Retiring a certificate burns it and records the beneficiary on-chain, so it can't be claimed twice.
5. **Scored honestly.** The dashboard puts the buyer's annual claim next to their real hourly match ("you claim 100%; your true hourly match is 61%"). It also works out their real emissions using the grid's carbon intensity for each hour.

An **AI forecaster** then turns transparency into action. It predicts the next 24 hours of grid carbon intensity and the expected certificate surplus, and recommends when to move flexible loads (EV charging, batch jobs, heat pumps) into the clean hours. **Tokenized incentives** reward buyers for shifting load into those surplus hours.

## Who uses it

| User | What they get |
|---|---|
| **Corporate buyer** (a data centre or university campus) | Can prove a real hourly clean-energy match and avoid greenwashing claims. Gets told when to shift load. |
| **Generator** (solar farm, community wind, rooftop prosumer) | Certificates from scarce hours (evenings, winter) are worth more, so storage and wind are rewarded and midday solar overbuild isn't. |
| **Auditor or regulator** | Every certificate can be traced on-chain to a device signature, a weather check, and a single retirement. |

## Architecture

```
  Open-Meteo weather ──┐                    ┌── UK Carbon Intensity API
  (sunlight, wind)     │                    │   (hourly gCO₂/kWh, actual + forecast)
                       ▼                    ▼
 ┌──────────── GridProof oracle (Python) ─────────────────┐
 │  devices: sign hourly readings (secp256k1 key each)    │
 │  integrity AI: physics model + IsolationForest         │
 │  forecaster: gradient boosting, next 24h intensity     │
 │  FastAPI: /devices /readings /forecast /buyers/:id     │
 └───────────────┬────────────────────────────────────────┘
                 │ mint(device, hour, Wh, deviceSig, verdict)
 ┌───────────────▼────────────────────────────────────────┐
 │  Solidity (Hardhat, EVM)                               │
 │  DeviceRegistry: device key, capacity, owner           │
 │  GranularCertificate (ERC-1155): one token ID per      │
 │    device-hour, mint at most once, hour-matched        │
 │    retire, on-chain retirement record                  │
 │  ShiftReward (ERC-20): incentive for load shifting     │
 └───────────────┬────────────────────────────────────────┘
                 │ ethers.js reads + wallet retire
 ┌───────────────▼────────────────────────────────────────┐
 │  Web dashboard: hourly match heatmap, annual vs        │
 │  hourly claim, emissions, flagged readings, forecast   │
 └────────────────────────────────────────────────────────┘
```

## Why use a blockchain here?

- **Single issuance and single retirement are enforced by code, not by trusting a registry.** The current double-counting problem comes from several registries that don't share state.
- **Public audit:** anyone can check that a certificate came from a signed reading that passed the AI check.
- **Programmable incentives:** load-shifting rewards pay out automatically when an hour-matched retirement happens.

## Security and trust

- Each device has its own signing key. The contract checks the device's signature, so a compromised oracle can't invent readings for a device.
- The AI check is a second line of defence against a compromised or tampered device. Its verdict and anomaly score are stored with each certificate.
- Only weather data and hourly totals go on-chain. No personal data does.

## Results (local run, 7 days ending Oct 20 2026, real UK weather and grid data)

**The headline: every buyer can claim "100% renewable" under annual-style accounting, but the real hourly match is 52–61%.**

| Buyer | Annual-style claim | Real hourly match |
|---|---|---|
| Southwark Data Centre (flat 24/7 load) | 100% | 61% |
| Bloomsbury University Campus (daytime load) | 100% | 60% |
| Walworth Electric Bus Depot (overnight charging) | 100% | 52% |

**AI integrity check** (60 days, 5,848 readings, 184 tampered with by the simulator):

| | |
|---|---|
| Fake energy blocked | 76% |
| False alarms on honest readings | 0.02% |
| Precision | 99% |
| Night-time solar / replayed readings caught | 100% / 100% |
| Tampered meter's quarantine rate vs honest devices | 4.7% vs under 1% |

Inflated readings that slip through stay inside the weather-uncertainty band, so the most fraud can gain is capped per hour. Device-level risk scores then point auditors at meters that keep sitting near that cap.

**Carbon forecaster** (day-ahead, last 7 days held out): mean error 22 gCO₂/kWh, versus 40 for "same as yesterday". NESO's own short-range forecast scores 10, but it uses live grid data over a shorter horizon, so the surplus-hour recommendation blends both.

Numbers change from run to run because the data is live.

## Honest limitations

- Meter readings are simulated, driven by real weather. A real deployment would read signed data from smart meters or inverters (many already support signed telemetry).
- The local demo runs on a Hardhat chain. The contracts are standard EVM, so they could be deployed to a public testnet or a low-fee L2.
- Certificates are only unique *within GridProof*. Ending cross-registry double counting needs existing registries to bridge in or out, which is a policy step, not a technical one.

## Repo layout

```
contracts/   Hardhat 3 project: Solidity contracts, 19 tests, deploy script
oracle/      Python: data fetchers, device simulator, integrity AI, forecaster, FastAPI, chain client
web/         Dashboard (Vite + React + ethers)
scripts/     demo.sh: one command runs the whole thing
```

## Running it locally

See [docs/RUNNING.md](docs/RUNNING.md).

## Data sources (free, no key)

- [UK Carbon Intensity API](https://carbonintensity.org.uk/) (National Grid ESO): regional half-hourly carbon intensity and generation mix
- [Open-Meteo](https://open-meteo.com/): hourly historical and forecast sunlight and wind speed
