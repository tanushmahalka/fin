// Statement import, the deterministic half. An agent (a generative model)
// turns a PDF/CSV into StatementV1 JSON; everything here is plain code that
// checks that JSON before a rupee of it reaches the ledger.

import { addDays, isValidDate } from "./dates";

export interface StatementLineInput {
  date: string;
  description: string;
  reference?: string | null;
  debit?: string | number | null;
  credit?: string | number | null;
  balance?: string | number | null;
}

export interface StatementV1 {
  version: 1;
  account: {
    institution?: string | null;
    /** Full or masked number as printed, e.g. "XXXXXXXX4821". */
    number?: string | null;
    last4?: string | null;
    ifsc?: string | null;
    holder?: string | null;
    type?: "bank" | "card" | null;
  };
  currency?: string | null;
  period: { from: string; to: string };
  openingBalance: string | number;
  closingBalance: string | number;
  lines: StatementLineInput[];
}

/** The format agents fill in. Printed by `fin import --schema`. */
export const STATEMENT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "fin statement v1",
  description:
    "One bank or card statement. Copy values exactly as printed. Amounts are rupees as strings (\"1,23,456.78\") so no digit is lost. Each line has either debit (money out of / charged to the account) or credit (money in / payment received). balance is the running balance printed on that line, if the statement shows one. Lines in the order printed.",
  type: "object",
  required: ["version", "account", "period", "openingBalance", "closingBalance", "lines"],
  properties: {
    version: { const: 1 },
    account: {
      type: "object",
      description: "Identifiers printed on the statement. last4 (or number) is required to find the account.",
      properties: {
        institution: { type: "string", examples: ["HDFC Bank"] },
        number: { type: "string", examples: ["XXXXXXXX4821"] },
        last4: { type: "string", pattern: "^\\d{4}$" },
        ifsc: { type: "string", examples: ["HDFC0001234"] },
        holder: { type: "string" },
        type: { enum: ["bank", "card"] },
      },
    },
    currency: { type: "string", default: "INR" },
    period: { type: "object", required: ["from", "to"], properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } } },
    openingBalance: { type: ["string", "number"], description: "Balance before the first line (for a card: amount owed)." },
    closingBalance: { type: ["string", "number"], description: "Balance after the last line (for a card: amount owed)." },
    lines: {
      type: "array",
      items: {
        type: "object",
        required: ["date", "description"],
        properties: {
          date: { type: "string", format: "date", description: "Transaction date, YYYY-MM-DD." },
          description: { type: "string", description: "Narration exactly as printed, e.g. UPI-SWIGGY-swiggy@icici-ICIC0000001-430212345678-UPI." },
          reference: { type: ["string", "null"], description: "Cheque / UTR / UPI reference number if printed in its own column." },
          debit: { type: ["string", "number", "null"] },
          credit: { type: ["string", "number", "null"] },
          balance: { type: ["string", "number", "null"] },
        },
      },
    },
  },
} as const;

/** Exact rupees → paise. "1,23,456.78", 1234.5, "₹500", "1,000.00 Dr". No floats in between. */
export function toPaise(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  let s = typeof v === "number" ? v.toFixed(2) : v.trim();
  let sign = 1;
  if (/\s*dr\.?$/i.test(s)) {
    sign = -1;
    s = s.replace(/\s*dr\.?$/i, "");
  }
  s = s.replace(/\s*cr\.?$/i, "").replace(/[₹,\s]|rs\.?|inr/gi, "");
  if (s.startsWith("(") && s.endsWith(")")) {
    sign *= -1;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    sign *= -1;
    s = s.slice(1);
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return sign * (Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0));
}

