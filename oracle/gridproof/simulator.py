"""Demo devices and buyers, driven by real weather.

Honest meters report the physically expected output plus realistic noise and
occasional outages. A share of readings are tampered with in the ways real
certificate fraud happens, and labelled, so the integrity model can be scored.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from eth_account import Account
from eth_utils import keccak

from . import physics


@dataclass(frozen=True)
class Device:
    key: str
    name: str
    kind: str  # "solar" | "wind"
    capacity_w: int
    lat: float
    lon: float
    fraud_rate: float  # share of hours tampered with in the simulation

    @property
    def account(self):
        # Demo meter key, derived deterministically so runs are reproducible.
        return Account.from_key(keccak(text=f"gridproof-demo-meter-{self.key}"))


@dataclass(frozen=True)
class Buyer:
    key: str
    name: str
    profile: str  # "flat" | "office" | "overnight"
    base_w: int
    peak_w: int


DEVICES = [
    Device("brixton", "Brixton Solar Co-op", "solar", 200_000, 51.462, -0.115, 0.01),
    Device("hackney", "Hackney Rooftops", "solar", 80_000, 51.545, -0.055, 0.01),
    Device("kent", "Kent Community Wind", "wind", 600_000, 51.35, 1.35, 0.01),
    # This one has a tampered meter: it inflates readings far more often.
    Device("estuary", "Thames Estuary Turbine", "wind", 350_000, 51.5, 0.7, 0.10),
]

BUYERS = [
    Buyer("datacentre", "Southwark Data Centre", "flat", 80_000, 80_000),
    Buyer("campus", "Bloomsbury University Campus", "office", 30_000, 120_000),
    Buyer("depot", "Walworth Electric Bus Depot", "overnight", 10_000, 150_000),
]

FRAUD_TYPES = ["inflate", "night_solar", "flatline", "replay"]


def _ar1(n: int, sd: float, phi: float, rng: np.random.Generator) -> np.ndarray:
    """Slowly varying multiplicative error, mean 1, stationary s.d. `sd`."""
    e = np.zeros(n)
    shocks = rng.normal(0, sd * np.sqrt(1 - phi**2), n)
    for i in range(1, n):
        e[i] = phi * e[i - 1] + shocks[i]
    return 1 + e


def simulate_readings(device: Device, wx: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
    # What the checker sees: weather for the grid cell. What the device actually sees: local
    # weather that differs from it (passing clouds, gusts, turbulence), so honest readings
    # don't match the physics model exactly.
    expected = physics.expected_wh(device.kind, device.capacity_w, wx)
    local = wx.copy()
    if device.kind == "solar":
        local["ghi"] = (wx["ghi"] * _ar1(len(wx), 0.18, 0.7, rng)).clip(lower=0)
    else:
        local["wind100"] = (wx["wind100"] * _ar1(len(wx), 0.10, 0.8, rng)).clip(lower=0)
    actual = physics.expected_wh(device.kind, device.capacity_w, local)
    noise = rng.lognormal(0.0, 0.03, len(expected))
    reported = actual * noise
    reported[rng.random(len(expected)) < 0.01] = 0  # outages / maintenance

    df = pd.DataFrame(
        {
            "expected_wh": expected,
            "max_plausible_wh": physics.max_plausible_wh(device.kind, device.capacity_w, wx),
            "reported_wh": reported,
            "fraud": "",
        },
        index=wx.index,
    )
    cap = device.capacity_w

    tampered = rng.random(len(df)) < device.fraud_rate
    for i in np.flatnonzero(tampered):
        exp = df["expected_wh"].iat[i]
        if device.kind == "solar" and exp < 0.02 * cap:
            kind = "night_solar"
        elif exp < 0.5 * cap and rng.random() < 0.3:
            kind = "flatline"
        elif i >= 24 and rng.random() < 0.3:
            kind = "replay"
        else:
            kind = "inflate"

        if kind == "night_solar":
            val = cap * rng.uniform(0.2, 0.6)
        elif kind == "flatline":
            val = cap * rng.uniform(0.95, 1.0)
        elif kind == "replay":
            val = df["reported_wh"].iloc[i - 24 : i].max()  # copy yesterday's best hour
            if val <= exp * 1.3 + 0.1 * cap:
                val, kind = min(cap, max(exp, 0.05 * cap) * rng.uniform(1.6, 2.5)), "inflate"
        else:
            val = min(cap, max(exp, 0.05 * cap) * rng.uniform(1.6, 2.5))
        df.iat[i, df.columns.get_loc("reported_wh")] = val
        df.iat[i, df.columns.get_loc("fraud")] = kind

    df["reported_wh"] = df["reported_wh"].clip(0, cap).round().astype(int)
    df["expected_wh"] = df["expected_wh"].round().astype(int)
    df["max_plausible_wh"] = df["max_plausible_wh"].round().astype(int)
    return df


def buyer_load(buyer: Buyer, index: pd.DatetimeIndex, rng: np.random.Generator) -> pd.Series:
    hour = index.hour + 1  # UK is UTC+1 in summer time; close enough for a demo profile
    weekday = index.dayofweek < 5
    if buyer.profile == "flat":
        shape = np.ones(len(index))
    elif buyer.profile == "office":
        shape = np.where(weekday & (hour >= 8) & (hour < 19), 1.0, 0.0)
    else:  # buses charge overnight
        shape = np.where((hour >= 20) | (hour < 5), 1.0, 0.0)
    load = buyer.base_w + (buyer.peak_w - buyer.base_w) * shape
    load = load * rng.normal(1.0, 0.04, len(index))
    return pd.Series(load.clip(min=0).round().astype(int), index=index)
