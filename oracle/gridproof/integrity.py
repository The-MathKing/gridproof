"""AI integrity check for meter readings, run before any certificate is minted.

Two signals are combined:

1. Physics: how far the reading exceeds what the weather made possible for this
   device's capacity. Over-reporting is the fraud that pays, so this is one-sided.
2. Learned: an IsolationForest over per-reading features (including how the reading
   compares with the device's own recent behaviour) catches patterns the simple
   physics bound misses, like replayed values and readings pinned at capacity.

The result is an anomaly score in basis points (0-10000), which goes on-chain with
the certificate. At or above the contract threshold the reading is quarantined.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

THRESHOLD = 0.70  # matches GranularCertificate.anomalyThresholdBps = 7000


def features(df: pd.DataFrame, capacity_w: float, kind: str) -> pd.DataFrame:
    cap = float(capacity_w)
    rep = df["reported_wh"].astype(float)
    exp = df["expected_wh"].astype(float)
    ratio_log = np.log((rep + 0.02 * cap) / (exp + 0.02 * cap))
    hour = df.index.hour
    return pd.DataFrame(
        {
            "excess": (rep - exp) / cap,
            # Above the most a device could honestly make given weather uncertainty
            "over_plausible": (rep - df["max_plausible_wh"].astype(float)) / cap,
            "ratio_log": ratio_log,
            "expected_frac": exp / cap,
            "reported_frac": rep / cap,
            # Drift compared with this device's own last three days (soiling, calibration)
            "vs_own_median": ratio_log - ratio_log.rolling(72, min_periods=6).median().shift(1).fillna(0),
            # How close the reading is to the largest value of the previous day (replays)
            "same_as_yesterday_max": (rep - rep.rolling(24).max().shift(1)).abs().fillna(cap) / cap,
            "night": ((exp < 0.01 * cap) & (kind == "solar")).astype(float),
            "hour_sin": np.sin(2 * np.pi * hour / 24),
            "hour_cos": np.cos(2 * np.pi * hour / 24),
        },
        index=df.index,
    )


def _sigmoid(x):
    return 1 / (1 + np.exp(-x))


class IntegrityModel:
    def __init__(self, seed: int = 7):
        self.forest = IsolationForest(n_estimators=300, contamination="auto", random_state=seed)
        self._ref: np.ndarray | None = None

    def fit(self, X: pd.DataFrame) -> "IntegrityModel":
        self.forest.fit(X.values)
        # Keep the training score distribution to turn raw scores into percentiles.
        self._ref = np.sort(-self.forest.score_samples(X.values))
        return self

    def score(self, X: pd.DataFrame) -> pd.DataFrame:
        raw = -self.forest.score_samples(X.values)
        pct = np.searchsorted(self._ref, raw) / len(self._ref)
        # Only care about the learned signal far in the tail, and mostly on over-reporting.
        learned = np.clip((pct - 0.97) / 0.03, 0, 1) * np.where(X["ratio_log"] > 0.05, 1.0, 0.2)

        ratio = X["ratio_log"].values
        physics = _sigmoid((X["over_plausible"].values - 0.03) / 0.01)
        night = X["night"].values * (X["reported_frac"].values > 0.05)
        # A turbine at rated power legitimately repeats its maximum, so ignore readings at capacity.
        replay = (X["same_as_yesterday_max"].values < 0.002) * (ratio > 0.3) * (X["reported_frac"].values < 0.97)
        physics = np.maximum.reduce([physics, night, replay * 0.9])

        score = np.clip(np.maximum(physics, 0.8 * learned), 0, 1)
        return pd.DataFrame(
            {"anomaly": score, "physics": physics, "learned": learned},
            index=X.index,
        )


def reasons(row: pd.Series, feats: pd.Series) -> list[str]:
    out = []
    if feats["night"] and feats["reported_frac"] > 0.05:
        out.append("Solar output reported at night")
    if feats["over_plausible"] > 0.02:
        mult = np.exp(feats["ratio_log"])
        out.append(f"Reported {mult:.1f}x the expected output, above the most this hour's weather allowed")
    if feats["reported_frac"] > 0.94 and feats["expected_frac"] < 0.6:
        out.append("Reading pinned at capacity in weak conditions")
    if feats["same_as_yesterday_max"] < 0.002 and feats["ratio_log"] > 0.3 and feats["reported_frac"] < 0.97:
        out.append("Identical to yesterday's peak reading (possible replay)")
    if row["learned"] > 0.5 and not out:
        out.append("Unusual compared with this device's own history")
    return out


def evaluate(scored: pd.DataFrame) -> dict:
    """Precision/recall on the simulator's labelled fraud."""
    flagged = scored["anomaly"] >= THRESHOLD
    fraud = scored["fraud"] != ""
    tp = int((flagged & fraud).sum())
    fp = int((flagged & ~fraud).sum())
    fn = int((~flagged & fraud).sum())
    tn = int((~flagged & ~fraud).sum())
    by_type = {
        t: {"total": int((scored["fraud"] == t).sum()), "caught": int(((scored["fraud"] == t) & flagged).sum())}
        for t in sorted(set(scored["fraud"]) - {""})
    }
    # Energy that would have been fraudulently certified, with and without the check
    fake_wh = (scored["reported_wh"] - scored["expected_wh"]).clip(lower=0)
    return {
        "readings": int(len(scored)),
        "fraudulent": int(fraud.sum()),
        "precision": tp / (tp + fp) if tp + fp else 1.0,
        "recall": tp / (tp + fn) if tp + fn else 1.0,
        "false_positive_rate": fp / (fp + tn) if fp + tn else 0.0,
        "by_type": by_type,
        "fake_wh_blocked": int(fake_wh[flagged & fraud].sum()),
        "fake_wh_missed": int(fake_wh[~flagged & fraud].sum()),
    }