export function last4Of(account: StatementV1["account"]): string | null {
  const direct = account.last4?.replace(/\D/g, "");
  if (direct && direct.length === 4) return direct;
  const digits = account.number?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export interface Line {
  /** 1-based, in the statement's own order. */
  lineNo: number;
  date: string;
  description: string;
  reference: string | null;
  upiId: string | null;
  /** Signed effect on the ledger account (debit +, credit −), i.e. credit − debit on the statement. */
  amount: number;
  balance: number | null;
  parsed: ParsedDescription;
}

/**
 * Checks the statement against itself. Every printed balance must equal the
 * previous balance ± the line, and opening + all lines must equal closing. One
 * misread digit breaks the chain, so a wrong extraction can't slip through.
 */
export function verifyStatement(st: StatementV1, liability: boolean): { lines: Line[]; opening: number; closing: number; errors: string[] } {
  const errors: string[] = [];
  const opening = toPaise(st.openingBalance);
  const closing = toPaise(st.closingBalance);
  if (opening === null) errors.push("openingBalance isn't a number.");
  if (closing === null) errors.push("closingBalance isn't a number.");
  if (!isValidDate(st.period?.from ?? "") || !isValidDate(st.period?.to ?? "")) errors.push("period.from and period.to must be YYYY-MM-DD dates.");
  if (!Array.isArray(st.lines) || !st.lines.length) errors.push("The statement has no lines.");
  if (errors.length) return { lines: [], opening: opening ?? 0, closing: closing ?? 0, errors };

  const lines: Line[] = [];
  st.lines.forEach((l, i) => {
    const n = i + 1;
    if (!isValidDate(l.date)) return errors.push(`Line ${n}: date "${l.date}" isn't YYYY-MM-DD.`);
    if (l.date < addDays(st.period.from, -7) || l.date > addDays(st.period.to, 7)) errors.push(`Line ${n}: ${l.date} is outside the statement period.`);
    const debit = toPaise(l.debit) ?? 0;
    const credit = toPaise(l.credit) ?? 0;
    if (debit < 0 || credit < 0) return errors.push(`Line ${n}: debit and credit must be positive.`);
    if ((debit > 0) === (credit > 0)) return errors.push(`Line ${n}: needs exactly one of debit or credit.`);
    const balance = l.balance === null || l.balance === undefined || l.balance === "" ? null : toPaise(l.balance);
    if (l.balance !== null && l.balance !== undefined && l.balance !== "" && balance === null) return errors.push(`Line ${n}: balance "${l.balance}" isn't a number.`);
    const description = String(l.description ?? "").trim();
    if (!description) return errors.push(`Line ${n}: description is empty.`);
    const parsed = parseDescription(description);
    lines.push({
      lineNo: n,
      date: l.date,
      description,
      reference: l.reference?.toString().trim() || parsed.reference,
      upiId: parsed.upiId,
      amount: credit - debit,
      balance,
      parsed,
    });
  });
  if (errors.length) return { lines: [], opening: opening!, closing: closing!, errors };

  // Running balance in the statement's own terms: a bank shows money held
  // (credit adds), a card shows money owed (debit adds).
  const check = (ordered: Line[]) => {
    let running = opening!;
    for (const l of ordered) {
      running += liability ? -l.amount : l.amount;
      if (l.balance !== null && l.balance !== running) {
        return `Line ${l.lineNo} (${l.date}, ${l.description.slice(0, 40)}): printed balance ${fmt(l.balance)} but the lines add up to ${fmt(running)}. Re-read that line's amount or balance.`;
      }
    }
    if (running !== closing) return `Lines add up to a closing balance of ${fmt(running)}, but the statement says ${fmt(closing!)}. A line is missing or misread.`;
    return null;
  };
  const err = check(lines);
  if (err) {
    // Some banks print newest first.
    if (!check([...lines].reverse())) return { lines: [...lines].reverse(), opening: opening!, closing: closing!, errors: [] };
    errors.push(err);
  }
  return { lines, opening: opening!, closing: closing!, errors };
}

const fmt = (p: number) => `${p < 0 ? "-" : ""}${Math.floor(Math.abs(p) / 100).toLocaleString("en-IN")}.${String(Math.abs(p) % 100).padStart(2, "0")}`;

export type PaymentMode = "upi" | "neft" | "imps" | "rtgs" | "atm" | "pos" | "card_payment" | "charges" | "interest" | "cheque" | "ach" | "other";

export interface ParsedDescription {
  mode: PaymentMode;
  upiId: string | null;
  reference: string | null;
  /** The payee/payer name segment, if one can be found. */
  name: string | null;
}

const NOISE = new Set(["upi", "dr", "cr", "neft", "imps", "rtgs", "ach", "nach", "pos", "ecom", "payment", "pay", "paytm", "txn", "ref", "to", "from", "by", "transfer", "trf", "inb", "mob", "mb", "ib", "net", "banking", "debit", "credit", "card", "sent", "received", "collect", "request", "p2a", "p2m", "upiint", "upiintent",
  // Bank narration filler that isn't anyone's name.
  "value", "dt", "date", "mandate", "mandateexe", "execute", "execution", "test", "refund", "refundvalue", "paymen", "bbps", "okicici", "okaxis", "okhdfcbank", "oksbi", "ybl", "ibl", "axl", "paytm"]);

// Bank jargon that says how money moved, never who or what it was for.
const FILLER = [
  /\bvalue\s*dt\b/gi, /\bvalue\s*date\b/gi, /\bmandate\s*re\b/gi, /\bma\s*ndate\w*/gi, /\bmandate\w*/gi, /\bx?e?xecution\s*test\b/gi,
  /\b(?:upi|pi)?intent\w*/gi, /\brda\s*kyc\s*comp\b/gi, /\b(?:ay\s*)?via\s*razorpay\b/gi, /\b(?:paymen\s*)?on\s*cred\b/gi, /\bpayviarazo\w*/gi,
  /\bok(?:icici|axis|hdfcbank|sbi)\b/gi, /\becsrtn\w*/gi, /\brefundvalue\b/gi, /\bpayout\b/gi, /\bbbps\b/gi,
];
const JUNK_ONLY = /^(?:ent|pi|phone|me|bharatpe\s*me|pay|payment|upi|imps|neft|ach|nach|transfer|trf|cash|charges?|transaction|using)$/i;

/**
 * A note worth showing from a bank narration, or null. Drops payment-rail filler
 * ("Value Dt", "Mandate", "RDA KYC COMP", "via Razorpay"…), references and hex-like
 * fragments, and anything left too thin to mean something.
 */
export function tidyNote(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/^(?:ATW|ATM|NWD|CWDR)\b|cash wdl|cash withdrawal/i.test(text.trim())) return "ATM withdrawal";
  let t = ` ${text} `;
  for (const re of FILLER) t = t.replace(re, " ");
  t = t
    .split(/\s+/)
    .filter((w) => w && !/\d{5,}/.test(w) && !/^[a-z]*\d+[a-z\d]*$/i.test(w) || /^\d{1,2}\/\d{1,2}$/.test(w))
    .join(" ")
    .replace(/[\s\-_/.,]+$/g, "")
    .replace(/^[\s\-_/.,]+/g, "")
    .replace(/\s+(?:for|to|from|by|of)$/i, "")
    .trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length || JUNK_ONLY.test(t)) return null;
  // "Acd Af Ad Ce Ec Be": hex fragments of an ID, not words.
  if (words.every((w) => /^[a-f]{1,5}$/i.test(w))) return null;
  if (t.replace(/[^a-z]/gi, "").length < 3) return null;
  return t;
}

