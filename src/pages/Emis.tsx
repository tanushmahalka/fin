import { CalendarClock, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { monthName, today } from "../../shared/dates";
import { emiProjection } from "../../shared/emi";
import { formatMoney } from "../../shared/money";
import type { EmiPlan, Transaction } from "../../shared/types";
import { api, useEmis } from "../api";
import { ContactChip } from "../components/ContactPicker";
import { TxRow } from "../components/TxRow";
import { Empty, Sheet, Skeleton, Tile } from "../components/ui";
import { useActions, useEntity } from "../state";

const monthShort = (m: string) => `${monthName(m, true)} ${m.slice(2, 4)}`;
const monthLong = (m: string) => `${monthName(m)} ${m.slice(0, 4)}`;
const dayLabel = (d: string) =>
  `${Number(d.slice(8))} ${monthName(d.slice(0, 7), true)} ${d.slice(0, 4)}`;

export function EmisPage() {
  const { entity, byId } = useEntity();
  const emis = useEmis(entity.id);
  const [open, setOpen] = useState<EmiPlan | null>(null);
  const [showDone, setShowDone] = useState(false);
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });

  const plans = emis.data ?? [];
  const active = plans.filter((p) => !p.done);
  const done = plans.filter((p) => p.done);
  const monthly = active.reduce((s, p) => s + p.instalment, 0);
  const toPay = active.reduce((s, p) => s + p.toPay, 0);
  const lastMonth = active.reduce<string | null>(
    (m, p) => (p.lastMonth && (!m || p.lastMonth > m) ? p.lastMonth : m),
    null,
  );
  const firstDue = active.reduce<string>(
    (m, p) => (p.nextMonth && p.nextMonth < m ? p.nextMonth : m),
    "9999-12",
  );
  const projection = emiProjection(
    active,
    firstDue < "9999-12" ? firstDue : today().slice(0, 7),
    36,
  );
  const peak = Math.max(1, ...projection.map((m) => m.total));
  const unknownEnd = active.some((p) => p.monthsLeftEstimated);

  // Group by the account the instalments come out of: "which card is this on?"
  const groups = [...new Set(active.map((p) => p.accountId))]
    .map((id) => ({
      id,
      account: byId.get(id),
      plans: active.filter((p) => p.accountId === id),
    }))
    .sort(
      (a, b) =>
        b.plans.reduce((s, p) => s + p.instalment, 0) -
        a.plans.reduce((s, p) => s + p.instalment, 0),
    );

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="h1">EMIs</h1>
        <div className="spacer" />
      </div>

      {emis.isLoading ? (
        <Skeleton />
      ) : emis.isError ? (
        <div className="card">
          <Empty icon={<CalendarClock />} title="Couldn't load your EMIs">
            {(emis.error as Error).message}
          </Empty>
        </div>
      ) : !active.length && !done.length ? (
        <div className="card">
          <Empty icon={<CalendarClock />} title="No EMIs">
            Purchases you convert to EMI and loans you repay monthly show up
            here, with what's left and when each one ends.
          </Empty>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-pad" style={{ paddingBottom: 14 }}>
              <span className="eyebrow">Paying each month</span>
              <div className="big-number num" style={{ marginTop: 4 }}>
                {fmt(monthly)}
              </div>
              <div className="muted num" style={{ fontSize: 13, marginTop: 6 }}>
                {active.length} running · {fmt(toPay)} still to pay
                {lastMonth && !unknownEnd
                  ? ` · all done by ${monthLong(lastMonth)}`
                  : ""}
              </div>
            </div>
            {projection.length > 1 && (
              <div
                className="card-pad"
                style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}
              >
                <div
                  className="emi-chart"
                  role="img"
                  aria-label="EMIs due each month"
                >
                  {projection.map((m, i) => {
                    const changed =
                      i === 0 || m.total !== projection[i - 1].total;
                    return (
                      <div
                        key={m.month}
                        className="emi-col"
                        title={`${monthLong(m.month)}: ${fmt(m.total)}`}
                      >
                        <span className="emi-col-amt num">
                          {changed && m.total
                            ? formatMoney(m.total, {
                                compact: true,
                                currency: entity.currency,
                              })
                            : ""}
                        </span>
                        <i style={{ height: `${(m.total / peak) * 100}%` }} />
                        <span className="emi-col-month">
                          {i === 0 || m.month.endsWith("-01")
                            ? monthShort(m.month)
                            : monthName(m.month, true)[0]}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p
                  className="faint"
                  style={{ fontSize: 12.5, margin: "10px 0 0" }}
                >
                  Each step down is an EMI ending and that money freeing up.
                  {unknownEnd &&
                    " Loans without a known end date are estimated from what's left."}
                </p>
              </div>
            )}
          </div>

          {groups.map(({ id, account, plans: list }) => (
            <section key={id} className="bs-group">
              <div className="section-head">
                <h3 className="h3">{account?.name ?? "…"}</h3>
                <div className="spacer" />
                <span
                  className="num muted"
                  style={{ fontSize: 13, fontWeight: 500 }}
                >
                  {fmt(list.reduce((s, p) => s + p.instalment, 0))}/mo
                </span>
              </div>
              <div className="card list">
                {list.map((p) => (
                  <PlanRow key={p.id} plan={p} onClick={() => setOpen(p)} />
                ))}
              </div>
            </section>
          ))}

          {done.length > 0 && (
            <section className="section">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowDone((s) => !s)}
              >
                {showDone ? "Hide" : "Show"} finished ({done.length})
              </button>
              {showDone && (
                <div
                  className="card list"
                  style={{ marginTop: 8, opacity: 0.75 }}
                >
                  {done.map((p) => (
                    <PlanRow key={p.id} plan={p} onClick={() => setOpen(p)} />
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      <PlanSheet plan={open} onClose={() => setOpen(null)} />
    </main>
  );
}

function progressText(p: EmiPlan) {
  if (p.done) return p.months ? `All ${p.months} paid` : "Paid off";
  const of =
    p.months && p.paid !== null
      ? `${p.paid} of ${p.months} paid`
      : `≈${p.monthsLeft} months left`;
  return `${of} · ends ${p.lastMonth ? monthShort(p.lastMonth) : "?"}`;
}

function PlanRow({ plan: p, onClick }: { plan: EmiPlan; onClick: () => void }) {
  const { entity, contactsById } = useEntity();
  const person = p.contactId ? contactsById.get(p.contactId) : undefined;
  const share = p.months && p.paid !== null ? p.paid / p.months : null;
  return (
    <button
      className="row"
      onClick={onClick}
      style={{ alignItems: "flex-start" }}
    >
      {person ? <ContactChip contact={person} size={36} /> : <Tile icon="🧾" />}
      <div className="row-main" style={{ gap: 6 }}>
        <span className="row-title">{p.title}</span>
        <span className="row-sub">
          {[p.merchant, progressText(p)].filter(Boolean).join(" · ")}
        </span>
        {share !== null && !p.done && (
          <div className="bar" style={{ height: 4 }} aria-hidden="true">
            <i style={{ width: `${share * 100}%` }} />
          </div>
        )}
      </div>
      <div style={{ textAlign: "right", display: "grid", gap: 2 }}>
        <span className="row-amount num">
          {formatMoney(p.instalment, { currency: entity.currency })}/mo
        </span>
        {!p.done && (
          <span className="faint num" style={{ fontSize: 12.5 }}>
            {formatMoney(p.toPay, { currency: entity.currency, compact: true })}{" "}
            to pay
          </span>
        )}
      </div>
      <ChevronRight
        size={16}
        className="faint"
        style={{ alignSelf: "center" }}
      />
    </button>
  );
}

function PlanSheet({
  plan,
  onClose,
}: {
  plan: EmiPlan | null;
  onClose: () => void;
}) {
  const { entity, byId, contactsById } = useEntity();
  const { compose } = useActions();
  const [purchase, setPurchase] = useState<Transaction | null>(null);
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });

  useEffect(() => {
    setPurchase(null);
    if (plan?.purchaseTxId)
      api<{ transaction: Transaction }>(
        `/entities/${entity.id}/transactions/${plan.purchaseTxId}`,
      )
        .then((r) => setPurchase(r.transaction))
        .catch(() => setPurchase(null));
  }, [plan?.id, plan?.purchaseTxId, plan?.title, plan?.evidence, entity.id]);

  if (!plan)
    return (
      <Sheet open={false} onClose={onClose}>
        {null}
      </Sheet>
    );
  const account = byId.get(plan.accountId);
  const person = plan.contactId ? contactsById.get(plan.contactId) : undefined;
  const details: [string, React.ReactNode][] = [
    [
      "Billed to",
      account ? (
        <Link to={`../accounts/${account.id}`} onClick={onClose}>
          {account.name}
        </Link>
      ) : (
        "—"
      ),
    ],
    ...(plan.merchant
      ? [["Bought from", plan.merchant] as [string, string]]
      : []),
    ...(person
      ? [
          [
            "For",
            <Link key="p" to={`../contacts/${person.id}`} onClick={onClose}>
              {person.name}
            </Link>,
          ] as [string, React.ReactNode],
        ]
      : []),
    ...(plan.firstDue
      ? [["First instalment", dayLabel(plan.firstDue)] as [string, string]]
      : []),
    ...(plan.evidence ? [["Receipt", plan.evidence] as [string, string]] : []),
  ];
  const share =
    plan.months && plan.paid !== null
      ? plan.paid / plan.months
      : plan.done
        ? 1
        : null;
  const stats: [string, string][] = [
    ["Still to pay", plan.done ? "—" : fmt(plan.toPay)],
    [
      "Principal owed",
      plan.done ? "—" : `${plan.leftEstimated ? "≈" : ""}${fmt(plan.left)}`,
    ],
    ["Converted", plan.principal ? fmt(plan.principal) : "—"],
  ];


  return (
    <Sheet
      open={!!plan}
      onClose={onClose}
      title={plan.title}
    >
      <div className="sheet-body">
        {(
          <div className="form" style={{ gap: 18 }}>
            <div>
              <div className="big-number num" style={{ fontSize: 30 }}>
                {fmt(plan.instalment)}
                <span
                  className="muted"
                  style={{ fontSize: 15, fontWeight: 500, letterSpacing: 0 }}
                >
                  {" "}
                  a month
                </span>
              </div>
              {share !== null && (
                <div
                  className="bar"
                  style={{ marginTop: 12 }}
                  aria-hidden="true"
                >
                  <i style={{ width: `${share * 100}%` }} />
                </div>
              )}
              <div className="muted num" style={{ fontSize: 13, marginTop: 8 }}>
                {progressText(plan)}
              </div>
            </div>

            <div className="emi-stats">
              {stats.map(([k, v]) => (
                <div key={k}>
                  <span className="eyebrow">{k}</span>
                  <span className="num">{v}</span>
                </div>
              ))}
            </div>

            <dl className="emi-facts">
              {details.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>

            {purchase && (
              <div className="field">
                <span>The purchase</span>
                <div className="card list">
                  <TxRow
                    tx={purchase}
                    showDate
                    onClick={() => compose({ tx: purchase })}
                  />
                </div>
              </div>
            )}
            {plan.leftEstimated && !plan.done && (
              <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>
                The card's balance already includes this EMI, so the principal
                owed is worked out from the schedule.
              </p>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

