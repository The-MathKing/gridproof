export interface HourRow {
  time: string;
  hour: number;
  load_wh: number;
  matched_wh: number;
  intensity: number | null;
  surplus: boolean;
  emissions_g: number | null;
  emissions_if_all_grid_g: number | null;
}

export interface Buyer {
  key: string;
  name: string;
  address: string;
  profile: string;
  load_kwh: number;
  hourly_match: number;
  volumetric_claim: number;
  emissions_kg: number;
  emissions_if_all_grid_kg: number;
  shift_tokens: number;
  hourly?: HourRow[];
}

export interface Device {
  key: string;
  id: number;
  name: string;
  kind: "solar" | "wind";
  capacity_w: number;
  meter: string;
  owner: string;
  risk: { near_top_share: number; flagged_share: number };
}

export interface Eval {
  readings: number;
  fraudulent: number;
  precision: number;
  recall: number;
  false_positive_rate: number;
  by_type: Record<string, { total: number; caught: number }>;
  fake_wh_blocked: number;
  fake_wh_missed: number;
}

export interface Summary {
  metrics: { history: Eval; window: Eval; generated_at: string; days: number };
  devices: Device[];
  buyers: Buyer[];
  certificates: { by_status: Record<string, number>; issued_kwh: number };
  forecast_metrics: { mae_model: number; mae_persistence_24h: number; mae_neso_short_range: number; mean_intensity: number };
}

export interface Reading {
  device: string;
  time: string;
  hour: number;
  token_id: string;
  expected_wh: number;
  max_plausible_wh: number;
  reported_wh: number;
  anomaly_bps: number;
  reasons: string[];
  fraud_label: string;
  status: "none" | "issued" | "quarantined" | "released" | "rejected";
}

export interface Forecast {
  metrics: Summary["forecast_metrics"];
  hours: { time: string; model: number; neso: number | null; blend: number; surplus: boolean }[];
}

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const kwh = (wh: number) => `${(wh / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`;
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