/** Pulls structure out of Indian bank narrations: mode, UPI ID, reference, payee name. */
export function parseDescription(desc: string): ParsedDescription {
  const d = desc.trim();
  const lower = d.toLowerCase();
  // Narrations use "-", "/" or spaces as separators, so read the UPI ID as its own segment.
  const upiId = d.split(/[\s/|-]+/).find((t) => /^[a-z0-9][a-z0-9._]{1,63}@[a-z][a-z0-9]{1,30}$/i.test(t))?.toLowerCase() ?? null;
  const reference = /(?:^|[^\d])(\d{12})(?:[^\d]|$)/.exec(d)?.[1] ?? /\b(?:utr|ref|rrn)[\s:no.#-]*([a-z0-9]{8,22})\b/i.exec(d)?.[1] ?? null;
  let mode: PaymentMode = "other";
  if (/\b(atm|atw|nwd|cash wdl|cash withdrawal|cwdr)\b/i.test(d)) mode = "atm";
  // A card bill being paid (bank side: CC/CRED bill payment; card side: payment received).
  // Not: autopay mandates for subscriptions, card interest/EMI/amortisation/fee lines.
  else if (
    !/mandate|autopay|execut|interest|amorti|principal|\bemi\b|\bfee\b|\bgst\b|markup|ecs ?r(e)?t(u)?rn|reversal/i.test(d) &&
    /\b(cc|credit card)\b.*\b(pay(ment)?|bill|dues)\b|card (bill|dues|payment)|payment received|digital payment|\bbbps\b|thank you|\bcred\b/i.test(d)
  ) mode = "card_payment";
  else if (/\bupi\b/i.test(d) || upiId) mode = "upi";
  else if (/\bneft\b/i.test(d)) mode = "neft";
  else if (/\bimps\b/i.test(d)) mode = "imps";
  else if (/\brtgs\b/i.test(d)) mode = "rtgs";
  else if (/\b(n?ach|ecs|si)\b/i.test(d)) mode = "ach";
  else if (/\b(pos|ecom|swipe)\b/i.test(d)) mode = "pos";
  else if (/\b(chq|cheque|clg|clearing)\b/i.test(d)) mode = "cheque";
  if (/\b(int\.?\s?pd|interest|int\.?\s?cr)\b/i.test(lower)) mode = "interest";
  if (/\b(charges?|chrg|chg|fee|[ics]?gst|amc|penalty)\b|markup|ecs ?r(e)?t(u)?rn|finance charge/i.test(lower) && mode !== "upi") mode = "charges";

  // Structured UPI narrations name the payee in a fixed position:
  //   ICICI  UPI/<NAME>/<vpa>/<note>/<BANK>/<ref>   (or "<NAME> UPI/<NAME>/…")
  //   HDFC   UPI-<NAME>-<vpa>-<IFSC>-<ref>-…
  const fixed = /(?:^|\s)UPI\/([^/]{2,40})\/[^/]*@?[^/]*\//i.exec(d)?.[1] ?? /^UPI-([^-]{2,40})-[^-]*@/i.exec(d)?.[1];
  if (fixed && /[a-z]{2}/i.test(fixed) && !/^\d+$/.test(fixed.trim())) {
    const n = fixed.trim().toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
    return { mode, upiId, reference, name: n };
  }
  // Name: the longest mostly-alphabetic segment that isn't noise, a UPI ID, a bank code or a reference.
  const segments = d
    .split(/[\/|*:]|-(?=\S)|\s-\s/)
    .map((s) => s.trim())
    .filter(Boolean);
  let name: string | null = null;
  let best = 0;
  for (const seg of segments) {
    if (seg.includes("@")) continue;
    if (/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(seg)) continue; // IFSC
    const words = seg.toLowerCase().match(/[a-z][a-z.&']+/g) ?? [];
    // Masked card digits ("4521XXXX") aren't names.
    const useful = words.filter((w) => w.length >= 2 && !NOISE.has(w) && !/^x{2,}$/.test(w));
    if (!useful.length) continue;
    const score = useful.join(" ").length - (seg.replace(/[^\d]/g, "").length > 4 ? 6 : 0);
    if (score > best) {
      best = score;
      name = useful.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    }
  }
  if (mode === "atm") name = null;
  return { mode, upiId, reference, name };
}

/** A failed payment and its reversal: same amount back within 3 days, marked as a reversal or carrying the same reference. */
export function findReversals(lines: Line[]): Set<number> {
  const paired = new Set<number>();
  for (const credit of lines) {
    if (credit.amount <= 0 || paired.has(credit.lineNo)) continue;
    const looksReversed = /\b(rev|reversal|reversed|refund of failed|failed|return(ed)?|rtn)\b/i.test(credit.description);
    const debit = lines.find(
      (l) =>
        l.amount === -credit.amount &&
        !paired.has(l.lineNo) &&
        l.date <= credit.date &&
        l.date >= addDays(credit.date, -3) &&
        (looksReversed || (!!l.reference && l.reference === credit.reference)),
    );
    if (debit) {
      paired.add(debit.lineNo);
      paired.add(credit.lineNo);
    }
  }
  return paired;
}

/** Stable identity of a statement line, so importing the same statement twice changes nothing. */
export function lineKey(accountId: string, l: Pick<Line, "date" | "amount" | "balance" | "reference" | "description">): string {
  const desc = l.description.toLowerCase().replace(/\s+/g, " ");
  return [accountId, l.date, l.amount, l.balance ?? "", l.reference ?? desc].join("|");
}

export interface Candidate {
  transactionId: string;
  date: string;
  /** Signed effect of the transaction on this account. */
  amount: number;
  /** Text that says what the recorded transaction is: note, contact, category. */
  label: string;
  /** Same label ⇒ interchangeable (two ₹40 chais). */
  sameness: string;
}

export const dayGap = (a: string, b: string) => Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
