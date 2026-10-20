"""HTTP API for the dashboard.

    uvicorn gridproof.api:app --port 8000

Reads the pipeline's state files, plus live reads from the chain so anything shown
can be checked against the contracts directly.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .chain import ROOT, Chain

STATE = Path(__file__).resolve().parent.parent / "state"
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="GridProof oracle")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_chain: Chain | None = None


def chain() -> Chain:
    global _chain
    if _chain is None:
        _chain = Chain()
    return _chain


def load(name: str):
    path = STATE / f"{name}.json"
    if not path.exists():
        raise HTTPException(503, f"No {name} yet. Run `python -m gridproof.pipeline` first.")
    return json.loads(path.read_text())


@app.get("/api/summary")
def summary():
    buyers = [{k: v for k, v in b.items() if k != "hourly"} for b in load("buyers")]
    readings = load("readings")
    counts = {}
    for r in readings:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    issued_wh = sum(r["reported_wh"] for r in readings if r["status"] == "issued")
    return {
        "metrics": load("metrics"),
        "devices": load("devices"),
        "buyers": buyers,
        "certificates": {"by_status": counts, "issued_kwh": issued_wh / 1000},
        "forecast_metrics": load("forecast")["metrics"],
    }


@app.get("/api/buyers/{key}")
def buyer(key: str):
    for b in load("buyers"):
        if b["key"] == key:
            return b
    raise HTTPException(404, "unknown buyer")


@app.get("/api/readings")
def readings(device: str | None = None, flagged: bool = False, limit: int = 2000):
    rows = load("readings")
    if device:
        rows = [r for r in rows if r["device"] == device]
    if flagged:
        rows = [r for r in rows if r["status"] in ("quarantined", "released", "rejected")]
    return rows[-limit:]


@app.get("/api/forecast")
def forecast():
    return load("forecast")


@app.get("/api/deployment")
def deployment():
    return chain().deployment


@app.get("/api/certificates/{token_id}")
def certificate(token_id: str):
    tid = int(token_id)
    c = chain().certificate(tid)
    device_id, hour = tid >> 32, tid & 0xFFFFFFFF
    return {"token_id": token_id, "device_id": device_id, "hour": hour, **c}


class Resolution(BaseModel):
    release: bool


@app.post("/api/quarantine/{token_id}/resolve")
def resolve(token_id: str, body: Resolution):
    """Auditor decision on a quarantined reading, executed on-chain."""
    rows = load("readings")
    row = next((r for r in rows if r["token_id"] == token_id), None)
    if row is None or row["status"] != "quarantined":
        raise HTTPException(409, "reading is not quarantined")
    chain().resolve(int(token_id), body.release)
    row["status"] = "released" if body.release else "rejected"
    (STATE / "readings.json").write_text(json.dumps(rows, indent=1))
    return certificate(token_id)


if WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
