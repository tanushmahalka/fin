import { useEffect, useRef, useState } from "react";
import { monthName } from "../../shared/dates";
import type { MonthPoint } from "../../shared/forecast";
import { formatMoney } from "../../shared/money";

const H = 168;
const PAD = { top: 18, bottom: 26, x: 18 };

/**
 * Income and spending by month. Solid = complete months; dashed = the typical
 * month (pending months, still waiting on statements, and future ones). Hollow
 * dots on pending months show what's in the books so far.
 */
export function FlowChart({ points, selected, currency, onPick }: { points: MonthPoint[]; selected: string; currency: string; onPick: (m: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (points.length < 2) return null;

  const value = (p: MonthPoint, k: "income" | "expense") => (p.state === "actual" ? p[k] : (k === "income" ? p.projectedIncome : p.projectedExpense) ?? 0);
  const top = Math.max(1, ...points.flatMap((p) => [value(p, "income"), value(p, "expense"), p.income, p.expense]));
  const step = (w - PAD.x * 2) / (points.length - 1);
  const x = (i: number) => PAD.x + i * step;
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const lastActual = points.reduce((n, p, i) => (p.state === "actual" ? i : n), -1);

  const line = (k: "income" | "expense") => {
    const xy = points.map((p, i) => `${x(i).toFixed(1)},${y(value(p, k)).toFixed(1)}`);
    const solid = lastActual >= 0 ? xy.slice(0, lastActual + 1) : [];
    const dashed = xy.slice(Math.max(0, lastActual));
    const color = k === "income" ? "var(--income)" : "var(--expense)";
    return (
      <g key={k}>
        {solid.length > 1 && <polyline points={solid.join(" ")} fill="none" stroke={color} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />}
        {dashed.length > 1 && <polyline points={dashed.join(" ")} fill="none" stroke={color} strokeWidth={2} strokeDasharray="4 5" strokeLinecap="round" opacity={0.75} />}
        {points.map((p, i) =>
          p.state === "actual" ? (
            <circle key={p.month} cx={x(i)} cy={y(p[k])} r={p.month === selected ? 4.5 : 3} fill={color} />
          ) : (
            <g key={p.month}>
              <circle cx={x(i)} cy={y(value(p, k))} r={p.month === selected ? 4.5 : 3} fill="var(--surface)" stroke={color} strokeWidth={1.75} />
              {p.state === "pending" && <circle cx={x(i)} cy={y(p[k])} r={2.5} fill={color} opacity={0.45} />}
            </g>
          ),
        )}
      </g>
    );
  };

  const sel = points.findIndex((p) => p.month === selected);
  const fmt = (n: number) => formatMoney(n, { currency, compact: true });
  return (
    <div ref={box} className="flow-chart">
      <svg width={w} height={H} role="img" aria-label="Income and spending by month">
        {sel >= 0 && <rect x={x(sel) - step / 2} y={0} width={step} height={H - 4} rx={10} fill="var(--line)" />}
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.x} x2={w - PAD.x} y1={y(top * f)} y2={y(top * f)} stroke="var(--line)" />
            <text x={w - PAD.x} y={y(top * f) - 4} textAnchor="end" className="flow-tick">
              {fmt(top * f)}
            </text>
          </g>
        ))}
        {line("expense")}
        {line("income")}
        {points.map((p, i) => (
          <g key={p.month} className="flow-hit" onClick={() => onPick(p.month)}>
            <rect x={x(i) - step / 2} y={0} width={step} height={H} fill="transparent">
              <title>
                {`${monthName(p.month)} ${p.month.slice(0, 4)}${p.state === "projected" ? " · projected" : p.state === "pending" ? " · statements pending" : ""}\nIncome ${fmt(value(p, "income"))} · Spent ${fmt(value(p, "expense"))}`}
              </title>
            </rect>
            <text x={x(i)} y={H - 8} textAnchor="middle" className={`flow-month ${p.month === selected ? "on" : ""}`}>
              {monthName(p.month, true)}
            </text>
          </g>
        ))}
      </svg>
      <div className="flow-legend">
        <span><i style={{ background: "var(--income)" }} /> Income</span>
        <span><i style={{ background: "var(--expense)" }} /> Spending</span>
        <span className="faint">Dashed = typical month (projected or statements pending)</span>
      </div>
    </div>
  );
}
