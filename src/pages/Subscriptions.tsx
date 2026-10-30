import { ChevronRight, Repeat } from "lucide-react";
import { useState } from "react";
import { monthName } from "../../shared/dates";
import { formatMoney } from "../../shared/money";
import { type Cadence, perMonth } from "../../shared/subscriptions";
import type { Subscription } from "../../shared/types";
import { useSubscriptions } from "../api";
import { Empty, Sheet, Skeleton, Tile } from "../components/ui";
import { useEntity } from "../state";

const day = (d: string) => `${Number(d.slice(8))} ${monthName(d.slice(0, 7), true)}`;
const every: Record<Cadence, string> = { weekly: "Weekly", monthly: "Monthly", quarterly: "Every 3 months", yearly: "Yearly" };
const per: Record<Cadence, string> = { weekly: "/wk", monthly: "/mo", quarterly: "/qtr", yearly: "/yr" };

export function SubscriptionsPage() {
  const { entity, byId } = useEntity();
  const subsQ = useSubscriptions(entity.id);
  const [open, setOpen] = useState<Subscription | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });

  const subs = subsQ.data ?? [];
  const cancelled = subs.filter((s) => s.cancelled);
  // Missed charges probably mean cancelled or moved: list them apart and keep them out of the total.
  const missed = subs.filter((s) => !s.cancelled && s.status === "missed");
  const running = subs.filter((s) => !s.cancelled && s.status !== "missed");
  const missedMonthly = missed.reduce((s, x) => s + x.monthly, 0);
  const monthly = running.reduce((s, x) => s + x.monthly, 0);
  const forOthers = running.filter((s) => s.forContactId).reduce((s, x) => s + x.monthly, 0);
  const catName = (id: string | null) => (id ? (byId.get(id)?.name ?? "Other") : "Not charged yet");
  const catIcon = (id: string | null) => (id ? (byId.get(id)?.icon ?? "•") : "⏳");
  const groups = [...new Set(running.map((s) => s.categoryId))]
    .map((id) => ({ id, list: running.filter((s) => s.categoryId === id).sort((a, b) => b.monthly - a.monthly) }))
    .map((g) => ({ ...g, total: g.list.reduce((s, x) => s + x.monthly, 0) }))
    .sort((a, b) => b.total - a.total);

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="h1">Subscriptions</h1>
        <div className="spacer" />
      </div>

      {subsQ.isLoading ? (
        <Skeleton />
      ) : subsQ.isError ? (
        <div className="card">
          <Empty icon={<Repeat />} title="Couldn't load subscriptions">
            {(subsQ.error as Error).message}
          </Empty>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-pad" style={{ paddingBottom: 14 }}>
              <span className="eyebrow">Recurring each month</span>
              <div className="big-number num" style={{ marginTop: 4 }}>
                {fmt(monthly)}
              </div>
              <div className="muted num" style={{ fontSize: 13, marginTop: 6 }}>
                {fmt(monthly * 12)} a year · {running.length} running
                {forOthers > 0 && ` · ${fmt(forOthers)}/mo paid for someone else`}
                {missedMonthly > 0 && ` · ${fmt(missedMonthly)}/mo more if the missed ones still run`}
              </div>
            </div>
            {groups.length > 1 && (
              <div className="card-pad sub-split" style={{ borderTop: "1px solid var(--line)" }}>
                {groups.map((g) => (
                  <div key={g.id ?? "none"}>
                    <span className="sub-cat">
                      <span aria-hidden="true">{catIcon(g.id)}</span>
                      {catName(g.id)}
                    </span>
                    <div className="bar" style={{ height: 4 }} aria-hidden="true">
                      <i style={{ width: `${monthly ? (g.total / monthly) * 100 : 0}%` }} />
                    </div>
                    <span className="num muted">{fmt(g.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {missed.length > 0 && (
            <section className="bs-group">
              <div className="section-head">
                <h3 className="h3">Didn't charge when expected</h3>
              </div>
              <p className="faint" style={{ fontSize: 12.5, margin: "-4px 0 8px" }}>
                Cancelled, failed or moved to another card? Open one to mark it.
              </p>
              <div className="card list">
                {missed.map((s) => (
                  <SubRow key={s.id} sub={s} onClick={() => setOpen(s)} />
                ))}
              </div>
            </section>
          )}

          {groups.map((g) => (
            <section key={g.id ?? "none"} className="bs-group">
              <div className="section-head">
                <h3 className="h3 sub-cat">
                  <span aria-hidden="true">{catIcon(g.id)}</span>
                  {catName(g.id)}
                </h3>
                <div className="spacer" />
                <span className="num muted" style={{ fontSize: 13, fontWeight: 500 }}>
                  {fmt(g.total)}/mo
                </span>
              </div>
              <div className="card list">
                {g.list.map((s) => (
                  <SubRow key={s.id} sub={s} onClick={() => setOpen(s)} />
                ))}
              </div>
            </section>
          ))}

          {!running.length && (
            <div className="card">
              <Empty icon={<Repeat />} title="Nothing tracked yet">
                Recurring charges show up here once they're identified.
              </Empty>
            </div>
          )}


          {cancelled.length > 0 && (
            <section className="section">
              <button className="btn btn-ghost btn-sm" onClick={() => setShowCancelled((v) => !v)}>
                {showCancelled ? "Hide" : "Show"} cancelled ({cancelled.length})
              </button>
              {showCancelled && (
                <div className="card list" style={{ marginTop: 8, opacity: 0.75 }}>
                  {cancelled.map((s) => (
                    <SubRow key={s.id} sub={s} onClick={() => setOpen(s)} />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      <SubSheet sub={open ? (subs.find((s) => s.id === open.id) ?? open) : null} onClose={() => setOpen(null)} />
    </main>
  );
}

function SubRow({ sub: s, onClick }: { sub: Subscription; onClick: () => void }) {
  const { entity, byId, contactsById } = useEntity();
  const account = s.accountId ? byId.get(s.accountId)?.name : null;
  const forWho = s.forContactId ? contactsById.get(s.forContactId)?.name : null;
  const when = s.cancelled ? "Cancelled" : s.status === "missed" ? `Expected ${s.nextDate ? day(s.nextDate) : "?"}` : s.nextDate ? `Next ${day(s.nextDate)}` : "No charge yet";
  return (
    <button className="row" onClick={onClick}>
      <Tile icon={(s.categoryId && byId.get(s.categoryId)?.icon) || "🔁"} />
      <div className="row-main">
        <span className="row-title">{s.name}</span>
        <span className="row-sub">
          {[every[s.cadence], account, when, forWho && `for ${forWho}`].filter(Boolean).join(" · ")}
          {s.priceChanged && s.lastAmount !== null && <span className="expense"> · now {formatMoney(s.lastAmount, { currency: entity.currency })}</span>}
        </span>
      </div>
      <div style={{ textAlign: "right", display: "grid", gap: 2 }}>
        <span className="row-amount num">
          {formatMoney(s.amount, { currency: entity.currency })}
          <span className="muted" style={{ fontWeight: 500 }}>{per[s.cadence]}</span>
        </span>
        {s.cadence !== "monthly" && !s.cancelled && (
          <span className="faint num" style={{ fontSize: 12.5 }}>
            {formatMoney(s.monthly, { currency: entity.currency })}/mo
          </span>
        )}
      </div>
      <ChevronRight size={16} className="faint" />
    </button>
  );
}


function SubSheet({ sub, onClose }: { sub: Subscription | null; onClose: () => void }) {
  const { entity, byId, contactsById } = useEntity();
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });
  if (!sub) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const facts: [string, string][] = [
    ["Charged to", sub.accountId ? (byId.get(sub.accountId)?.name ?? "—") : "—"],
    ["Category", sub.categoryId ? (byId.get(sub.categoryId)?.name ?? "—") : "From its charges"],
    ...(sub.forContactId ? [["Paid for", contactsById.get(sub.forContactId)?.name ?? "—"] as [string, string]] : []),
    ["Last charged", sub.lastDate ? `${day(sub.lastDate)} · ${fmt(sub.lastAmount ?? 0)}` : "Not yet"],
    ...(sub.nextDate && !sub.cancelled ? [[sub.status === "missed" ? "Was expected" : "Next charge", day(sub.nextDate)] as [string, string]] : []),
    ["Last 12 months", fmt(sub.lastYear)],
  ];
  return (
    <Sheet open onClose={onClose} title={sub.name}>
      <div className="sheet-body">
        <div className="form" style={{ gap: 18 }}>
          <div>
            <div className="big-number num" style={{ fontSize: 30 }}>
              {fmt(sub.amount)}
              <span className="muted" style={{ fontSize: 15, fontWeight: 500, letterSpacing: 0 }}> {every[sub.cadence].toLowerCase()}</span>
            </div>
            <div className="muted num" style={{ fontSize: 13, marginTop: 6 }}>
              {sub.cadence !== "monthly" && `${fmt(perMonth(sub.amount, sub.cadence))} a month · `}
              {fmt(perMonth(sub.amount, sub.cadence) * 12)} a year
              {sub.priceChanged && sub.lastAmount !== null && <span className="expense"> · last charge was {fmt(sub.lastAmount)}</span>}
            </div>
            {sub.note && <p className="muted" style={{ fontSize: 13.5, margin: "10px 0 0" }}>{sub.note}</p>}
          </div>
          <dl className="emi-facts">
            {facts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {sub.charges.length > 0 && (
            <div className="field">
              <span>Charges</span>
              <div className="sub-charges num">
                {sub.charges.map((c) => (
                  <div key={c.id}>
                    <span>
                      {day(c.date)} {c.date.slice(0, 4)}
                    </span>
                    <span className="faint">{byId.get(c.accountId)?.name}</span>
                    <span>{fmt(c.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
