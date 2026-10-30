import { Inbox, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  addDays,
  daysInMonth,
  fiscalMonths,
  fiscalYear,
  monthName,
  monthOf,
  monthRange,
  today,
  WEEKDAY_NAMES,
  weekdayIndex,
  weekdayName,
} from "../../shared/dates";
import { formatMoney } from "../../shared/money";
import type { Transaction } from "../../shared/types";
import { useEmis, useImports, useInfiniteTransactions, useMonthly, useSubscriptions, useSummary, useTransactions } from "../api";
import { FlowChart } from "../components/FlowChart";
import { completeThrough, forecast, monthSeries } from "../../shared/forecast";
import { addMonths } from "../../shared/dates";
import { LoadMore } from "../components/LoadMore";
import { MonthNav, useMonthParam } from "../components/MonthNav";
import { TxRow } from "../components/TxRow";
import { Empty, Money, Segmented, Skeleton, Tile } from "../components/ui";
import { useActions, useEntity } from "../state";

type View = "daily" | "calendar" | "monthly";

function totals(txs: Transaction[]) {
  let income = 0;
  let expense = 0;
  for (const t of txs) {
    if (t.kind === "income") income += t.amount;
    if (t.kind === "expense") expense += t.amount;
  }
  return { income, expense };
}

function groupByDay(txs: Transaction[]) {
  const map = new Map<string, Transaction[]>();
  for (const t of txs) map.set(t.date, [...(map.get(t.date) ?? []), t]);
  return [...map.entries()];
}

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function TransactionsPage() {
  const { entity, byId, contactsById, canEdit } = useEntity();
  const { compose } = useActions();
  const [month, setMonth] = useMonthParam();
  const [params, setParams] = useSearchParams();
  const view = (["daily", "calendar", "monthly"].includes(params.get("view") ?? "") ? params.get("view") : "daily") as View;
  const categoryId = params.get("category");
  const accountId = params.get("account");
  const contactId = params.get("contact");
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim());
  const searching = searchOpen && query.length > 0;

  const range = monthRange(month);
  const filters = { categoryId: categoryId ?? undefined, accountId: accountId ?? undefined, contactId: contactId ?? undefined };
  // Calendar needs just the month; the daily list is endless: from the chosen month back to the first transaction.
  const txs = useTransactions(entity.id, { ...range, ...filters }, view === "calendar" && !searching);
  const feed = useInfiniteTransactions(entity.id, searching ? { q: query } : { to: range.to, ...filters }, view === "daily" || searching);
  const feedRows = useMemo(() => feed.data?.pages.flatMap((p) => p.transactions) ?? [], [feed.data]);
  const monthTxs = feedRows.filter((t) => t.date >= range.from && t.date <= range.to);
  const summary = useSummary(entity.id, range.from, range.to);
  const filtered = !!(categoryId || accountId || contactId);
  const list = view === "calendar" ? (txs.data ?? []) : searching ? feedRows : monthTxs;
  const sums = filtered || searching ? totals(list) : { income: summary.data?.income ?? 0, expense: summary.data?.expense ?? 0 };
  // Chart window: a few months back, a couple ahead, always including the month in view.
  const thisMonth = monthOf(today());
  const imports = useImports(entity.id);
  const allMonths = useMonthly(entity.id, "1900-01-01", "2999-12-31");
  const coverage = useMemo(() => {
    const last = new Map<string, string>();
    for (const i of imports.data ?? []) if (i.status === "committed" && (last.get(i.accountId) ?? "") < i.period.to) last.set(i.accountId, i.period.to);
    return completeThrough([...last.values()]);
  }, [imports.data]);
  const totalsByMonth = allMonths.data ?? [];
  const chartEnd = [addMonths(month, 2), addMonths(thisMonth, 2)].sort()[month < addMonths(thisMonth, -6) ? 0 : 1];
  const firstData = totalsByMonth.find((m) => m.income || m.expense)?.month ?? thisMonth;
  const chartStart = [addMonths(chartEnd, -8), firstData].sort()[1];
  const series = monthSeries(totalsByMonth, coverage, thisMonth, chartStart, chartEnd);
  const point = monthSeries(totalsByMonth, coverage, thisMonth, month, month)[0];
  const typical = forecast(totalsByMonth, coverage);
  const projecting = !filtered && !searching && point.state !== "actual";
  const feedProps = { pages: feedRows, loading: feed.isLoading, hasMore: !!feed.hasNextPage, fetching: feed.isFetchingNextPage, onMore: () => feed.fetchNextPage(), byMonth: !searching, filtered };

  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (value) n.set(key, value);
        else n.delete(key);
        return n;
      },
      { replace: true },
    );

  const filterContact = contactId ? contactsById.get(contactId) : undefined;
  const filterAccount = (categoryId && byId.get(categoryId)) || (accountId && byId.get(accountId)) || (filterContact ? { icon: "👤", name: filterContact.name } : null);

  return (
    <main className="page">
      <div className="page-head">
        {searchOpen ? (
          <div className="smart" style={{ flex: 1, background: "var(--surface)" }}>
            <Search />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search notes, categories, accounts"
              aria-label="Search transactions"
              onKeyDown={(e) => e.key === "Escape" && (setSearchOpen(false), setQ(""))}
            />
            <button
              className="icon-btn"
              aria-label="Close search"
              onClick={() => {
                setSearchOpen(false);
                setQ("");
              }}
            >
              <X />
            </button>
          </div>
        ) : (
          <>
            <MonthNav month={month} onChange={setMonth} />
            <div className="spacer" />
            <button className="icon-btn" aria-label="Search" onClick={() => setSearchOpen(true)}>
              <Search />
            </button>
            {canEdit && (
              <button className="btn btn-primary hide-mobile" onClick={() => compose()}>
                <Plus /> Add
              </button>
            )}
          </>
        )}
      </div>


      {filterAccount && !searching && (
        <div className="chips" style={{ marginBottom: 12 }}>
          <button className="chip" aria-pressed onClick={() => (setParam("category", null), setParam("account", null), setParam("contact", null))}>
            {filterAccount.icon} {filterAccount.name} <X size={14} />
          </button>
        </div>
      )}

      {!searching && !filtered && series.length > 1 && (
        <div className="card card-pad" style={{ marginBottom: 14, paddingBottom: 10 }}>
          <FlowChart points={series} selected={month} currency={entity.currency} onPick={setMonth} />
        </div>
      )}

      <div className="card stats">
        <div className="stat">
          <span className="eyebrow">{projecting ? "Income · typical" : "Income"}</span>
          <Money className="stat-value" value={projecting ? point.projectedIncome! : sums.income} currency={entity.currency} tone="income" />
        </div>
        <div className="stat">
          <span className="eyebrow">{projecting ? "Spending · typical" : "Expenses"}</span>
          <Money className="stat-value" value={projecting ? point.projectedExpense! : sums.expense} currency={entity.currency} tone="expense" />
        </div>
        <div className="stat">
          <span className="eyebrow">Net</span>
          <Money
            className="stat-value"
            value={projecting ? point.projectedIncome! - point.projectedExpense! : sums.income - sums.expense}
            currency={entity.currency}
            sign="always"
          />
        </div>
      </div>
      {projecting && (
        <p className="faint" style={{ fontSize: 12.5, margin: "8px 2px 0" }}>
          {point.state === "pending"
            ? `Statements for ${monthName(month)} aren't all in yet: so far ${formatMoney(sums.income, { currency: entity.currency })} in, ${formatMoney(sums.expense, { currency: entity.currency })} out. `
            : ""}
          Typical month = the median of {typical.basis.map((m) => monthName(m, true)).join(", ") || "your complete months"}
          {coverage ? `; books are complete to ${Number(coverage.slice(8))} ${monthName(coverage.slice(0, 7), true)}.` : "."}
        </p>
      )}

      {!searching && (
        <div style={{ margin: "18px 0 4px" }}>
          <Segmented
            label="View"
            value={view}
            onChange={(v) => setParam("view", v === "daily" ? null : v)}
            options={[
              { value: "daily", label: "Daily" },
              { value: "calendar", label: "Calendar" },
              { value: "monthly", label: "Monthly" },
            ]}
          />
        </div>
      )}

      {searching ? (
        <Feed {...feedProps} empty={<Empty icon={<Search />} title="No matches">Try a category, account or a word from the note.</Empty>} />
      ) : point.state === "projected" && view === "daily" ? (
        <Scheduled month={month} />
      ) : view === "calendar" ? (
        <Calendar month={month} txs={list} />
      ) : view === "monthly" ? (
        <Monthly month={month} onPick={(m) => (setMonth(m), setParam("view", null))} />
      ) : (
        <Feed
          {...feedProps}
          empty={
            <Empty
              icon={<Inbox />}
              title={`Nothing in ${monthName(month)} yet`}
              action={
                canEdit ? (
                  <button className="btn btn-secondary" onClick={() => compose()}>
                    <Plus /> Add a transaction
                  </button>
                ) : undefined
              }
            >
              {canEdit ? "Press N, or type it in plain words with /." : "Transactions added by the team show up here."}
            </Empty>
          }
        />
      )}
    </main>
  );
}

