import { useMemo, useRef, useState, type ReactNode } from "react";
import { fmtTime, kwh, pct, type HourRow } from "./api";

const londonParts = (iso: string) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" });
  const hour = Number(d.toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" })) % 24;
  return { day, hour };
};

const SEQ = ["--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5", "--seq-6", "--seq-7"];
const seqColor = (x: number) => `var(${SEQ[Math.min(SEQ.length - 1, Math.floor(x * SEQ.length))]})`;

function useTooltip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const show = (e: React.MouseEvent, content: ReactNode) => {
    const box = ref.current!.getBoundingClientRect();
    const x = e.clientX - box.left;
    setTip({ x: Math.min(x + 12, box.width - 200), y: e.clientY - box.top + 14, content });
  };
  const node = tip && (
    <div className="tooltip" style={{ left: Math.max(0, tip.x), top: tip.y }}>
      {tip.content}
    </div>
  );
  return { ref, show, hide: () => setTip(null), node };
}

/** Day x hour grid of how much load was matched with same-hour clean energy. */
export function MatchHeatmap({ rows }: { rows: HourRow[] }) {
  const tt = useTooltip();
  const days = useMemo(() => {
    const map = new Map<string, (HourRow | undefined)[]>();
    for (const r of rows) {
      const { day, hour } = londonParts(r.time);
      if (!map.has(day)) map.set(day, Array(24).fill(undefined));
      map.get(day)![hour] = r;
    }
    return [...map.entries()];
  }, [rows]);

  const labelW = 92, cell = 26, gap = 2, top = 18;
  const W = labelW + 24 * cell, H = top + days.length * cell;

  return (
    <div className="chart-wrap" ref={tt.ref}>
      <svg className="chart" viewBox={`0 0 ${W} ${H + 4}`} role="img" aria-label="Hourly clean energy match by day and hour">
        {[0, 6, 12, 18, 23].map((h) => (
          <text key={h} x={labelW + h * cell + cell / 2} y={12} textAnchor="middle">
            {String(h).padStart(2, "0")}:00
          </text>
        ))}
        {days.map(([day, hours], i) => (
          <g key={day}>
            <text x={labelW - 8} y={top + i * cell + cell / 2 + 4} textAnchor="end">
              {day}
            </text>
            {hours.map((r, h) => {
              const m = r && r.load_wh ? r.matched_wh / r.load_wh : 0;
              return (
                <g key={h}>
                  <rect
                    x={labelW + h * cell + gap / 2}
                    y={top + i * cell + gap / 2}
                    width={cell - gap}
                    height={cell - gap}
                    rx={4}
                    fill={!r ? "transparent" : m === 0 ? "var(--seq-0)" : seqColor(m)}
                    onMouseMove={(e) =>
                      r &&
                      tt.show(
                        e,
                        <>
                          <b>{fmtTime(r.time)}</b>
                          <span>Hourly match: {pct(m)}</span>
                          <span className="muted">
                            {kwh(r.matched_wh)} clean of {kwh(r.load_wh)} used
                          </span>
                          {r.intensity != null && <span className="muted">Grid: {Math.round(r.intensity)} gCO₂/kWh</span>}
                          {r.surplus && <span>Surplus hour (GSHIFT bonus)</span>}
                        </>,
                      )
                    }
                    onMouseLeave={tt.hide}
                  />
                  {r?.surplus && (
                    <circle cx={labelW + h * cell + cell - 6} cy={top + i * cell + 6} r={2.2} fill="var(--text-primary)" pointerEvents="none" />
                  )}
                </g>
              );
            })}
          </g>
        ))}
      </svg>
      <div className="legend">
        <span>
          0%
          {SEQ.map((s) => (
            <i key={s} className="swatch" style={{ background: `var(${s})`, borderRadius: 2 }} />
          ))}
          100% matched
        </span>
        <span>
          <svg width="8" height="8"><circle cx="4" cy="4" r="2.5" fill="var(--text-primary)" /></svg>
          Surplus hour
        </span>
        <span className="muted">Times are UK local</span>
      </div>
      {tt.node}
    </div>
  );
}

