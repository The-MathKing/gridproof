"""Fetchers for the two free public data sources. Responses are cached on disk."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pandas as pd

CACHE = Path(__file__).resolve().parent.parent / ".cache"
CACHE.mkdir(exist_ok=True)

CARBON_API = "https://api.carbonintensity.org.uk"
WEATHER_API = "https://api.open-meteo.com/v1/forecast"

# UK Carbon Intensity regions used by the demo
REGION_LONDON = 13


def _get_json(url: str, params: dict | None = None, max_age_h: float = 1.0) -> dict:
    key = hashlib.sha1((url + json.dumps(params or {}, sort_keys=True)).encode()).hexdigest()
    path = CACHE / f"{key}.json"
    if path.exists():
        age_h = (datetime.now().timestamp() - path.stat().st_mtime) / 3600
        if age_h < max_age_h:
            return json.loads(path.read_text())
    r = httpx.get(url, params=params, timeout=30)
    r.raise_for_status()
    path.write_text(r.text)
    return r.json()


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%MZ")


def carbon_intensity(region_id: int, start: datetime, end: datetime) -> pd.DataFrame:
    """Hourly grid carbon intensity (gCO2/kWh) and generation mix for a region.

    The API serves half-hourly slots in windows of up to 14 days; we average pairs into hours.
    """
    rows = []
    cursor = start
    while cursor < end:
        stop = min(cursor + timedelta(days=13), end)
        url = f"{CARBON_API}/regional/intensity/{_iso(cursor)}/{_iso(stop)}/regionid/{region_id}"
        # Past windows never change, so cache them for a long time.
        data = _get_json(url, max_age_h=24 * 30 if stop < datetime.now(timezone.utc) - timedelta(days=1) else 1)
        for slot in data["data"]["data"]:
            mix = {m["fuel"]: m["perc"] for m in slot["generationmix"]}
            rows.append(
                {
                    "time": pd.Timestamp(slot["from"]).tz_convert("UTC"),
                    "intensity": slot["intensity"]["forecast"],
                    **{f"mix_{k}": v for k, v in mix.items()},
                }
            )
        cursor = stop
    df = pd.DataFrame(rows).drop_duplicates("time").set_index("time").sort_index()
    return df.resample("1h").mean()


def weather(lat: float, lon: float, past_days: int = 60, forecast_days: int = 2) -> pd.DataFrame:
    """Hourly sunlight (W/m2), 100 m wind speed (m/s) and temperature, history plus forecast."""
    data = _get_json(
        WEATHER_API,
        {
            "latitude": lat,
            "longitude": lon,
            "hourly": "shortwave_radiation,wind_speed_100m,temperature_2m,cloud_cover",
            "wind_speed_unit": "ms",
            "past_days": past_days,
            "forecast_days": forecast_days,
            "timezone": "UTC",
        },
    )
    h = data["hourly"]
    df = pd.DataFrame(
        {
            "ghi": h["shortwave_radiation"],
            "wind100": h["wind_speed_100m"],
            "temp": h["temperature_2m"],
            "cloud": h["cloud_cover"],
        },
        index=pd.to_datetime(h["time"]).tz_localize("UTC"),
    )
    df.index.name = "time"
    return df


def national_intensity(start: datetime, end: datetime) -> pd.DataFrame:
    """Hourly GB national carbon intensity: measured `actual` plus NESO's own `neso_forecast`."""
    rows = []
    cursor = start
    while cursor < end:
        stop = min(cursor + timedelta(days=13), end)
        url = f"{CARBON_API}/intensity/{_iso(cursor)}/{_iso(stop)}"
        data = _get_json(url, max_age_h=24 * 30 if stop < datetime.now(timezone.utc) - timedelta(days=1) else 1)
        for slot in data["data"]:
            rows.append(
                {
                    "time": pd.Timestamp(slot["from"]).tz_convert("UTC"),
                    "actual": slot["intensity"]["actual"],
                    "neso_forecast": slot["intensity"]["forecast"],
                }
            )
        cursor = stop
    df = pd.DataFrame(rows).drop_duplicates("time").set_index("time").sort_index().astype(float)
    return df.resample("1h").mean()


def intensity_forecast_48h() -> pd.DataFrame:
    """NESO's published forecast for the next 48 hours (national)."""
    now = datetime.now(timezone.utc)
    data = _get_json(f"{CARBON_API}/intensity/{_iso(now)}/fw48h", max_age_h=0.5)
    df = pd.DataFrame(
        [{"time": pd.Timestamp(s["from"]).tz_convert("UTC"), "neso_forecast": s["intensity"]["forecast"]} for s in data["data"]]
    ).set_index("time")
    return df.resample("1h").mean()