/**
 * Every transaction, newest first, grouped by month then day, loading older
 * pages as you scroll. Month headers carry that month's income and spending.
 */
function Feed({
  pages,
  loading,
  hasMore,
  fetching,
  onMore,
  byMonth,
  filtered,
  empty,
}: {
  pages: Transaction[];
  loading: boolean;
  hasMore: boolean;
  fetching: boolean;
  onMore: () => void;
  byMonth: boolean;
  filtered: boolean;
  empty: React.ReactNode;
}) {
  const { entity } = useEntity();
  const monthly = useMonthly(entity.id, "1900-01-01", "2999-12-31");
  const reported = new Map((monthly.data ?? []).map((m) => [m.month, m]));
  if (loading) return <div style={{ marginTop: 16 }}><Skeleton rows={5} /></div>;
  if (!pages.length) return <div className="card" style={{ marginTop: 16 }}>{empty}</div>;
  const months = new Map<string, Transaction[]>();
  for (const t of pages) {
    const m = byMonth ? monthOf(t.date) : "all";
    months.set(m, [...(months.get(m) ?? []), t]);
  }
  const fmt = (n: number, sign: "auto" | "always" = "auto") => formatMoney(n, { currency: entity.currency, sign, compact: true });
  return (
    <div>
      {[...months.entries()].map(([m, txs]) => {
        // Unfiltered: the month's real totals; filtered: totals of what's shown.
        const t = !filtered && reported.get(m) ? reported.get(m)! : totals(txs);
        return (
          <section key={m}>
            {byMonth && (
              <div className="month-head">
                <h2 className="h2">
                  {monthName(m)} {m.slice(0, 4)}
                </h2>
                <span className="num">
                  {t.income > 0 && <span className="income">{fmt(t.income, "always")}</span>}
                  {t.expense > 0 && <span className="expense">{fmt(-t.expense)}</span>}
                </span>
              </div>
            )}
            <Daily txs={txs} />
          </section>
        );
      })}
      <LoadMore onMore={onMore} hasMore={hasMore} loading={fetching} />
    </div>
  );
}

