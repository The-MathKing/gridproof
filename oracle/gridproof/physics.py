"""What a device could physically have produced in an hour, given the weather.

Open-Meteo's shortwave radiation is the mean over the *preceding* hour, which lines
up with a certificate hour [t-1h, t), so we shift it when indexing by hour start.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# Solar: performance ratio for inverter, wiring, soiling losses; cell temperature derate.
SOLAR_PR = 0.82
SOLAR_TEMP_COEFF = -0.004  # per degree C above 25
NOCT_RISE = 0.03  # degrees C of cell heating per W/m2

# Generic small/medium turbine power curve (m/s at hub height)
CUT_IN, RATED, CUT_OUT = 3.0, 12.0, 25.0
HUB_SHEAR = 0.97  # 100 m wind to ~80 m hub


def solar_expected_wh(capacity_w: float, ghi: pd.Series, temp: pd.Series) -> pd.Series:
    cell_t = temp + NOCT_RISE * ghi
    derate = 1 + SOLAR_TEMP_COEFF * (cell_t - 25)
    return (capacity_w * (ghi / 1000.0) * SOLAR_PR * derate).clip(lower=0, upper=capacity_w)


def wind_expected_wh(capacity_w: float, wind100: pd.Series) -> pd.Series:
    v = wind100 * HUB_SHEAR
    frac = np.where(
        (v < CUT_IN) | (v >= CUT_OUT),
        0.0,
        np.where(v >= RATED, 1.0, ((v - CUT_IN) / (RATED - CUT_IN)) ** 3),
    )
    return pd.Series(frac * capacity_w, index=wind100.index)


def expected_wh(kind: str, capacity_w: float, wx: pd.DataFrame) -> pd.Series:
    """Expected Wh for each hour starting at the index timestamp."""
    shifted = wx.shift(-1)  # value stamped at t+1 describes hour [t, t+1)
    if kind == "solar":
        return solar_expected_wh(capacity_w, shifted["ghi"], shifted["temp"]).fillna(0)
    return wind_expected_wh(capacity_w, shifted["wind100"]).fillna(0)


# How much better a device's local weather can plausibly be than the grid-cell
# forecast it is checked against (passing clouds clearing, gusts).
GHI_UNCERTAINTY = (1.6, 60.0)  # multiply, then add W/m2
WIND_UNCERTAINTY = (1.3, 0.7)  # multiply, then add m/s


def max_plausible_wh(kind: str, capacity_w: float, wx: pd.DataFrame) -> pd.Series:
    """Upper bound on honest output for each hour, allowing for local weather error."""
    w = wx.copy()
    if kind == "solar":
        m, a = GHI_UNCERTAINTY
        w["ghi"] = np.where(w["ghi"] > 0, w["ghi"] * m + a, 0)
    else:
        m, a = WIND_UNCERTAINTY
        w["wind100"] = w["wind100"] * m + a
    return expected_wh(kind, capacity_w, w)
