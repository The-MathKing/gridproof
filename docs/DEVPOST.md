## Track

**Renewable Energy & Energy Trading**: renewable certificate tracking and tokenized incentives for clean energy. It also directly tackles the **Carbon Markets & Emissions Transparency** problem of double counting.

## Inspiration

"100% renewable" usually means *on average over a year*. Companies buy certificates (RECs, Guarantees of Origin) that each say "1 MWh of clean power was made somewhere, sometime this year." A data centre that runs all night on gas can buy cheap certificates from sunny afternoons and still claim zero emissions.

Research on 24/7 carbon-free energy (Princeton ZERO Lab, Google's 24/7 CFE work) shows that annual matching barely changes real emissions, while **hourly** matching does. The industry is moving there (EnergyTag's Granular Certificates, the proposed GHG Protocol Scope 2 revision), but there's no open, tamper-evident way to issue, check and retire certificates hour by hour. We built one.

## What it does

GridProof issues one **Granular Certificate** for every hour of generation from every registered solar or wind device:

1. **Signed at the source.** Each meter has its own key and signs every hourly reading.
2. **Checked by AI before it can become a certificate.** An integrity model compares the reading with what the device *could* have produced given that hour's real weather and its capacity. Implausible readings are **quarantined on-chain** for an auditor instead of being minted.
3. **Minted on-chain at most once.** Each `(device, hour)` pair is exactly one ERC-1155 token ID, so issuing the same hour twice is impossible.
4. **Retired by the hour.** A buyer's 9pm use can only be covered by 9pm certificates. Retiring burns the certificate and records the beneficiary, so it can't be claimed twice.
5. **Scored honestly.** The dashboard puts a buyer's annual-style claim next to their real hourly match, and computes real emissions from the grid's carbon intensity each hour.

A **day-ahead carbon forecaster** recommends when to shift flexible loads (EV charging, batch jobs, heat pumps) into the cleanest hours, and a **GSHIFT reward token** pays buyers for clean energy used in those surplus hours.

### Results (7 days, real UK weather and grid data, live on Sepolia)

| Buyer | Annual-style claim | Real hourly match |
|---|---|---|
| Data centre (24/7 load) | **100%** | **61%** |
| University campus (daytime) | **100%** | **60%** |
| Electric bus depot (overnight) | **100%** | **52%** |

AI integrity check, over 60 days and 5,848 readings with 184 tampered by the simulator: **76% of fake energy blocked**, **0.02% false alarms**, **99% precision**, and 100% of fake night-time solar and replayed readings caught. The tampered meter gets quarantined 5× as often as honest devices. Inflations that slip through stay inside the weather-uncertainty band, which caps how much fraud can gain per hour.

## Who it's for

- **Corporate buyers** (data centres, universities, transit fleets) who need to prove a real hourly clean-energy match and avoid greenwashing claims.
- **Generators** (solar farms, community wind, rooftop prosumers): scarce-hour certificates (evenings, winter) become more valuable, which rewards storage and wind instead of more midday solar.
- **Auditors and regulators**, who can trace every certificate to a device signature, a weather check and a single retirement.

## How we built it

- **Smart contracts (Solidity, Hardhat 3, OpenZeppelin):** `DeviceRegistry` (device keys, capacity, location), `GranularCertificate` (ERC-1155, one token per device-hour, ECDSA-verified meter signatures, capacity limit, quarantine with auditor release/reject, hour-matched retirement, per-hour ledger) and `ShiftReward` (ERC-20 incentive). Batch functions put a day of hourly data on-chain in a handful of transactions. 19 tests cover double issuing, forged and replayed signatures, quarantine, and hour matching.
- **AI oracle (Python, scikit-learn):** a physics model of solar and wind output with a "maximum plausible output" bound that allows for local weather uncertainty, plus an IsolationForest over per-reading features (including each device's own history), combined into an anomaly score that goes on-chain with each certificate. The carbon forecaster is a gradient-boosted model on wind and solar forecasts for the North Sea, Scotland, the Irish Sea and southern England, plus lagged intensity.
- **Data (free and open):** the NESO/National Grid UK Carbon Intensity API for hourly grid intensity, and Open-Meteo for historical and forecast weather.
- **Dashboard (React, Vite, ethers.js):** claim vs. reality, hourly match heatmaps, the AI audit queue (release/reject executes on-chain), the forecast, and a **Verify on-chain** page where the browser reads any certificate directly from the contract, with no trust in our servers.
- **Deployment:** Ethereum Sepolia testnet, with source verified on Etherscan and Sourcify.

## Challenges we ran into

- **False alarms vs. missed fraud.** Our first integrity check used a fixed tolerance. When we made the simulated meters realistic (a meter's local weather differs from the grid-cell forecast), false alarms jumped to 2.6%. A weather-aware "maximum plausible output" bound brought them down to 0.02%.
- **A false "replay" alarm** fired on a wind turbine legitimately running at full power two days in a row. We now ignore readings at capacity.
- **Annual vs. hourly framing.** With too little supply, both numbers were low and the story disappeared. We sized the generators so weekly supply covers weekly demand: that's exactly the case where annual accounting says 100% and the hourly truth doesn't.
- **Testnet realities:** load-balanced public RPCs report stale nonces, ethers overpays tips by about 100× on a quiet testnet, and Sepolia charges about 3.5× the gas the local chain measured, close to its per-transaction cap. We fixed all three: explicit nonces, base fee plus a small tip, and smaller batches.

## Accomplishments that we're proud of

- An end-to-end system, from weather to signed reading to AI check to on-chain certificate to hourly retirement to emissions, running on real public data and **live on Sepolia** with verified source.
- A measurable, honest result: **100% claimed vs. 52–61% real** hourly match.
- The integrity check's metrics are reported against labelled ground truth, including what it misses.

## What we learned

- Blockchain earns its place here for a specific reason: single issuance and single retirement across parties that don't share a database.
- Physics is a stronger fraud signal than generic anomaly detection. The learned model matters most for patterns physics can't see, like replays and devices that keep sitting just under the limit.
- When you only care which hours are cleanest, a forecast that ranks the hours well matters more than one that gets every value exactly right.

## What's next

- Read signed telemetry from real inverters and smart meters instead of simulated meters.
- Bridges in and out of existing registries (EnergyTag-compliant Granular Certificates), which is what fully ends cross-registry double counting.
- Deploy on a low-fee L2, where the same design costs fractions of a cent per device per day.
- Peer consensus: use neighbouring devices that see the same weather as a second integrity reference.

## Honest notes

Meter readings are simulated from real weather (with injected fraud we label to score the AI). Grid carbon intensity and weather are real. The contracts run on the Sepolia testnet.
