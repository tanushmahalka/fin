// Money is always an integer count of minor units (paise for INR). Floats never
// touch stored amounts: 0.1 + 0.2 !== 0.3, and ledgers must balance exactly.

export const DEFAULT_CURRENCY = "INR";
export const MAX_AMOUNT = 1_000_000_000_000_00; // ₹1 lakh crore, in paise

const SUFFIXES: Record<string, number> = {
  k: 3,
  thousand: 3,
  l: 5,
  lac: 5,
  lacs: 5,
  lakh: 5,
  lakhs: 5,
  cr: 7,
  crore: 7,
  crores: 7,
};
const NUMBER_RE = /^(\d+(?:\.\d*)?|\.\d+)(thousand|lakhs|lakh|lacs|lac|crores|crore|cr|k|l)?/;

/**
 * Parses what a person types into an amount field, returning minor units.
 * Accepts "250", "₹1,20,000.50", "1.5k", "2L", "1cr", and arithmetic such as
 * "120+80" or "3*40" (handy for splitting a bill). Returns null when the input
 * is not a number.
 */
export function parseAmount(input: string, digits = 2): number | null {
  const s = input
    .toLowerCase()
    .replace(/rs\.?|inr|[₹$€£,\s_]/g, "")
    .replace(/[×x]/g, "*")
    .replace(/÷/g, "/");
  if (!s) return null;
  const scale = 10 ** digits;
  let i = 0;

  const number = (): number => {
    const m = NUMBER_RE.exec(s.slice(i));
    if (!m) throw new Error("expected number");
    i += m[0].length;
    const [whole = "", frac = ""] = m[1].split(".");
    // Shift the decimal point by string manipulation so "0.07" is exactly 7 paise.
    const shift = digits + (m[2] ? SUFFIXES[m[2]] : 0);
    const kept = (frac + "0".repeat(shift)).slice(0, shift);
    let value = Number((whole || "0") + kept);
    if ((frac[shift] ?? "0") >= "5") value += 1;
    return value;
  };
  const factor = (): number => {
    if (s[i] === "-") return i++, -factor();
    if (s[i] === "+") return i++, factor();
    if (s[i] === "(") {
      i++;
      const v = expr();
      if (s[i++] !== ")") throw new Error("expected )");
      return v;
    }
    return number();
  };
  const term = (): number => {
    let v = factor();
    while (s[i] === "*" || s[i] === "/") {
      const op = s[i++];
      const r = factor();
      if (op === "*") v = (v * r) / scale;
      else if (r === 0) throw new Error("division by zero");
      else v = (v / r) * scale;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (s[i] === "+" || s[i] === "-") {
      const op = s[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };

  try {
    const v = expr();
    if (i !== s.length) return null;
    const rounded = Math.round(v);
    return Number.isSafeInteger(rounded) ? rounded : null;
  } catch {
    return null;
  }
}

/** True when the input is arithmetic rather than a plain number. */
export function isExpression(input: string): boolean {
  return /\d\s*[-+*/x×÷]\s*[\d.(]/i.test(input.replace(/,/g, ""));
}

export type SignMode = "auto" | "always" | "never";

export interface FormatOptions {
  currency?: string;
  sign?: SignMode;
  /** "₹1.2L" instead of "₹1,20,000". */
  compact?: boolean;
  /** Typographic minus for screens; CSV and terminals want ASCII "-". */
  minus?: string;
  /** Omit the currency symbol. */
  bare?: boolean;
}

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(currency: string, fraction: number, bare: boolean) {
  const key = `${currency}:${fraction}:${bare}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-IN", {
      ...(bare ? {} : { style: "currency", currency, currencyDisplay: "narrowSymbol" }),
      minimumFractionDigits: fraction,
      maximumFractionDigits: fraction,
    });
    formatters.set(key, f);
  }
  return f;
}

function compactAbs(abs: number): string {
  const units = abs / 100;
  const steps: [number, string][] = [
    [1e7, "Cr"],
    [1e5, "L"],
    [1e3, "K"],
  ];
  for (const [size, label] of steps) {
    if (units >= size) {
      const v = units / size;
      return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${label}`;
    }
  }
  return String(Math.round(units));
}

/** Formats minor units for display, e.g. 25000 → "₹250", 25050 → "₹250.50". */
export function formatMoney(minor: number, opts: FormatOptions = {}): string {
  const currency = opts.currency ?? DEFAULT_CURRENCY;
  const minus = opts.minus ?? "−";
  const abs = Math.abs(minor);
  let body: string;
  if (opts.compact && abs >= 100_000) {
    const symbol = opts.bare ? "" : currencySymbol(currency);
    body = symbol + compactAbs(abs);
  } else {
    body = formatter(currency, abs % 100 === 0 ? 0 : 2, !!opts.bare).format(abs / 100);
  }
  const sign = opts.sign ?? "auto";
  if (sign === "never" || minor === 0) return body;
  if (minor < 0) return minus + body;
  return sign === "always" ? "+" + body : body;
}

export function currencySymbol(currency = DEFAULT_CURRENCY): string {
  const part = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  })
    .formatToParts(0)
    .find((p) => p.type === "currency");
  return part?.value ?? currency;
}

/** Plain decimal string for CSV and form fields: 25050 → "250.50". */
export function toDecimal(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Shortest editable form for an input field: 25000 → "250", 25050 → "250.5". */
export function toInput(minor: number): string {
  return toDecimal(minor).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}
