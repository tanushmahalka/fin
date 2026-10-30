// Code-side half of "smart add". Code finds every candidate amount and date in
// what the person typed and resolves dates itself; the model (Jev) only picks
// among candidates and judges meaning. Numbers and calendars stay in code
// because language models are unreliable at both.

import { addDays, isValidDate, today as todayFn, weekdayIndex } from "./dates";
import { parseAmount } from "./money";

export interface Span {
  start: number;
  end: number;
}

export interface AmountCandidate extends Span {
  text: string;
  amount: number; // minor units
}

export interface DateFound extends Span {
  date: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const pad = (n: number) => String(n).padStart(2, "0");

function withYear(month: number, day: number, year: number | undefined, now: string): string | null {
  const y = year ?? Number(now.slice(0, 4));
  const date = `${y < 100 ? 2000 + y : y}-${pad(month)}-${pad(day)}`;
  if (!isValidDate(date)) return null;
  // "28 oct" typed in January means last October, not a future date.
  if (year === undefined && date > now) return `${y - 1}-${pad(month)}-${pad(day)}`;
  return date;
}

/** Finds the first date expression; later ones are ignored. */
export function findDate(text: string, now = todayFn()): DateFound | null {
  const lower = text.toLowerCase();
  const rules: [RegExp, (m: RegExpExecArray) => string | null][] = [
    [/\bday before yesterday\b/, () => addDays(now, -2)],
    [/\b(?:today|tonight|this morning)\b/, () => now],
    [/\b(?:yesterday|yday|last night)\b/, () => addDays(now, -1)],
    [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => (isValidDate(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null)],
    // Indian order: day before month.
    [/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/, (m) => withYear(Number(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined, now)],
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})\\.?(?:\\s+(\\d{4}))?\\b`), (m) => withYear(MONTHS[m[2]], Number(m[1]), m[3] ? Number(m[3]) : undefined, now)],
    [new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`), (m) => withYear(MONTHS[m[1]], Number(m[2]), m[3] ? Number(m[3]) : undefined, now)],
    [
      new RegExp(`\\b(last|on|this)?\\s*(${WEEKDAYS.join("|")})\\b`),
      (m) => {
        const target = WEEKDAYS.indexOf(m[2]);
        let back = (weekdayIndex(now) - target + 7) % 7;
        if (back === 0 && m[1] === "last") back = 7;
        return addDays(now, -back);
      },
    ],
  ];
  let best: DateFound | null = null;
  for (const [re, resolve] of rules) {
    const m = re.exec(lower);
    if (!m) continue;
    const date = resolve(m);
    if (date && (!best || m.index < best.start)) best = { start: m.index, end: m.index + m[0].length, date };
  }
  return best;
}

const AMOUNT_RE =
  /(?:₹|\brs\.?|\binr)?\s?(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|lakhs?|lacs?|l|crores?|cr)?(?=$|\.(?!\d)|[^\w/.]|rs\b|inr\b|rupees?\b|\/-)(?:\s?(?:rs|inr|rupees?|\/-))?/gi;

/** Every number that could be the amount, outside any date span. */
export function findAmounts(text: string, exclude: Span[] = []): AmountCandidate[] {
  const out: AmountCandidate[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (exclude.some((s) => start < s.end && end > s.start)) continue;
    const amount = parseAmount(m[1] + (m[2] ?? ""));
    if (!amount || amount <= 0) continue;
    const lead = m[0].length - m[0].trimStart().length;
    out.push({ start: start + lead, end, text: m[0].trim(), amount });
  }
  return out;
}

const LEAD_VERBS = /^(?:i\s+)?(?:paid|spent|spend|bought|got|received|gave|lent|lend|loaned|borrowed|returned|repaid|sent|back|for|on|at|to|via|using|with|by|from|in)\b\s*/i;
const TRAIL_WORDS = /\s*\b(?:for|on|at|to|via|using|with|by|from|in|of|rs|inr|rupees?)\s*$/i;

/** The words left once amounts, dates and the named account are removed: a tidy note. */
export function cleanNote(text: string, spans: Span[], removeWords: string[] = []): string | null {
  let s = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) s = s.slice(0, span.start) + " " + s.slice(span.end);
  for (const word of removeWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`\\b(?:via|using|with|by|from|on|in|through)?\\s*${escaped}\\b`, "i"), " ");
  }
  s = s.replace(/[₹]/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) s = s.replace(LEAD_VERBS, "").replace(TRAIL_WORDS, "").replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

export interface PreParsed {
  dateFound: DateFound | null;
  date: string;
  amounts: AmountCandidate[];
}

export function preParse(text: string, now = todayFn()): PreParsed {
  const dateFound = findDate(text, now);
  const amounts = findAmounts(text, dateFound ? [dateFound] : []);
  return { dateFound, date: dateFound?.date ?? now, amounts };
}

// ---- Rules fallback (no model available) ----------------------------------

const words = (s: string): string[] => s.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [];

export function guessKind(text: string): "expense" | "income" | "transfer" {
  const t = text.toLowerCase();
  if (/\b(transfer(red)?|moved|withdr[ae]w|atm|top ?up|card bill|to cash)\b/.test(t)) return "transfer";
  if (/\b(salary|received|credited|refund|interest|dividend|got paid|client paid|income|invoice paid)\b/.test(t)) return "income";
  return "expense";
}

/** Picks the option whose name or hint shares the most words with the text. */
export function guessByWords<T extends { name: string; hint?: string | null }>(text: string, options: T[]): T | null {
  const have = new Set(words(text));
  let best: T | null = null;
  let bestScore = 0;
  for (const o of options) {
    const vocab = new Set([...words(o.name), ...words(o.hint ?? "")].filter((w) => w.length >= 3));
    let score = 0;
    for (const w of vocab) if (have.has(w)) score += words(o.name).includes(w) ? 2 : 1;
    if (score > bestScore) {
      best = o;
      bestScore = score;
    }
  }
  return best;
}
