// Accounting dates are calendar dates ("2026-10-30"), not instants. A chai
// bought at 1 a.m. IST belongs to that IST day, so never derive a date from
// toISOString(), which is UTC and lands on yesterday before 5:30 a.m. in India.

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Today in the given IANA time zone, or the runtime's local zone. */
export function today(timeZone?: string): string {
  if (timeZone) {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(),
    );
  }
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-${pad(daysInMonth(month))}` };
}

/** Day of week, Monday = 0. */
export function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * The financial year containing `date`. India's FY runs April–March, so
 * FY 2026–27 is 2026-04-01 to 2027-03-31.
 */
export function fiscalYear(date: string, startMonth = 4): { from: string; to: string; label: string; startYear: number } {
  const [y, m] = date.split("-").map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const from = `${startYear}-${pad(startMonth)}-01`;
  const to = addDays(`${startYear + 1}-${pad(startMonth)}-01`, -1);
  const label =
    startMonth === 1 ? `FY ${startYear}` : `FY ${startYear}–${String((startYear + 1) % 100).padStart(2, "0")}`;
  return { from, to, label, startYear };
}

export function fiscalMonths(date: string, startMonth = 4): string[] {
  const { from } = fiscalYear(date, startMonth);
  const first = monthOf(from);
  return Array.from({ length: 12 }, (_, i) => addMonths(first, i));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function monthName(month: string, short = false): string {
  const name = MONTHS[Number(month.slice(5, 7)) - 1];
  return short ? name.slice(0, 3) : name;
}

export function monthLabel(month: string): string {
  return `${monthName(month)} ${month.slice(0, 4)}`;
}

export function weekdayName(date: string): string {
  return WEEKDAYS[weekdayIndex(date)];
}

export const WEEKDAY_NAMES = WEEKDAYS;

/** "Today", "Yesterday", or "Thu, 30 Oct". */
export function relativeDay(date: string, now = today()): string {
  if (date === now) return "Today";
  if (date === addDays(now, -1)) return "Yesterday";
  return `${weekdayName(date)}, ${Number(date.slice(8))} ${monthName(monthOf(date), true)}`;
}

/** Accepts "today", "yesterday", "-3" (days ago), "2026-10-28" or "10-28". */
export function parseDateInput(input: string, now = today()): string | null {
  const s = input.trim().toLowerCase();
  if (s === "today" || s === "t") return now;
  if (s === "yesterday" || s === "y") return addDays(now, -1);
  if (/^-\d+$/.test(s)) return addDays(now, Number(s));
  if (isValidDate(s)) return s;
  if (/^\d{2}-\d{2}$/.test(s) && isValidDate(`${now.slice(0, 4)}-${s}`)) return `${now.slice(0, 4)}-${s}`;
  return null;
}
