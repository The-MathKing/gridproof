"""End-to-end run: weather -> meter readings -> AI integrity check -> on-chain
certificates -> hour-matched retirement -> emissions accounting -> forecast.

    python -m gridproof.pipeline --days 7

Writes everything the API and dashboard need to oracle/state/.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import data, integrity, simulator
from .chain import Chain
from .forecast import IntensityForecaster, surplus_hours

STATE = Path(__file__).resolve().parent.parent / "state"
HISTORY_DAYS = 60
BONUS_PER_KWH = 10**18  # 1 GSHIFT per kWh used in a surplus hour


def unix_hour(ts: pd.Timestamp) -> int:
    return int(ts.timestamp() // 3600)


def run(days: int, seed: int = 42) -> None:
    STATE.mkdir(exist_ok=True)
    rng = np.random.default_rng(seed)
    now = pd.Timestamp.now(tz="UTC").floor("h")
    window_start = now - pd.Timedelta(days=days)
    last_finished = now - pd.Timedelta(hours=1)

    # ---------------------------------------------------------------- readings + AI check
    print("1/6 weather and simulated meter readings")
    per_device = {}
    for d in simulator.DEVICES:
        wx = data.weather(d.lat, d.lon, past_days=HISTORY_DAYS, forecast_days=1)
        wx = wx[wx.index < last_finished]
        readings = simulator.simulate_readings(d, wx, rng)
        per_device[d.key] = (d, readings, integrity.features(readings, d.capacity_w, d.kind))

    print("2/6 training the integrity model")
    model = integrity.IntegrityModel().fit(pd.concat([X for _, _, X in per_device.values()]))
    scored = {}
    for key, (d, r, X) in per_device.items():
        s = model.score(X)
        df = pd.concat([r, s], axis=1)
        df["reasons"] = [integrity.reasons(s.loc[t], X.loc[t]) for t in df.index]
        scored[key] = df

    all_scored = pd.concat(scored.values())
    metrics = {"history": integrity.evaluate(all_scored)}
    metrics["window"] = integrity.evaluate(all_scored[all_scored.index >= window_start])

    # Device risk: how often a device sits near the top of the plausible band. Honest
    # devices rarely do; a meter that inflates "just enough" to slip under the per-hour
    # check does it constantly, which is a signal for an auditor.
    risk = {}
    for key, df in scored.items():
        d = per_device[key][0]
        producing = df[df["expected_wh"] > 0.05 * d.capacity_w]
        near_top = (producing["reported_wh"] > 0.8 * producing["max_plausible_wh"]).mean()
        risk[key] = {"near_top_share": float(near_top), "flagged_share": float((df["anomaly"] >= integrity.THRESHOLD).mean())}

    # ---------------------------------------------------------------- chain: devices + certificates
    print("3/6 registering devices and issuing certificates on-chain")
    chain = Chain()
    if chain.device_count() != 0:
        raise SystemExit("This deployment already has data. Restart the node and redeploy for a clean run.")
    for d, owner in zip(simulator.DEVICES, chain.owner_accounts):
        chain.register_device(owner, d.account.address, d.capacity_w, d.kind, d.lat, d.lon, d.name)
    chain.wait()
    device_ids = {d.key: i + 1 for i, d in enumerate(simulator.DEVICES)}
    owners = {d.key: chain.owner_accounts[i] for i, d in enumerate(simulator.DEVICES)}

    records = []
    for key, df in scored.items():
        d = per_device[key][0]
        dev_id = device_ids[key]
        for t, row in df[df.index >= window_start].iterrows():
            wh = int(row["reported_wh"])
            hour = unix_hour(t)
            rec = {
                "device": key,
                "time": t.isoformat(),
                "hour": hour,
                "token_id": str(chain.token_id(dev_id, hour)),
                "expected_wh": int(row["expected_wh"]),
                "max_plausible_wh": int(row["max_plausible_wh"]),
                "reported_wh": wh,
                "anomaly_bps": int(round(row["anomaly"] * 10000)),
                "reasons": row["reasons"],
                "fraud_label": row["fraud"],  # ground truth from the simulator, for scoring only
                "status": "none",
            }
            if wh > 0:
                sig = chain.sign_reading(d.account, dev_id, hour, wh)
                if rec["anomaly_bps"] >= integrity.THRESHOLD * 10000:
                    chain.quarantine(dev_id, hour, wh, rec["anomaly_bps"], sig)
                    rec["status"] = "quarantined"
                else:
                    chain.issue(dev_id, hour, wh, rec["anomaly_bps"], sig)
                    rec["status"] = "issued"
            records.append(rec)
    chain.wait()
    readings = pd.DataFrame(records)

    # ---------------------------------------------------------------- grid intensity + surplus hours
    print("4/6 grid carbon intensity and surplus hours")
    intensity = data.national_intensity(window_start.to_pydatetime() - timedelta(days=1), now.to_pydatetime())
    intensity = intensity[(intensity.index >= window_start) & (intensity.index < last_finished)]
    intensity["actual"] = intensity["actual"].fillna(intensity["neso_forecast"])
    surplus = set()
    for _, day in intensity.groupby(intensity.index.date):
        for t in surplus_hours(day["actual"]):
            surplus.add(unix_hour(t))
    for h in surplus:
        chain.set_surplus(h, BONUS_PER_KWH)

    # ---------------------------------------------------------------- buyers: load, hourly market, retirement
    print("5/6 buyer load, hourly matching and retirement")
    hours_index = pd.date_range(window_start, last_finished, freq="1h", inclusive="left", tz="UTC")
    loads = {b.key: simulator.buyer_load(b, hours_index, rng) for b in simulator.BUYERS}
    buyer_addr = {b.key: chain.buyer_accounts[i] for i, b in enumerate(simulator.BUYERS)}
    for b in simulator.BUYERS:
        for t, wh in loads[b.key].items():
            chain.report_load(buyer_addr[b.key], unix_hour(t), int(wh))

    issued = readings[readings["status"] == "issued"]
    for t in hours_index:
        h = unix_hour(t)
        supply = issued[issued["hour"] == h]
        demand = {b: int(loads[b].loc[t]) for b in loads}
        total_demand = sum(demand.values())
        if supply.empty or total_demand == 0:
            continue
        # Each device's certificates for this hour are shared out in proportion to load,
        # never more than a buyer needs in that hour.
        for _, cert in supply.iterrows():
            remaining = cert["reported_wh"]
            for b, need in demand.items():
                share = min(need, int(cert["reported_wh"] * need / total_demand), remaining)
                if share <= 0:
                    continue
                chain.transfer(owners[cert["device"]], buyer_addr[b], int(cert["token_id"]), share)
                chain.retire(buyer_addr[b], int(cert["token_id"]), share, buyer_addr[b])
                demand[b] -= share
                remaining -= share
    chain.wait()

    # ---------------------------------------------------------------- accounting from the chain
    buyers_out = []
    total_supply_wh = int(issued["reported_wh"].sum())
    total_load_all = sum(int(l.sum()) for l in loads.values())
    for b in simulator.BUYERS:
        addr = buyer_addr[b.key]
        rows = []
        for t in hours_index:
            h = unix_hour(t)
            load, matched = chain.matched(addr, h)
            ci = float(intensity["actual"].get(t, np.nan))
            unmatched_kwh = max(load - matched, 0) / 1000
            rows.append(
                {
                    "time": t.isoformat(),
                    "hour": h,
                    "load_wh": load,
                    "matched_wh": min(matched, load),
                    "intensity": None if np.isnan(ci) else ci,
                    "surplus": h in surplus,
                    "emissions_g": None if np.isnan(ci) else unmatched_kwh * ci,
                    "emissions_if_all_grid_g": None if np.isnan(ci) else load / 1000 * ci,
                }
            )
        hourly = pd.DataFrame(rows)
        load_sum = int(hourly["load_wh"].sum())
        # What an annual-style (volumetric) claim would report: certificates bought by
        # total volume from any hour, so any surplus elsewhere in the week counts.
        volumetric_wh = total_supply_wh * load_sum / total_load_all if total_load_all else 0
        buyers_out.append(
            {
                "key": b.key,
                "name": b.name,
                "address": addr,
                "profile": b.profile,
                "load_kwh": load_sum / 1000,
                "hourly_match": float(hourly["matched_wh"].sum() / load_sum) if load_sum else 0,
                "volumetric_claim": float(min(1.0, volumetric_wh / load_sum)) if load_sum else 0,
                "emissions_kg": float(hourly["emissions_g"].sum() / 1000),
                "emissions_if_all_grid_kg": float(hourly["emissions_if_all_grid_g"].sum() / 1000),
                "shift_tokens": chain.shift_balance(addr),
                "hourly": rows,
            }
        )

    # ---------------------------------------------------------------- forecast
    print("6/6 day-ahead carbon forecast")
    fc = IntensityForecaster()
    frame = fc.build_frame(HISTORY_DAYS)
    fc.fit(frame)
    ahead = fc.predict_next(frame)
    blend = ahead[["forecast", "neso_forecast"]].mean(axis=1) if "neso_forecast" in ahead else ahead["forecast"]
    best = set(surplus_hours(blend))
    forecast_out = {
        "metrics": fc.metrics,
        "hours": [
            {
                "time": t.isoformat(),
                "model": float(ahead.loc[t, "forecast"]),
                "neso": None if "neso_forecast" not in ahead or pd.isna(ahead.loc[t, "neso_forecast"]) else float(ahead.loc[t, "neso_forecast"]),
                "blend": float(blend.loc[t]),
                "surplus": t in best,
            }
            for t in ahead.index
        ],
    }

    devices_out = [
        {
            "key": d.key,
            "id": device_ids[d.key],
            "name": d.name,
            "kind": d.kind,
            "capacity_w": d.capacity_w,
            "lat": d.lat,
            "lon": d.lon,
            "meter": d.account.address,
            "owner": owners[d.key],
            "risk": risk[d.key],
        }
        for d in simulator.DEVICES
    ]

    def dump(name, obj):
        (STATE / f"{name}.json").write_text(json.dumps(obj, indent=1, default=str))

    dump("devices", devices_out)
    dump("readings", readings.to_dict(orient="records"))
    dump("buyers", buyers_out)
    dump("forecast", forecast_out)
    dump("metrics", {**metrics, "generated_at": datetime.now(timezone.utc).isoformat(), "days": days})
    print(json.dumps({"window": metrics["window"], "buyers": [{k: v for k, v in b.items() if k != "hourly"} for b in buyers_out], "forecast": fc.metrics}, indent=1))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=7)
    run(p.parse_args().days)
