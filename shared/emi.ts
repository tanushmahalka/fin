// EMI schedule maths. Amounts are paise; dates are YYYY-MM-DD.
//
// An EMI is an annuity: a fixed instalment that covers interest on what's left
// plus some principal. What's left after k of n instalments is the present
// value of the n−k still to come, so it needs only the instalment and a rate.
// The rate isn't printed on most statements, so it is solved from the plan.
// Lenders charge a longer first interest period, so results are estimates
// (within a rupee or two a month) and shown with "≈".

import { addMonths } from "./dates";

/** Instalments due on or before `on`, given the first due date. */
export function instalmentsDue(firstDue: string, on: string, months: number | null): number {
  if (on < firstDue) return 0;
  const [fy, fm, fd] = firstDue.split("-").map(Number);
  const [y, m, d] = on.split("-").map(Number);
  const n = (y - fy) * 12 + (m - fm) + (d >= fd ? 1 : 0);
  return months ? Math.min(n, months) : n;
}

/** Present value of `count` instalments at monthly rate r. */
function presentValue(instalment: number, r: number, count: number): number {
  return r === 0 ? instalment * count : (instalment * (1 - (1 + r) ** -count)) / r;
}

/** Monthly rate that makes `count` instalments worth `value` today (bisection; 0 when there's no interest). */
export function solveRate(value: number, instalment: number, count: number): number {
  if (instalment * count <= value) return 0;
  let lo = 0;
  let hi = 0.1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (presentValue(instalment, mid, count) > value) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Principal still owed after `paid` instalments. */
export function principalLeft(principal: number, instalment: number, months: number, paid: number): number {
  if (paid >= months) return 0;
  const r = solveRate(principal, instalment, months);
  return Math.round(presentValue(instalment, r, months - paid));
}

/** The original principal, from what a statement says is left after `paid` instalments. */
export function principalFromLeft(left: number, instalment: number, months: number, paid: number): number {
  const r = solveRate(left, instalment, months - paid);
  return Math.round(presentValue(instalment, r, months));
}

export interface EmiProgress {
  /** Instalments paid so far; null when the schedule isn't known. */
  paid: number | null;
  /** Principal still owed: what counts in net worth. */
  left: number;
  /** Instalments still to pay, interest included: the cash that will leave. */
  toPay: number;
  /** True when `left` comes from the schedule rather than a ledger balance. */
  leftEstimated: boolean;
  /** Instalments still to pay; estimated from left ÷ instalment when the tenure isn't known. */
  monthsLeft: number;
  monthsLeftEstimated: boolean;
  /** Month (YYYY-MM) of the next and the last instalment, when there is one. */
  nextMonth: string | null;
  lastMonth: string | null;
  done: boolean;
}

/**
 * Where a plan stands on `on`. `ledgerLeft` is the owed balance of the plan's own
 * account (sub-account or loan), or null when the principal sits inside a card balance.
 */
export function emiProgress(
  plan: { principal: number | null; instalment: number; months: number | null; firstDue: string | null; closed: boolean },
  ledgerLeft: number | null,
  on: string,
): EmiProgress {
  const paid = plan.firstDue ? instalmentsDue(plan.firstDue, on, plan.months) : null;
  let left: number;
  let leftEstimated = false;
  if (ledgerLeft !== null) left = Math.max(0, ledgerLeft);
  else if (plan.principal && plan.months && paid !== null) {
    left = principalLeft(plan.principal, plan.instalment, plan.months, paid);
    leftEstimated = true;
  } else left = 0;
  const scheduleLeft = plan.months && paid !== null ? plan.months - paid : null;
  // With a known schedule, only the schedule (or closing it) ends a plan: an empty ledger
  // just means its lines aren't booked yet. Without one, nothing left means done.
  const done = plan.closed || (scheduleLeft !== null ? scheduleLeft === 0 : left === 0);
  const monthsLeft = done ? 0 : (scheduleLeft ?? Math.ceil(left / plan.instalment));
  const monthsLeftEstimated = !done && scheduleLeft === null;
  const thisMonth = on.slice(0, 7);
  const nextMonth = done
    ? null
    : plan.firstDue && paid !== null
      ? addMonths(plan.firstDue.slice(0, 7), paid)
      : addMonths(thisMonth, 1);
  const lastMonth = nextMonth ? addMonths(nextMonth, monthsLeft - 1) : null;
  return { paid, left, toPay: monthsLeft * plan.instalment, leftEstimated, monthsLeft, monthsLeftEstimated, nextMonth, lastMonth, done };
}

/** Total instalments due each month from `from` until the last plan ends (at most `limit` months). */
export function emiProjection(
  plans: { id: string; instalment: number; nextMonth: string | null; monthsLeft: number; done: boolean }[],
  from: string,
  limit = 60,
): { month: string; total: number; plans: { id: string; amount: number }[] }[] {
  const active = plans.filter((p) => !p.done && p.nextMonth);
  const last = active.reduce((m, p) => {
    const end = addMonths(p.nextMonth!, p.monthsLeft - 1);
    return end > m ? end : m;
  }, from);
  const out: { month: string; total: number; plans: { id: string; amount: number }[] }[] = [];
  for (let month = from; month <= last && out.length < limit; month = addMonths(month, 1)) {
    const due = active
      .filter((p) => month >= p.nextMonth! && month <= addMonths(p.nextMonth!, p.monthsLeft - 1))
      .map((p) => ({ id: p.id, amount: p.instalment }));
    out.push({ month, total: due.reduce((s, d) => s + d.amount, 0), plans: due });
  }
  return out;
}
