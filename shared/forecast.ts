// Monthly income and spending: actuals, what's still pending, and a plain projection.
//
// Books are only as complete as the latest statement of every account. A month
// after that point is "pending": its numbers are a floor, not the truth, so it is
// never used to predict anything. The projection is a typical month: the median
// of the last few complete months (a median shrugs off one unusual month).

import { addMonths, daysInMonth } from "./dates";
import type { MonthTotal } from "./types";

export type MonthState = "actual" | "pending" | "projected";

export interface MonthPoint {
  month: string;
  state: MonthState;
  /** What the books show (pending: so far; projected: 0). */
  income: number;
  expense: number;
  /** Typical month, for pending and projected months. */
  projectedIncome: number | null;
  projectedExpense: number | null;
}

export interface Forecast {
  income: number;
  expense: number;
  /** Months the typical month was taken from. */
  basis: string[];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** The last day every account with statements is covered to. */
export function completeThrough(coverage: string[]): string | null {
  return coverage.length ? coverage.reduce((a, b) => (b < a ? b : a)) : null;
}

/** Last month whose every day is covered by statements. */
export function lastCompleteMonth(through: string): string {
  const month = through.slice(0, 7);
  return Number(through.slice(8)) >= daysInMonth(month) ? month : addMonths(month, -1);
}

export function forecast(totals: MonthTotal[], through: string | null, lookback = 3): Forecast {
  const last = through ? lastCompleteMonth(through) : null;
  const done = totals.filter((m) => !last || m.month <= last).filter((m) => m.income || m.expense);
  const basis = done.slice(-lookback);
  return {
    income: median(basis.map((m) => m.income)),
    expense: median(basis.map((m) => m.expense)),
    basis: basis.map((m) => m.month),
  };
}

/** One point per month from `from` to `to`, each marked actual, pending or projected. */
export function monthSeries(totals: MonthTotal[], through: string | null, thisMonth: string, from: string, to: string): MonthPoint[] {
  const by = new Map(totals.map((m) => [m.month, m]));
  const last = through ? lastCompleteMonth(through) : thisMonth;
  const f = forecast(totals, through);
  const out: MonthPoint[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) {
    const t = by.get(m);
    const state: MonthState = m <= last ? "actual" : m <= thisMonth ? "pending" : "projected";
    out.push({
      month: m,
      state,
      income: state === "projected" ? 0 : (t?.income ?? 0),
      expense: state === "projected" ? 0 : (t?.expense ?? 0),
      projectedIncome: state === "actual" ? null : f.income,
      projectedExpense: state === "actual" ? null : f.expense,
    });
  }
  return out;
}
