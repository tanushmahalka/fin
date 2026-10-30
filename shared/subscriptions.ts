// Recurring charges. A subscription is a property of charges (they repeat), not a
// kind of spending: its charges keep their own category (Netflix → Entertainment,
// a tiffin plan → Food & dining, Google Workspace → Software & tools).
// Amounts are paise; dates are YYYY-MM-DD.

import { addDays } from "./dates";

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";
export const CADENCES: Cadence[] = ["weekly", "monthly", "quarterly", "yearly"];

/** Months between charges, and the cost of one charge spread over a month. */
const MONTHS: Record<Cadence, number> = { weekly: 12 / 52, monthly: 1, quarterly: 3, yearly: 12 };
export const perMonth = (amount: number, cadence: Cadence) => Math.round(amount / MONTHS[cadence]);

/** A charge belongs to a subscription within this band around the expected amount. */
export const TOLERANCE = 0.25;

export function nextDate(date: string, cadence: Cadence): string {
  if (cadence === "weekly") return addDays(date, 7);
  const [y, m, d] = date.split("-").map(Number);
  const months = MONTHS[cadence];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Days of slack before a missing charge counts as missed (banks post a few days late). */
const GRACE: Record<Cadence, number> = { weekly: 4, monthly: 10, quarterly: 15, yearly: 30 };

export interface Charge {
  id: string;
  date: string;
  amount: number;
  accountId: string;
  categoryId: string | null;
  contactId: string | null;
  note: string | null;
}

export interface SubRule {
  id: string;
  contactId: string | null;
  matchText: string | null;
  amount: number;
}

const matches = (s: SubRule, c: Charge) =>
  ((s.contactId && c.contactId === s.contactId) || (s.matchText && (c.note ?? "").toLowerCase().includes(s.matchText.toLowerCase()))) &&
  Math.abs(c.amount - s.amount) <= s.amount * TOLERANCE;

/** Each charge goes to the matching subscription whose expected amount is closest. */
export function assignCharges(subs: SubRule[], charges: Charge[]): Map<string, Charge[]> {
  const out = new Map<string, Charge[]>(subs.map((s) => [s.id, []]));
  for (const c of charges) {
    const best = subs.filter((s) => matches(s, c)).sort((a, b) => Math.abs(a.amount - c.amount) - Math.abs(b.amount - c.amount))[0];
    if (best) out.get(best.id)!.push(c);
  }
  for (const list of out.values()) list.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

export type SubStatus = "active" | "missed" | "cancelled" | "new";

export interface SubProgress {
  status: SubStatus;
  lastDate: string | null;
  lastAmount: number | null;
  nextDate: string | null;
  /** Expected cost spread over a month (a yearly plan counts 1/12). */
  monthly: number;
  /** The latest charge differs from what's expected. */
  priceChanged: boolean;
  /** Total charged in the last 12 months. */
  lastYear: number;
}

export function subProgress(
  sub: { amount: number; cadence: Cadence; cancelled: boolean },
  charges: Charge[],
  on: string,
  /** The last date the books cover for the card it's charged to: a charge can only be missed once the statement is in. */
  seenThrough: string = on,
): SubProgress {
  const last = charges[0] ?? null;
  const next = last ? nextDate(last.date, sub.cadence) : null;
  const yearAgo = addDays(on, -365);
  let status: SubStatus = sub.cancelled ? "cancelled" : !last ? "new" : "active";
  if (status === "active" && next && addDays(next, GRACE[sub.cadence]) < (seenThrough < on ? seenThrough : on)) status = "missed";
  return {
    status,
    lastDate: last?.date ?? null,
    lastAmount: last?.amount ?? null,
    nextDate: status === "active" || status === "missed" ? next : null,
    monthly: sub.cancelled ? 0 : perMonth(sub.amount, sub.cadence),
    priceChanged: !!last && Math.abs(last.amount - sub.amount) > Math.max(100, sub.amount * 0.02),
    lastYear: charges.filter((c) => c.date > yearAgo).reduce((s, c) => s + c.amount, 0),
  };
}

export interface SubSuggestion {
  key: string;
  contactId: string | null;
  name: string;
  amount: number;
  cadence: Cadence;
  accountId: string;
  count: number;
  lastDate: string;
  chargeIds: string[];
}

/**
 * Charges that look like a subscription nobody has tracked yet: the same payee, a
 * steady amount, at a steady gap. Small daily spends (chai, metro) don't qualify:
 * too frequent, too irregular.
 */
export function detectRecurring(charges: Charge[], tracked: Set<string>, names: Map<string, string>): SubSuggestion[] {
  const groups = new Map<string, Charge[]>();
  for (const c of charges) {
    if (tracked.has(c.id)) continue;
    const who = c.contactId ?? (c.note ? `note:${c.note.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 24)}` : null);
    if (!who) continue;
    // Split one payee into amount bands: Google Workspace bills three seats separately.
    const list = groups.get(who) ?? [];
    list.push(c);
    groups.set(who, list);
  }
  const out: SubSuggestion[] = [];
  for (const [who, all] of groups) {
    const bands: Charge[][] = [];
    for (const c of [...all].sort((a, b) => a.amount - b.amount)) {
      const band = bands.find((b) => Math.abs(b[0].amount - c.amount) <= b[0].amount * 0.1);
      if (band) band.push(c);
      else bands.push([c]);
    }
    for (const band of bands) {
      if (band.length < 3) continue;
      const dated = band.sort((a, b) => a.date.localeCompare(b.date));
      const gaps = dated.slice(1).map((c, i) => (Date.parse(c.date) - Date.parse(dated[i].date)) / 864e5);
      const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
      const cadence: Cadence | null = median >= 5 && median <= 9 ? "weekly" : median >= 26 && median <= 35 ? "monthly" : median >= 85 && median <= 97 ? "quarterly" : median >= 350 && median <= 380 ? "yearly" : null;
      if (!cadence) continue;
      const steady = gaps.filter((g) => Math.abs(g - median) <= Math.max(4, median * 0.2)).length / gaps.length;
      if (steady < 0.6) continue;
      const last = dated[dated.length - 1];
      const amounts = dated.map((c) => c.amount).sort((a, b) => a - b);
      out.push({
        key: `${who}|${amounts[0]}`,
        contactId: who.startsWith("note:") ? null : who,
        name: who.startsWith("note:") ? (last.note ?? "Recurring charge") : (names.get(who) ?? "Recurring charge"),
        amount: amounts[Math.floor(amounts.length / 2)],
        cadence,
        accountId: last.accountId,
        count: dated.length,
        lastDate: last.date,
        chargeIds: dated.map((c) => c.id),
      });
    }
  }
  return out.sort((a, b) => perMonth(b.amount, b.cadence) - perMonth(a.amount, a.cadence));
}