function Daily({ txs }: { txs: Transaction[] }) {
  const { entity } = useEntity();
  const { compose } = useActions();
  const now = today();
  return (
    <div>
      {groupByDay(txs).map(([date, items]) => {
        const t = totals(items);
        return (
          <section key={date} className="day" aria-label={date}>
            <div className="day-head">
              <span className="day-num num">{Number(date.slice(8))}</span>
              <span className="day-meta">
                <b>{date === now ? "Today" : date === addDays(now, -1) ? "Yesterday" : weekdayName(date)}</b>
                <span className="faint">
                  {monthName(monthOf(date), true)} {date.slice(0, 4)}
                </span>
              </span>
              <span className="day-totals num">
                {t.income > 0 && <span className="income">{formatMoney(t.income, { currency: entity.currency, sign: "always" })}</span>}
                {t.expense > 0 && <span className="expense">{formatMoney(-t.expense, { currency: entity.currency })}</span>}
              </span>
            </div>
            <div className="card list">
              {items.map((tx) => (
                <TxRow key={tx.id} tx={tx} onClick={() => compose({ tx })} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Calendar({ month, txs }: { month: string; txs: Transaction[] }) {
  const { entity } = useEntity();
  const { compose } = useActions();
  const now = today();
  const [selected, setSelected] = useState<string>(monthOf(now) === month ? now : `${month}-01`);
  useEffect(() => setSelected(monthOf(now) === month ? now : `${month}-01`), [month, now]);

  const byDay = useMemo(() => {
    const m = new Map<string, { income: number; expense: number }>();
    for (const t of txs) {
      const d = m.get(t.date) ?? { income: 0, expense: 0 };
      if (t.kind === "income") d.income += t.amount;
      if (t.kind === "expense") d.expense += t.amount;
      m.set(t.date, d);
    }
    return m;
  }, [txs]);

  const lead = weekdayIndex(`${month}-01`);
  const days = daysInMonth(month);
  const cells = [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency, compact: true, bare: true });
  const dayTx = txs.filter((t) => t.date === selected);

  return (
    <>
      <div className="card" style={{ marginTop: 16, overflow: "hidden" }}>
        <div className="cal">
          {WEEKDAY_NAMES.map((d) => (
            <div key={d} className="cal-dow">
              {d}
            </div>
          ))}
          {cells.map((date, i) =>
            date ? (
              <button
                key={date}
                className={`cal-cell ${date === now ? "today" : ""}`}
                aria-pressed={date === selected}
                aria-label={date}
                onClick={() => setSelected(date)}
                onDoubleClick={() => compose({ draft: { date } })}
              >
                <span className="d num">{Number(date.slice(8))}</span>
                {byDay.get(date)?.income ? <span className="income num">{fmt(byDay.get(date)!.income)}</span> : null}
                {byDay.get(date)?.expense ? <span className="expense num">{fmt(byDay.get(date)!.expense)}</span> : null}
              </button>
            ) : (
              <div key={`x${i}`} className="cal-cell out" />
            ),
          )}
        </div>
      </div>
      <div className="section-head" style={{ marginTop: 18 }}>
        <h3 className="h3">
          {weekdayName(selected)}, {Number(selected.slice(8))} {monthName(month)}
        </h3>
      </div>
      <div className="card list">
        {dayTx.length ? (
          dayTx.map((tx) => <TxRow key={tx.id} tx={tx} onClick={() => compose({ tx })} />)
        ) : (
          <p className="muted" style={{ margin: 0, padding: "18px 16px" }}>
            Nothing on this day.
          </p>
        )}
      </div>
    </>
  );
}

function Monthly({ month, onPick }: { month: string; onPick: (m: string) => void }) {
  const { entity } = useEntity();
  const fy = fiscalYear(`${month}-01`, entity.fyStartMonth);
  const data = useMonthly(entity.id, fy.from, fy.to);
  const months = fiscalMonths(`${month}-01`, entity.fyStartMonth);
  const byMonth = new Map((data.data ?? []).map((m) => [m.month, m]));
  const total = (data.data ?? []).reduce((s, m) => ({ income: s.income + m.income, expense: s.expense + m.expense }), { income: 0, expense: 0 });
  const max = Math.max(1, ...(data.data ?? []).flatMap((m) => [m.income, m.expense]));
  return (
    <>
      <div className="section-head" style={{ marginTop: 18 }}>
        <h3 className="h3">{fy.label}</h3>
        <div className="spacer" />
        <span className="num muted" style={{ fontSize: 13 }}>
          Net <Money value={total.income - total.expense} currency={entity.currency} sign="always" />
        </span>
      </div>
      <div className="card list">
        {months.map((m) => {
          const row = byMonth.get(m) ?? { income: 0, expense: 0 };
          const future = m > monthOf(today());
          return (
            <button key={m} className="row" onClick={() => onPick(m)} aria-current={m === month ? "date" : undefined} style={future ? { opacity: 0.45 } : undefined}>
              <Tile icon={<span style={{ fontSize: 12, fontWeight: 600 }}>{monthName(m, true)}</span>} />
              <div className="row-main" style={{ gap: 5 }}>
                <div className="bar" style={{ height: 5 }}>
                  <i style={{ width: `${(row.income / max) * 100}%`, background: "var(--income)" }} />
                </div>
                <div className="bar" style={{ height: 5 }}>
                  <i style={{ width: `${(row.expense / max) * 100}%`, background: "var(--expense)" }} />
                </div>
              </div>
              <div className="row-amount num" style={{ minWidth: 110 }}>
                <Money value={row.income - row.expense} currency={entity.currency} sign="always" />
                <small>
                  {formatMoney(row.income, { currency: entity.currency, compact: true })} in · {formatMoney(row.expense, { currency: entity.currency, compact: true })} out
                </small>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

/** What's already committed in a future month: subscriptions and EMI instalments. */
function Scheduled({ month }: { month: string }) {
  const { entity, byId } = useEntity();
  const subs = useSubscriptions(entity.id).data ?? [];
  const emis = useEmis(entity.id).data ?? [];
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });
  const rows: { key: string; name: string; when: string; via: string; amount: number; icon: string }[] = [];
  for (const s of subs) {
    if (s.cancelled || s.status === "missed" || !s.nextDate) continue;
    const day = Number(s.nextDate.slice(8));
    let times = 0;
    if (s.cadence === "weekly") times = Math.round(daysInMonth(month) / 7);
    else if (s.cadence === "monthly") times = s.nextDate.slice(0, 7) <= month ? 1 : 0;
    else {
      const gap = s.cadence === "quarterly" ? 3 : 12;
      for (let m = s.nextDate.slice(0, 7); m <= month; m = addMonths(m, gap)) if (m === month) times = 1;
    }
    if (!times) continue;
    rows.push({
      key: s.id,
      name: s.name,
      when: s.cadence === "weekly" ? `${times}× this month` : `${day} ${monthName(month, true)}`,
      via: (s.accountId && byId.get(s.accountId)?.name) || "",
      amount: s.amount * times,
      icon: (s.categoryId && byId.get(s.categoryId)?.icon) || "🔁",
    });
  }
  for (const e of emis) {
    if (e.done || !e.nextMonth || !e.lastMonth || month < e.nextMonth || month > e.lastMonth) continue;
    rows.push({ key: e.id, name: `EMI · ${e.title}`, when: "instalment", via: byId.get(e.accountId)?.name ?? "", amount: e.instalment, icon: "🧾" });
  }
  rows.sort((a, b) => b.amount - a.amount);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <section className="bs-group" style={{ marginTop: 14 }}>
      <div className="section-head">
        <h3 className="h3">Already scheduled</h3>
        <div className="spacer" />
        <span className="num muted" style={{ fontSize: 13, fontWeight: 500 }}>{fmt(total)}</span>
      </div>
      {rows.length ? (
        <div className="card list">
          {rows.map((r) => (
            <div key={r.key} className="row">
              <Tile icon={r.icon} />
              <div className="row-main">
                <span className="row-title">{r.name}</span>
                <span className="row-sub">{[r.when, r.via].filter(Boolean).join(" · ")}</span>
              </div>
              <span className="row-amount num">{fmt(r.amount)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <Empty icon={<Inbox />} title="Nothing scheduled">No subscriptions or EMIs fall in {monthName(month)}.</Empty>
        </div>
      )}
      <p className="faint" style={{ fontSize: 12.5, margin: "8px 2px 0" }}>
        Subscriptions and card EMIs only. Loan EMIs, rent and day-to-day spending are in the typical month above.
      </p>
    </section>
  );
}
