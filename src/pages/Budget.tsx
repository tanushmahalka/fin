import { Target } from "lucide-react";
import { useState } from "react";
import { daysInMonth, monthOf, monthRange, today } from "../../shared/dates";
import { formatMoney, parseAmount, toInput } from "../../shared/money";
import type { Account } from "../../shared/types";
import { useBudgets, useEntityMutation, useSummary } from "../api";
import { MonthNav, useMonthParam } from "../components/MonthNav";
import { Empty, Tile, useToast } from "../components/ui";
import { useEntity } from "../state";

export function BudgetPage() {
  const { entity, expenseCats, canEdit } = useEntity();
  const [month, setMonth] = useMonthParam();
  const range = monthRange(month);
  const summary = useSummary(entity.id, range.from, range.to);
  const budgets = useBudgets(entity.id);
  const spentBy = new Map((summary.data?.byCategory ?? []).map((r) => [r.accountId, r.amount]));
  const budgetBy = new Map((budgets.data ?? []).map((b) => [b.accountId, b.amount]));

  const withBudget = expenseCats.filter((c) => budgetBy.has(c.id)).sort((a, b) => (spentBy.get(b.id) ?? 0) / budgetBy.get(b.id)! - (spentBy.get(a.id) ?? 0) / budgetBy.get(a.id)!);
  const without = expenseCats.filter((c) => !budgetBy.has(c.id));
  const totalBudget = withBudget.reduce((s, c) => s + budgetBy.get(c.id)!, 0);
  const totalSpent = withBudget.reduce((s, c) => s + (spentBy.get(c.id) ?? 0), 0);

  // Pace: how much of the month has gone, so 60% spent on day 10 reads as a warning.
  const isCurrent = month === monthOf(today());
  const pace = isCurrent ? Number(today().slice(8)) / daysInMonth(month) : month < monthOf(today()) ? 1 : 0;

  return (
    <main className="page">
      <div className="page-head">
        <MonthNav month={month} onChange={setMonth} />
      </div>

      <div className="card card-pad">
        <span className="eyebrow">Left to spend</span>
        <div className={`big-number num ${totalSpent > totalBudget && totalBudget ? "expense" : ""}`} style={{ marginTop: 4 }}>
          {formatMoney(totalBudget - totalSpent, { currency: entity.currency })}
        </div>
        <div className="bar" style={{ marginTop: 14 }}>
          <i style={{ width: `${totalBudget ? Math.min(100, (totalSpent / totalBudget) * 100) : 0}%` }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12.5 }} className="muted num">
          <span>{formatMoney(totalSpent, { currency: entity.currency })} spent</span>
          <span>of {formatMoney(totalBudget, { currency: entity.currency })}</span>
        </div>
      </div>

      {withBudget.length > 0 ? (
        <section className="section">
          <div className="card list">
            {withBudget.map((c) => (
              <BudgetRow key={c.id} cat={c} spent={spentBy.get(c.id) ?? 0} budget={budgetBy.get(c.id)!} pace={pace} canEdit={canEdit} />
            ))}
          </div>
        </section>
      ) : (
        <div className="card" style={{ marginTop: 20 }}>
          <Empty icon={<Target />} title="No budgets yet">
            Set a monthly limit on the categories you want to watch. It repeats every month.
          </Empty>
        </div>
      )}

      {without.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2 className="h3">No budget</h2>
          </div>
          <div className="card list">
            {without.map((c) => (
              <BudgetRow key={c.id} cat={c} spent={spentBy.get(c.id) ?? 0} budget={null} pace={pace} canEdit={canEdit} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function BudgetRow({ cat, spent, budget, pace, canEdit }: { cat: Account; spent: number; budget: number | null; pace: number; canEdit: boolean }) {
  const { entity } = useEntity();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const set = useEntityMutation<{ amount: number }>(entity.id, `/budgets/${cat.id}`, "PUT");
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });
  const ratio = budget ? spent / budget : 0;
  const ahead = budget && pace > 0 && pace < 1 && ratio > pace + 0.1;

  const commit = async () => {
    const amount = value.trim() ? parseAmount(value) : 0;
    if (amount === null) return;
    await set.mutateAsync({ amount });
    setEditing(false);
    toast({ message: amount ? `${cat.name}: ${fmt(amount)} a month` : `Budget removed for ${cat.name}` });
  };

  return (
    <div className="row" style={{ alignItems: budget ? "flex-start" : "center", paddingTop: budget ? 12 : 9, paddingBottom: budget ? 12 : 9 }}>
      <Tile icon={cat.icon} />
      <div className="row-main" style={{ gap: 7 }}>
        <span className="row-title">{cat.name}</span>
        {budget ? (
          <>
            <div className={`bar ${ratio > 1 ? "over" : ""}`}>
              <i style={{ width: `${Math.min(100, ratio * 100)}%`, background: ratio > 1 ? undefined : ahead ? "var(--warn)" : undefined }} />
            </div>
            <span className="row-sub num">
              {fmt(spent)} of {fmt(budget)} ·{" "}
              {ratio > 1 ? <span className="expense">{fmt(spent - budget)} over</span> : ahead ? <span style={{ color: "var(--warn)" }}>ahead of pace</span> : `${fmt(budget - spent)} left`}
            </span>
          </>
        ) : (
          spent > 0 && <span className="row-sub num">{fmt(spent)} spent</span>
        )}
      </div>
      {canEdit &&
        (editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              commit();
            }}
            style={{ display: "flex", gap: 6 }}
          >
            <input
              className="input num"
              autoFocus
              style={{ width: 110, height: 32 }}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => !value && setEditing(false)}
              onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
              inputMode="decimal"
              placeholder="Monthly"
              aria-label={`Monthly budget for ${cat.name}`}
            />
            <button className="btn btn-primary btn-sm">Set</button>
          </form>
        ) : (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setValue(budget ? toInput(budget) : "");
              setEditing(true);
            }}
          >
            {budget ? "Edit" : "Set budget"}
          </button>
        ))}
    </div>
  );
}
