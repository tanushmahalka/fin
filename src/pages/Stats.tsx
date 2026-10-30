import { ChevronLeft, ChevronRight, PieChart, Target } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { addDays, fiscalYear, monthLabel, monthOf, monthRange, today } from "../../shared/dates";
import { formatMoney } from "../../shared/money";
import { useSummary } from "../api";
import { MonthNav, useMonthParam } from "../components/MonthNav";
import { Empty, Segmented, Tile } from "../components/ui";
import { useEntity } from "../state";

export const PALETTE = ["#5b5bd6", "#e5484d", "#f5a524", "#12a594", "#0090ff", "#d6409f", "#8e4ec6", "#f76b15", "#30a46c", "#978365"];

export function Donut({ parts, total, label, currency }: { parts: { value: number; color: string }[]; total: number; label: string; currency: string }) {
  const r = 80;
  const c = 2 * Math.PI * r;
  const gap = parts.length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 200 200" width="200" height="200" style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle cx="100" cy="100" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="20" />
        {total > 0 &&
          parts.map((p, i) => {
            const len = (p.value / total) * c;
            const el = (
              <circle
                key={i}
                cx="100"
                cy="100"
                r={r}
                fill="none"
                stroke={p.color}
                strokeWidth="20"
                strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      <div className="donut-center">
        <span className="eyebrow">{label}</span>
        <span className="num" style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.035em" }}>
          {formatMoney(total, { currency, compact: true })}
        </span>
      </div>
    </div>
  );
}

export function StatsPage() {
  const { entity, byId, contactsById } = useEntity();
  const navigate = useNavigate();
  const [month, setMonth] = useMonthParam();
  const [period, setPeriod] = useState<"month" | "fy">("month");
  const [side, setSide] = useState<"expense" | "income">("expense");
  const [by, setBy] = useState<"category" | "contact">("category");
  const [fyAnchor, setFyAnchor] = useState(today());

  const fy = fiscalYear(fyAnchor, entity.fyStartMonth);
  const range = period === "month" ? monthRange(month) : { from: fy.from, to: fy.to };
  const summary = useSummary(entity.id, range.from, range.to);

  const byCategory = (summary.data?.byCategory ?? [])
    .filter((r) => byId.get(r.accountId)?.type === side && r.amount > 0)
    .map((r) => ({ key: r.accountId, amount: r.amount, name: byId.get(r.accountId)!.name, icon: byId.get(r.accountId)!.icon as React.ReactNode, link: `category=${r.accountId}` }));
  const sideTotal = byCategory.reduce((s, r) => s + r.amount, 0);
  const byContact = (summary.data?.byContact ?? [])
    .map((r) => ({ key: r.contactId, amount: side === "expense" ? r.expense : r.income, name: contactsById.get(r.contactId)?.name ?? "Unknown", icon: (contactsById.get(r.contactId)?.name[0] ?? "?") as React.ReactNode, link: `contact=${r.contactId}` }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const untagged = sideTotal - byContact.reduce((s, r) => s + r.amount, 0);
  const rows = (by === "category" ? byCategory : [...byContact, ...(untagged > 0 ? [{ key: "none", amount: untagged, name: "No contact", icon: "·" as React.ReactNode, link: "" }] : [])]).map(
    (r, i) => ({ ...r, color: r.key === "none" ? "var(--text-3)" : PALETTE[i % PALETTE.length] }),
  );
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const top = rows.slice(0, 8);
  const rest = rows.slice(8).reduce((s, r) => s + r.amount, 0);
  const parts = [...top.map((r) => ({ value: r.amount, color: r.color })), ...(rest ? [{ value: rest, color: "var(--text-3)" }] : [])];

  return (
    <main className="page">
      <div className="page-head">
        {period === "month" ? (
          <MonthNav month={month} onChange={setMonth} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <button className="icon-btn" aria-label="Previous year" onClick={() => setFyAnchor(addDays(fy.from, -1))}>
              <ChevronLeft />
            </button>
            <span className="h1" style={{ padding: "0 4px" }}>
              {fy.label}
            </span>
            <button className="icon-btn" aria-label="Next year" onClick={() => setFyAnchor(addDays(fy.to, 1))}>
              <ChevronRight />
            </button>
          </div>
        )}
        <div className="spacer" />
        <Link to="../budget" className="btn btn-ghost btn-sm hide-desktop">
          <Target /> Budget
        </Link>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        <Segmented
          label="Period"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "month", label: "Month" },
            { value: "fy", label: "Financial year" },
          ]}
        />
        <Segmented
          label="Show"
          value={side}
          onChange={setSide}
          options={[
            { value: "expense", label: "Expenses" },
            { value: "income", label: "Income" },
          ]}
        />
        <Segmented
          label="Group by"
          value={by}
          onChange={setBy}
          options={[
            { value: "category", label: "Category" },
            { value: "contact", label: "Contact" },
          ]}
        />
      </div>

      <div className="card card-pad">
        {total === 0 ? (
          <Empty icon={<PieChart />} title={`No ${side === "expense" ? "spending" : "income"} ${period === "month" ? `in ${monthLabel(month)}` : `in ${fy.label}`}`} />
        ) : (
          <div className="donut-wrap">
            <Donut parts={parts} total={total} label={side === "expense" ? "Spent" : "Received"} currency={entity.currency} />
            <div className="list" style={{ width: "100%" }}>
              {top.map((r) => (
                <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
                  <span className="legend-dot" style={{ background: r.color }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{r.name}</span>
                  <span className="faint num" style={{ fontSize: 12.5 }}>
                    {Math.round((r.amount / total) * 100)}%
                  </span>
                </div>
              ))}
              {rest > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
                  <span className="legend-dot" style={{ background: "var(--text-3)" }} />
                  <span style={{ flex: 1 }} className="muted">
                    Everything else
                  </span>
                  <span className="faint num" style={{ fontSize: 12.5 }}>
                    {Math.round((rest / total) * 100)}%
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <section className="section">
          <div className="card list">
            {rows.map((r) => (
              <button
                key={r.key}
                className="row"
                disabled={!r.link}
                onClick={() => navigate(`../transactions?${r.link}${period === "month" && month !== monthOf(today()) ? `&m=${month}` : ""}`)}
              >
                <Tile icon={r.icon} color={r.color} />
                <div className="row-main" style={{ gap: 7 }}>
                  <span className="row-title">{r.name}</span>
                  <div className="bar" style={{ height: 4 }}>
                    <i style={{ width: `${(r.amount / rows[0].amount) * 100}%`, background: r.color }} />
                  </div>
                </div>
                <div className="row-amount num">
                  {formatMoney(r.amount, { currency: entity.currency })}
                  <small>{((r.amount / total) * 100).toFixed(1)}%</small>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
