import { useEffect, useState } from "react";
import { Contract, JsonRpcProvider } from "ethers";
import { HourlyBars, LineChart, MatchHeatmap } from "./charts";
import { fmtTime, get, kwh, pct, post, type Buyer, type Forecast, type Reading, type Summary } from "./api";

type Tab = "buyers" | "integrity" | "forecast" | "verify";
const TABS: Tab[] = ["buyers", "integrity", "forecast", "verify"];
// Each tab has its own URL (#integrity etc.) so pages can be linked directly.
const tabFromHash = (): Tab => {
  const h = window.location.hash.slice(1) as Tab;
  return TABS.includes(h) ? h : "buyers";
};

export default function App() {
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const setTab = (t: Tab) => {
    window.history.replaceState(null, "", `#${t}`);
    setTabState(t);
  };
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<Summary>("/api/summary").then(setSummary, (e) => setError(String(e)));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <div>
            <h1>GridProof</h1>
            <div className="muted" style={{ fontSize: 13 }}>
              Hourly clean-energy certificates, checked by AI, recorded on-chain
            </div>
          </div>
        </div>
        <nav className="tabs" role="tablist">
          {(
            [
              ["buyers", "Buyers: claim vs reality"],
              ["integrity", "AI integrity check"],
              ["forecast", "Clean-hour forecast"],
              ["verify", "Verify on-chain"],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>
      </header>

      {error && <div className="notice">Couldn't reach the oracle API: {error}</div>}
      {summary && tab === "buyers" && <Buyers summary={summary} />}
      {summary && tab === "integrity" && <Integrity summary={summary} />}
      {summary && tab === "forecast" && <ForecastView />}
      {summary && tab === "verify" && <Verify summary={summary} />}
    </div>
  );
}

// ---------------------------------------------------------------- buyers

function Buyers({ summary }: { summary: Summary }) {
  const [key, setKey] = useState(summary.buyers[0]?.key);
  const [buyer, setBuyer] = useState<Buyer | null>(null);
  useEffect(() => {
    if (key) get<Buyer>(`/api/buyers/${key}`).then(setBuyer);
  }, [key]);

  const rows = buyer?.hourly ?? [];
  const cut = buyer ? 1 - buyer.emissions_kg / buyer.emissions_if_all_grid_kg : 0;

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>What "renewable" really means, hour by hour</h2>
          <div className="segmented">
            {summary.buyers.map((b) => (
              <button key={b.key} aria-pressed={b.key === key} onClick={() => setKey(b.key)}>
                {b.name}
              </button>
            ))}
          </div>
        </div>
        {buyer && (
          <>
            <div className="claim-compare">
              <div className="claim">
                <h3>Annual-style claim (today's certificates)</h3>
                <div className="big num">{pct(buyer.volumetric_claim)}</div>
                <div className="secondary">
                  Certificates bought by total volume, from any hour of the week, count as renewable.
                </div>
              </div>
              <div className="claim truth">
                <h3>Hourly match on GridProof</h3>
                <div className="big num" style={{ color: "var(--series-1)" }}>
                  {pct(buyer.hourly_match)}
                </div>
                <div className="secondary">
                  Only clean energy generated in the same hour it was used counts.
                </div>
              </div>
            </div>
            <div className="tiles">
              <div className="tile">
                <span className="label">Energy used ({summary.metrics.days} days)</span>
                <span className="value num">{Math.round(buyer.load_kwh).toLocaleString()} kWh</span>
              </div>
              <div className="tile">
                <span className="label">Real emissions</span>
                <span className="value num">{(buyer.emissions_kg / 1000).toFixed(2)} t CO₂</span>
                <span className="sub">Unmatched hours × that hour's grid intensity</span>
              </div>
              <div className="tile">
                <span className="label">Emissions avoided by matching</span>
                <span className="value num">{pct(cut)}</span>
                <span className="sub">vs. {(buyer.emissions_if_all_grid_kg / 1000).toFixed(2)} t if all from the grid</span>
              </div>
              <div className="tile">
                <span className="label">GSHIFT rewards earned</span>
                <span className="value num">{Math.round(buyer.shift_tokens).toLocaleString()}</span>
                <span className="sub">1 per kWh of clean energy used in surplus hours</span>
              </div>
            </div>
          </>
        )}
      </section>

      {buyer && (
        <>
          <section className="card">
            <div className="card-head">
              <h2>Hourly match, by day</h2>
              <span className="muted">{buyer.name}</span>
            </div>
            <MatchHeatmap rows={rows} />
          </section>
          <section className="card">
            <div className="card-head">
              <h2>Grid carbon intensity</h2>
              <span className="muted">GB national, NESO</span>
            </div>
            <LineChart
              times={rows.map((r) => r.time)}
              series={[{ name: "Carbon intensity", color: "var(--series-2)", values: rows.map((r) => r.intensity) }]}
              shade={rows.map((r) => r.surplus)}
              shadeLabel="Surplus hour (cleanest 25% of the day)"
              unit="gCO₂/kWh"
            />
          </section>
        </>
      )}

      {buyer && (
        <section className="card">
          <div className="card-head">
            <h2>Use vs. same-hour clean energy</h2>
            <span className="muted">Each bar is one hour, read from the contract's hourly ledger</span>
          </div>
          <HourlyBars rows={rows} />
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------- integrity

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  issued: { label: "Issued", color: "var(--good)" },
  quarantined: { label: "Quarantined", color: "var(--serious)" },
  released: { label: "Released by auditor", color: "var(--good)" },
  rejected: { label: "Rejected", color: "var(--critical)" },
  none: { label: "No output", color: "var(--text-muted)" },
};

function Integrity({ summary }: { summary: Summary }) {
  const [flagged, setFlagged] = useState<Reading[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const m = summary.metrics.history;
  const devices = Object.fromEntries(summary.devices.map((d) => [d.key, d]));

  useEffect(() => {
    get<Reading[]>("/api/readings?flagged=true").then((r) => setFlagged(r.reverse()));
  }, []);

  const resolve = async (r: Reading, release: boolean) => {
    setBusy(r.token_id);
    try {
      await post(`/api/quarantine/${r.token_id}/resolve`, { release });
      setFlagged((rows) => rows.map((x) => (x.token_id === r.token_id ? { ...x, status: release ? "released" : "rejected" } : x)));
    } finally {
      setBusy(null);
    }
  };

  const blockedShare = m.fake_wh_blocked / Math.max(1, m.fake_wh_blocked + m.fake_wh_missed);

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Every reading is checked against the weather before it can become a certificate</h2>
          <span className="muted">{m.readings.toLocaleString()} readings over 60 days, {m.fraudulent} tampered with</span>
        </div>
        <div className="tiles">
          <div className="tile">
            <span className="label">Fake energy blocked</span>
            <span className="value num">{pct(blockedShare)}</span>
            <span className="sub">{kwh(m.fake_wh_blocked)} of {kwh(m.fake_wh_blocked + m.fake_wh_missed)} inflated output</span>
          </div>
          <div className="tile">
            <span className="label">False alarms</span>
            <span className="value num">{pct(m.false_positive_rate, 2)}</span>
            <span className="sub">of honest readings sent to an auditor</span>
          </div>
          <div className="tile">
            <span className="label">Precision</span>
            <span className="value num">{pct(m.precision)}</span>
            <span className="sub">flagged readings that really were tampered</span>
          </div>
          <div className="tile">
            <span className="label">Tampered readings caught</span>
            <span className="value num">{pct(m.recall)}</span>
            <span className="sub">misses stay inside the weather-uncertainty band</span>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Kind of tampering</th>
                <th>Caught</th>
                <th>How it shows up</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(m.by_type).map(([t, v]) => (
                <tr key={t}>
                  <td>{{ inflate: "Inflated reading", night_solar: "Solar output at night", flatline: "Pinned at capacity", replay: "Replayed old reading" }[t] ?? t}</td>
                  <td className="num">
                    {v.caught} / {v.total}
                  </td>
                  <td className="secondary">
                    {{
                      inflate: "Above the most the hour's sunlight or wind allowed. Small inflations that stay inside weather uncertainty can slip through, which caps how much fraud can gain per hour.",
                      night_solar: "Physics: no sunlight, so no solar output.",
                      flatline: "Full output in weak conditions.",
                      replay: "Same value as yesterday's peak, in different weather.",
                    }[t]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Device risk</h2>
          <span className="muted">Share of producing hours near the top of the plausible band. Honest meters rarely sit there.</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Type</th>
                <th>Capacity</th>
                <th>Near the limit</th>
                <th>Quarantined</th>
                <th>Meter key</th>
              </tr>
            </thead>
            <tbody>
              {summary.devices.map((d) => (
                <tr key={d.key}>
                  <td>{d.name}</td>
                  <td>{d.kind === "solar" ? "Solar" : "Wind"}</td>
                  <td className="num">{d.capacity_w / 1000} kW</td>
                  <td className="num">{pct(d.risk.near_top_share, 1)}</td>
                  <td className="num">{pct(d.risk.flagged_share, 1)}</td>
                  <td className="mono">{d.meter.slice(0, 10)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Auditor queue</h2>
          <span className="muted">Quarantined on-chain. Releasing mints the certificate; rejecting blocks that hour for good.</span>
        </div>
        {flagged.length === 0 ? (
          <div className="notice">Nothing was quarantined in this window.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Hour</th>
                  <th>Device</th>
                  <th>Reported</th>
                  <th>Expected</th>
                  <th>Max plausible</th>
                  <th>Score</th>
                  <th>Why</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {flagged.map((r) => {
                  const s = STATUS_STYLE[r.status];
                  return (
                    <tr key={r.token_id}>
                      <td>{fmtTime(r.time)}</td>
                      <td>{devices[r.device]?.name}</td>
                      <td className="num">{kwh(r.reported_wh)}</td>
                      <td className="num">{kwh(r.expected_wh)}</td>
                      <td className="num">{kwh(r.max_plausible_wh)}</td>
                      <td className="num">{(r.anomaly_bps / 100).toFixed(0)}</td>
                      <td>{r.reasons.join("; ") || "Unusual for this device"}</td>
                      <td>
                        <span className="status" style={{ color: s.color }}>
                          {s.label}
                        </span>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {r.status === "quarantined" && (
                          <>
                            <button className="btn" disabled={busy === r.token_id} onClick={() => resolve(r, false)}>
                              Reject
                            </button>{" "}
                            <button className="btn" disabled={busy === r.token_id} onClick={() => resolve(r, true)}>
                              Release
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- forecast

function ForecastView() {
  const [fc, setFc] = useState<Forecast | null>(null);
  useEffect(() => {
    get<Forecast>("/api/forecast").then(setFc);
  }, []);
  if (!fc) return null;
  const best = fc.hours.filter((h) => h.surplus);

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>When to run flexible loads in the next 24 hours</h2>
          <span className="muted">Shaded: forecast cleanest hours. GSHIFT pays a bonus for using clean energy then.</span>
        </div>
        <LineChart
          times={fc.hours.map((h) => h.time)}
          series={[
            { name: "GridProof model", color: "var(--series-1)", values: fc.hours.map((h) => h.model) },
            { name: "NESO forecast", color: "var(--series-2)", values: fc.hours.map((h) => h.neso) },
          ]}
          shade={fc.hours.map((h) => h.surplus)}
          shadeLabel="Recommended clean hours"
          unit="gCO₂/kWh"
        />
        <div className="notice">
          Best hours to shift EV charging, batch jobs or heat pumps:{" "}
          <b>{best.map((h) => fmtTime(h.time).split(", ").pop()).join(", ")}</b>
        </div>
      </section>
      <section className="card">
        <h2>How good is the forecast?</h2>
        <div className="tiles">
          <div className="tile">
            <span className="label">GridProof model, day ahead</span>
            <span className="value num">{fc.metrics.mae_model.toFixed(1)}</span>
            <span className="sub">mean error, gCO₂/kWh, last 7 days held out</span>
          </div>
          <div className="tile">
            <span className="label">"Same as yesterday" baseline</span>
            <span className="value num">{fc.metrics.mae_persistence_24h.toFixed(1)}</span>
            <span className="sub">mean error, gCO₂/kWh</span>
          </div>
          <div className="tile">
            <span className="label">NESO short-range forecast</span>
            <span className="value num">{fc.metrics.mae_neso_short_range.toFixed(1)}</span>
            <span className="sub">uses live grid data; shorter horizon, so not like-for-like</span>
          </div>
        </div>
        <p className="secondary" style={{ margin: 0 }}>
          The model uses wind and sunlight forecasts for the North Sea, Scotland, the Irish Sea and southern England plus
          recent intensity. The recommendation blends it with NESO's published forecast.
        </p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- verify

interface Deployment {
  network: string;
  chainId: number;
  publicRpc?: string;
  explorer?: string | null;
  contracts: Record<string, { address: string; abi: unknown[] }>;
}

function Verify({ summary }: { summary: Summary }) {
  const [rpc, setRpc] = useState("http://127.0.0.1:8545");
  const [dep, setDep] = useState<Deployment | null>(null);
  const [tokenId, setTokenId] = useState("");
  const [result, setResult] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<Deployment>("/api/deployment").then((d) => {
      setDep(d);
      if (d.publicRpc) setRpc(d.publicRpc);
    });
    get<Reading[]>("/api/readings?limit=400").then((rs) => {
      const r = rs.filter((x) => x.status === "issued").sort((a, b) => b.reported_wh - a.reported_wh)[0];
      if (r) setTokenId(r.token_id);
    });
  }, []);

  const verify = async () => {
    if (!dep) return;
    setErr(null);
    setResult(null);
    try {
      // Straight to the chain from the browser: no trust in the GridProof API needed.
      const provider = new JsonRpcProvider(rpc);
      const gcInfo = dep.contracts.GranularCertificate;
      const regInfo = dep.contracts.DeviceRegistry;
      const gc = new Contract(gcInfo.address, gcInfo.abi as never, provider);
      const reg = new Contract(regInfo.address, regInfo.abi as never, provider);
      const id = BigInt(tokenId);
      const [deviceId, hour] = await gc.decode(id);
      const c = await gc.certificates(id);
      const device = await reg.getDevice(deviceId);
      const statuses = ["Never recorded", "Issued", "Quarantined", "Rejected"];
      const start = new Date(Number(hour) * 3600 * 1000);
      setResult({
        Device: `${device.name} (#${deviceId}, ${Number(device.capacityW) / 1000} kW ${Number(device.kind) === 0 ? "solar" : "wind"})`,
        Hour: `${fmtTime(start.toISOString())} (UK time)`,
        Status: statuses[Number(c.status)],
        "Energy certified": kwh(Number(c.wh)),
        "Already retired": kwh(Number(c.retiredWh)),
        "AI anomaly score": `${(Number(c.anomalyBps) / 100).toFixed(1)} / 100`,
        "Meter key": device.signer,
        Owner: device.owner,
        Contract: gcInfo.address,
      });
    } catch (e) {
      setErr(String(e));
    }
  };

  // Check the default certificate as soon as everything is loaded, so the page opens with a result.
  const [autoRan, setAutoRan] = useState(false);
  useEffect(() => {
    if (dep && tokenId && !autoRan) {
      setAutoRan(true);
      verify();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep, tokenId, autoRan]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Check any certificate directly on the blockchain</h2>
        <span className="muted">
          Your browser reads the contract itself, on {dep?.network === "sepolia" ? "the Sepolia testnet" : "the local chain"}. GridProof's servers aren't involved.
        </span>
      </div>
      <div className="grid-2">
        <label>
          <h3>Certificate token ID (device × hour)</h3>
          <input className="text mono" value={tokenId} onChange={(e) => setTokenId(e.target.value)} />
        </label>
        <label>
          <h3>Blockchain RPC endpoint</h3>
          <input className="text mono" value={rpc} onChange={(e) => setRpc(e.target.value)} />
        </label>
      </div>
      <div>
        <button className="btn primary" onClick={verify} disabled={!dep || !tokenId}>
          Verify on-chain
        </button>
      </div>
      {err && <div className="notice">{err}</div>}
      {result && dep?.explorer && (
        <div className="legend">
          <a href={`${dep.explorer}/nft/${dep.contracts.GranularCertificate.address}/${tokenId}`} target="_blank" rel="noreferrer">
            This certificate on Etherscan ↗
          </a>
          <a href={`${dep.explorer}/address/${dep.contracts.GranularCertificate.address}`} target="_blank" rel="noreferrer">
            Certificate contract ↗
          </a>
          <a href={`${dep.explorer}/address/${dep.contracts.DeviceRegistry.address}`} target="_blank" rel="noreferrer">
            Device registry ↗
          </a>
        </div>
      )}
      {result && (
        <dl className="kv">
          {Object.entries(result).map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd className={k.includes("key") || k === "Owner" || k === "Contract" ? "mono" : "num"}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {summary.certificates.by_status.issued ?? 0} certificates issued ({Math.round(summary.certificates.issued_kwh).toLocaleString()} kWh),{" "}
        {summary.certificates.by_status.quarantined ?? 0} quarantined by the AI check.
      </p>
    </section>
  );
}
