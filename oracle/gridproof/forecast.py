"""Day-ahead forecast of GB grid carbon intensity, used to pick surplus hours.

Great Britain's grid intensity is driven mostly by wind (and in daytime, solar), so the
model combines calendar and lag features with weather forecasts at points that stand in
for the big wind fleets (North Sea, Scotland, Irish Sea) and for solar in the south.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from . import data

WEATHER_POINTS = {
    "northsea": (54.5, 1.5),
    "scotland": (57.0, -4.0),
    "irishsea": (53.8, -3.6),
    "south": (51.5, -1.0),
}
HORIZON = 24  # hours ahead; lag-24 stays known across the whole horizon


def _weather_features(past_days: int) -> pd.DataFrame:
    cols = []
    for name, (lat, lon) in WEATHER_POINTS.items():
        w = data.weather(lat, lon, past_days=past_days, forecast_days=2)
        cols.append(w["wind100"].rename(f"wind_{name}"))
        cols.append((w["wind100"].clip(3, 12) - 3) ** 3 / 729)  # rough power-curve shape
        cols[-1].name = f"windpow_{name}"
        if name == "south":
            cols.append(w["ghi"].rename("ghi_south"))
    return pd.concat(cols, axis=1)


def _features(frame: pd.DataFrame) -> pd.DataFrame:
    idx = frame.index
    X = pd.DataFrame(index=idx)
    X["hour"] = idx.hour
    X["dow"] = idx.dayofweek
    X["lag24"] = frame["actual"].shift(24)
    X["lag48"] = frame["actual"].shift(48)
    X["lag168"] = frame["actual"].shift(168)
    for c in frame.columns:
        if c.startswith(("wind", "ghi")):
            X[c] = frame[c]
    X["wind_total"] = frame[[c for c in frame.columns if c.startswith("windpow_")]].sum(axis=1)
    return X


class IntensityForecaster:
    def __init__(self):
        self.model = HistGradientBoostingRegressor(max_iter=400, learning_rate=0.05, random_state=0)
        self.metrics: dict = {}

    def build_frame(self, past_days: int = 60) -> pd.DataFrame:
        end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        hist = data.national_intensity(end - timedelta(days=past_days), end)
        wx = _weather_features(past_days)
        frame = wx.join(hist, how="left")
        return frame[frame.index >= hist.index.min()]

    def fit(self, frame: pd.DataFrame, test_days: int = 7) -> "IntensityForecaster":
        X = _features(frame)
        y = frame["actual"]
        ok = y.notna() & X["lag168"].notna()
        X, y, neso = X[ok], y[ok], frame.loc[ok, "neso_forecast"]
        cut = X.index.max() - pd.Timedelta(days=test_days)
        train, test = X.index <= cut, X.index > cut

        self.model.fit(X[train], y[train])
        pred = self.model.predict(X[test])
        self.metrics = {
            "test_days": test_days,
            "mae_model": float(np.mean(np.abs(pred - y[test]))),
            "mae_persistence_24h": float(np.mean(np.abs(X.loc[test, "lag24"] - y[test]))),
            # NESO's figure here is its short-range forecast, a strong reference point
            "mae_neso_short_range": float(np.mean(np.abs(neso[test] - y[test]))),
            "mean_intensity": float(y[test].mean()),
        }
        # Refit on everything for live use
        self.model.fit(X, y)
        return self

    def predict_next(self, frame: pd.DataFrame, hours: int = HORIZON) -> pd.DataFrame:
        last = frame["actual"].last_valid_index()
        future = pd.date_range(last + pd.Timedelta(hours=1), periods=hours, freq="1h", tz="UTC")
        ext = frame.reindex(frame.index.union(future))
        X = _features(ext).loc[future]
        out = pd.DataFrame({"forecast": self.model.predict(X)}, index=future)
        try:
            out = out.join(data.intensity_forecast_48h(), how="left")
        except Exception:  # NESO forecast is a nice-to-have comparison
            pass
        return out


def surplus_hours(forecast: pd.Series, share: float = 0.25) -> pd.Index:
    """The cleanest quarter of the coming day: where shifting load cuts the most emissions."""
    return forecast[forecast <= forecast.quantile(share)].index