/** Load vs clean energy matched in the same hour, one bar per hour. */
export function HourlyBars({ rows }: { rows: HourRow[] }) {
  const tt = useTooltip();
  const W = 900, H = 200, padL = 46, padB = 22, padT = 8;
  const max = Math.max(1, ...rows.map((r) => r.load_wh));
  const bw = (W - padL) / rows.length;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => f * max);

  return (
    <div className="chart-wrap" ref={tt.ref}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Hourly load and matched clean energy">
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={padL} x2={W} y1={y(t)} y2={y(t)} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end">
              {Math.round(t / 1000)} kWh
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = padL + i * bw;
          const { hour } = londonParts(r.time);
          return (
            <g
              key={r.hour}
              onMouseMove={(e) =>
                tt.show(
                  e,
                  <>
                    <b>{fmtTime(r.time)}</b>
                    <span>Used: {kwh(r.load_wh)}</span>
                    <span>Clean, same hour: {kwh(r.matched_wh)}</span>
                    <span className="muted">Match {pct(r.load_wh ? r.matched_wh / r.load_wh : 0)}</span>
                  </>,
                )
              }
              onMouseLeave={tt.hide}
            >
              <rect x={x} y={padT} width={bw} height={H - padT - padB} fill="transparent" />
              <rect x={x + 0.5} y={y(r.load_wh)} width={Math.max(1, bw - 1)} height={y(0) - y(r.load_wh)} fill="var(--neutral-mark)" />
              {r.matched_wh > 0 && (
                <rect x={x + 0.5} y={y(r.matched_wh)} width={Math.max(1, bw - 1)} height={y(0) - y(r.matched_wh)} fill="var(--series-1)" />
              )}
              {hour === 0 && (
                <text x={x} y={H - 6}>
                  {londonParts(r.time).day}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span><i className="swatch" style={{ background: "var(--series-1)" }} /> Matched with same-hour clean energy</span>
        <span><i className="swatch" style={{ background: "var(--neutral-mark)" }} /> Total use (rest comes from the grid)</span>
      </div>
      {tt.node}
    </div>
  );
}

interface LineSeries {
  name: string;
  color: string;
  values: (number | null)[];
}

/** Line chart over hourly timestamps with optional shaded hours and a crosshair tooltip. */
export function LineChart({
  times,
  series,
  shade,
  unit,
  shadeLabel,
}: {
  times: string[];
  series: LineSeries[];
  shade?: boolean[];
  unit: string;
  shadeLabel?: string;
}) {
  const tt = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const W = 900, H = 220, padL = 46, padB = 22, padT = 10;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const max = Math.max(1, ...all) * 1.08;
  const n = times.length;
  const x = (i: number) => padL + ((W - padL - 4) * i) / Math.max(1, n - 1);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const step = (W - padL) / Math.max(1, n - 1);
  const ticks = [0, max / 2, max].map((t) => Math.round(t / 10) * 10);

  const path = (vals: (number | null)[]) =>
    vals.reduce((acc, v, i) => (v == null ? acc : acc + `${acc && vals[i - 1] != null ? "L" : "M"}${x(i)},${y(v)}`), "");

  return (
    <div className="chart-wrap" ref={tt.ref}>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={series.map((s) => s.name).join(", ")}
        onMouseLeave={() => {
          setHover(null);
          tt.hide();
        }}
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          const i = Math.max(0, Math.min(n - 1, Math.round((px - padL) / step)));
          setHover(i);
          tt.show(
            e,
            <>
              <b>{fmtTime(times[i])}</b>
              {series.map((s) => (
                <span key={s.name}>
                  <i className="swatch line" style={{ background: s.color, marginRight: 6 }} />
                  {s.name}: {s.values[i] == null ? "–" : `${Math.round(s.values[i]!)} ${unit}`}
                </span>
              ))}
              {shade?.[i] && <span className="muted">{shadeLabel}</span>}
            </>,
          );
        }}
      >
        {shade?.map((s, i) =>
          s ? <rect key={i} x={x(i) - step / 2} y={padT} width={step} height={H - padT - padB} fill="var(--surface-2)" /> : null,
        )}
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={padL} x2={W} y1={y(t)} y2={y(t)} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {times.map((t, i) =>
          londonParts(t).hour === 0 ? (
            <text key={t} x={x(i)} y={H - 6}>
              {londonParts(t).day}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
        ))}
        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--text-muted)" strokeDasharray="3 3" />
            {series.map((s) =>
              s.values[hover] == null ? null : (
                <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />
              ),
            )}
          </>
        )}
      </svg>
      <div className="legend">
        {series.length > 1 &&
          series.map((s) => (
            <span key={s.name}>
              <i className="swatch line" style={{ background: s.color }} /> {s.name}
            </span>
          ))}
        {shade && (
          <span>
            <i className="swatch" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }} /> {shadeLabel}
          </span>
        )}
        <span className="muted">{unit}</span>
      </div>
      {tt.node}
    </div>
  );
}
