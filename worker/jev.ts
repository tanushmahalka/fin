// Jev (TypeSafe System One) as the app's "programmable common sense".
//
// Division of labour, following TypeSafe's own guidance:
//   code  finds candidate amounts, dates, contacts and names; resolves dates;
//         does all money math; queries the ledger; applies policy (thresholds,
//         history lookups, what gets saved)
//   Jev   picks among closed sets: which kind, which category, which account,
//         which contact, which words name someone, which number is the amount,
//         whose expense this is, what a question is asking
//
// Jev only ever proposes. Low-confidence fields come back empty, and nothing is
// written until a person confirms. Sent to Jev: the typed text, the entity
// name/kind, and account, category and contact names. Never balances or history.

import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { addDays, addMonths, fiscalYear, monthLabel, monthOf, monthRange, today, weekdayIndex } from "../shared/dates";
import { displayBalance, isMoneyAccount } from "../shared/ledger";
import { formatMoney } from "../shared/money";
import { cleanNote, guessByWords, guessKind, preParse, type Span } from "../shared/parse";
import type { Account, AskIntent, AskResult, AssistResult, AssistWarning, Contact, EntryKind, ParseResult, Transaction } from "../shared/types";

export function jevClient(env: Env): TypeSafeClient | null {
  const apiKey = (env as { TYPESAFE_API_KEY?: string }).TYPESAFE_API_KEY;
  if (!apiKey) return null;
  return new TypeSafeClient({
    apiKey,
    defaultModel: env.TYPESAFE_MODEL || "jev-latest",
    compression: false,
    timeout: 8000,
    retry: { maxRetries: 1 },
    logLevel: "error",
  });
}

// Policy, not model output: tune these on real entries (npm run eval:jev).
const BAR = {
  category: 0.45,
  categoryOverHistory: 0.7,
  account: 0.5,
  named: 0.35,
  namedAlone: 0.65,
  amount: 0.5,
  transferLeg: 0.5,
  contact: 0.5,
  newContact: 0.55,
  personal: 0.7,
  intent: 0.4,
  isName: 0.7,
};

const GENERIC = new Set(["account", "accounts", "the", "and", "for", "from", "with", "kept", "charged", "purchases", "money", "company's"]);
const STOP = new Set([
  ...GENERIC,
  "to", "at", "on", "in", "of", "my", "me", "a", "an", "by", "via", "using", "paid", "pay", "gave", "give", "got", "get", "sent", "send",
  "received", "lent", "lend", "borrowed", "borrow", "returned", "back", "rs", "inr", "rupees", "today", "yesterday", "spent", "bought",
  "this", "that", "last", "night", "morning", "week", "month", "share", "half", "split", "owe", "owes", "his", "her", "their", "our",
]);

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9][a-z0-9'.&-]*[a-z0-9]|[a-z0-9]/g) ?? [];
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

/** True when the text contains a distinctive word from the account's name or hint. */
function mentions(text: string, account: Account): boolean {
  const have = new Set(words(text));
  const vocab = `${account.name} ${account.hint ?? ""}`.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
  return vocab.some((w) => !GENERIC.has(w) && have.has(w));
}

/** Edit distance, stopped early above `max`: catches "blinkt" for "blinkit". */
function near(a: string, b: string, max = 1): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (Math.min(...row) > max) return false;
    prev = row;
  }
  return prev[b.length] <= max;
}

/**
 * Contacts whose name or aliases plausibly appear in the text. Code narrows
 * hundreds of contacts to a handful; Jev chooses among the handful. A wide
 * Choice over every contact would be slow and would always name *someone*.
 */
export function shortlistContacts(text: string, contacts: Contact[], max = 8): { contact: Contact; score: number }[] {
  const have = words(text);
  const lower = ` ${text.toLowerCase()} `;
  const scored = contacts.map((contact) => {
    let score = 0;
    for (const name of [contact.name, ...(contact.aliases?.split(",") ?? [])].map((n) => n.trim().toLowerCase()).filter(Boolean)) {
      if (name.length >= 3 && lower.includes(` ${name} `)) score = Math.max(score, 3);
      for (const w of words(name).filter((x) => x.length >= 3 && !STOP.has(x))) {
        if (have.includes(w)) score = Math.max(score, 2);
        else if (have.some((h) => h.length >= 4 && (near(h, w) || (w.length >= 5 && h.startsWith(w.slice(0, 4)))))) score = Math.max(score, 1);
      }
    }
    return { contact, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || b.contact.transactions - a.contact.transactions).slice(0, max);
}

/** Words (and word pairs) that could be someone's name, from what's left of the text. */
function nameCandidates(note: string | null, exclude: Set<string>): string[] {
  if (!note) return [];
  const ws = words(note).filter((w) => w.length >= 2 && !/^\d/.test(w));
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (!STOP.has(w) && !exclude.has(w) && w.length >= 3) out.push(w);
    const next = ws[i + 1];
    if (next && !STOP.has(w) && !STOP.has(next)) out.push(`${w} ${next}`);
  }
  return [...new Set(out)].slice(0, 8);
}

export interface AssistContext {
  entity: { name: string; kind: "personal" | "business"; currency: string; timezone: string; fyStartMonth: number; iouAccountId: string | null };
  accounts: Account[];
  contacts: Contact[];
}

type Options = Record<string, string | null>;

/** Choice options keyed by the names people see; descriptions come from hints. */
function optionsFor(accounts: Account[]): { options: Options; idOf: Map<string, string> } {
  const options: Options = {};
  const idOf = new Map<string, string>();
  for (const a of accounts) {
    let key = a.name;
    if (key in options) key = `${a.name} (${a.subtype ?? a.type})`;
    options[key] = a.hint ?? null;
    idOf.set(key, a.id);
  }
  return { options, idOf };
}

function contactOptions(list: { contact: Contact }[]): { options: Options; idOf: Map<string, string> } {
  const options: Options = {};
  const idOf = new Map<string, string>();
  for (const { contact } of list) {
    options[contact.name] = `${contact.kind === "person" ? "A person" : "A business"}${contact.aliases ? `, also written ${contact.aliases}` : ""}`;
    idOf.set(contact.name, contact.id);
  }
  return { options, idOf };
}

function live(accounts: Account[]) {
  const ok = accounts.filter((a) => !a.archived && !a.system);
  return {
    money: ok.filter((a) => isMoneyAccount(a) && !a.parentId),
    expense: ok.filter((a) => a.type === "expense"),
    income: ok.filter((a) => a.type === "income"),
  };
}

function prob(answer: { probabilities: Record<string, number> }, key: string) {
  return answer.probabilities[key] ?? 0;
}

type Question = ReturnType<typeof choice> | ReturnType<typeof noul>;
type Answers = Record<string, { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }>;
type ChoiceAnswer = { choice: string; confidence: number; probabilities: Record<string, number> };

// ---- Record: "uber to airport 640 card" → draft transaction ------------------

const KINDS = {
  personal: {
    expense: "Money the user spent or paid out: a purchase, a bill, a fee, a gift, or a payment for a service",
    income: "Money paid to the user: salary, payment for the user's own work, interest, a refund, or a gift received",
    transfer: "Money moved between two of the user's own accounts, such as withdrawing cash, paying off the credit card, or moving savings",
    gave: "Money lent to a person, or paid back to someone the user owed. Nobody spent it; it is owed back",
    got: "Money borrowed from a person, or a person paying back what they owed the user. Nobody earned it; it is owed back",
  },
  business: {
    expense: "Money the business paid out: purchases, bills, salaries, and payments to freelancers, contractors or vendors",
    income: "Money paid to the business: customer or client payments, interest, or refunds",
    transfer: "Money moved between the business's own accounts, such as withdrawing petty cash or paying off the company card",
    gave: "Money the business lent, or repaid to someone it owed, such as repaying a director's loan",
    got: "Money the business borrowed, such as a loan from a director, or someone repaying the business",
  },
};

function parseQuestions(ctx: AssistContext, text: string, kind: EntryKind | undefined) {
  const { money, expense, income } = live(ctx.accounts);
  const exp = optionsFor(expense);
  const inc = optionsFor(income);
  const acc = optionsFor(money);
  const pre = preParse(text, today(ctx.entity.timezone));
  const amountKeys = [...new Set(pre.amounts.map((a) => a.text))];
  const shortlist = shortlistContacts(text, ctx.contacts.filter((c) => !c.archived));
  const con = contactOptions(shortlist);
  // Candidate new names come from the words left once amounts and dates are gone,
  // minus words that belong to accounts, categories or known contacts.
  const known = new Set(
    [...money, ...expense, ...income].flatMap((a) => words(a.name)).concat(shortlist.flatMap((s) => words(s.contact.name))),
  );
  const leftover = cleanNote(text, [...pre.amounts, ...(pre.dateFound ? [pre.dateFound] : [])]);
  const names = nameCandidates(leftover, known);

  const questions: Record<string, Question> = {};
  if (!kind) questions.kind = choice("What kind of money movement does `text` describe?", KINDS[ctx.entity.kind]);
  if ((!kind || kind === "expense") && expense.length) {
    questions.expense_category = choice("If `text` is spending, which spending category does it belong to?", {
      ...exp.options,
      unclear: "None of these categories clearly fits `text`",
    });
  }
  if ((!kind || kind === "income") && income.length) {
    questions.income_category = choice("If `text` is money received, which income category does it belong to?", {
      ...inc.options,
      unclear: "None of these categories clearly fits `text`",
    });
  }
  if (money.length > 1) {
    questions.account_named = noul("Does `text` name the account, card, cash, bank or payment app that was used?");
    questions.account = choice("Which of the user's accounts does `text` say the money was paid from or received into?", acc.options);
    if (!kind || kind === "transfer") {
      questions.transfer_from = choice("If `text` moves money between the user's own accounts, which account did the money leave?", acc.options);
      questions.transfer_to = choice("If `text` moves money between the user's own accounts, which account did the money go into?", acc.options);
    }
  }
  if (amountKeys.length > 1) {
    questions.amount = choice("Which of these numbers in `text` is the amount of money paid or received?", {
      ...Object.fromEntries(amountKeys.map((k) => [k, null])),
      none: "None of these numbers is the amount of money",
    });
  }
  if (shortlist.length) {
    questions.contact = choice("Which of these is the person or business that `text` paid, was paid by, or is about?", {
      ...con.options,
      none: "None of them is mentioned in `text`",
    });
  }
  if (names.length) {
    questions.new_contact = choice("Which words in `text` name the person or business that was paid or that paid?", {
      ...Object.fromEntries(names.map((n) => [n, null])),
      none: "No person or business is named; the words describe an item, an activity or a place",
    });
    questions.new_contact_person = noul("Does `text` name an individual person, such as a friend, relative or colleague, rather than a business?");
  }
  if (ctx.entity.kind === "business" && (!kind || kind === "expense")) {
    questions.personal = noul(
      "If `text` is spending, is it a personal expense of an individual rather than a cost of running the business named in `entity.name`?",
      {
        true: "Personal spending that does not serve the business: household groceries, family costs, personal shopping, personal streaming or entertainment, holidays",
        false: "A cost of the business: software, ads, salaries, contractors, office, work travel, team or client meals, professional fees, taxes",
      },
    );
  }
  return { questions, pre, exp, inc, acc, con, shortlist, lists: { money, expense, income } };
}

function composeParse(ctx: AssistContext, text: string, kindGiven: EntryKind | undefined, built: ReturnType<typeof parseQuestions>, answers: Answers | null): ParseResult {
  const { pre, exp, inc, acc, con, shortlist, lists } = built;
  const a = answers ?? {};
  const choiceOf = (q: string) => a[q] as ChoiceAnswer | undefined;

  // Kind. Jev can be unsure whether "zepto 640" is spending while being sure
  // Zepto is groceries, so weight each kind by how clearly a category of that
  // kind fits. Composing two judgments in code beats trusting either alone.
  let kind: EntryKind = kindGiven ?? guessKind(text);
  let kindConf = kindGiven ? 1 : answers ? 0 : 0.5;
  const kq = choiceOf("kind");
  if (kq) {
    const fits = (q: string) => {
      const c = choiceOf(q);
      return c ? 1 - prob(c, "unclear") : 1;
    };
    const scores: Record<EntryKind, number> = {
      expense: prob(kq, "expense") * fits("expense_category"),
      income: prob(kq, "income") * fits("income_category"),
      transfer: prob(kq, "transfer"),
      gave: prob(kq, "gave"),
      got: prob(kq, "got"),
    };
    const total = Object.values(scores).reduce((s, v) => s + v, 0) || 1;
    kind = (Object.keys(scores) as EntryKind[]).reduce((best, k) => (scores[k] > scores[best] ? k : best), "expense");
    kindConf = scores[kind] / total;
  }

  // Amount: code found the numbers; Jev only disambiguates.
  let amount: number | null = null;
  let amountConf = 0;
  let amountSpan: Span | null = null;
  if (pre.amounts.length === 1) {
    amount = pre.amounts[0].amount;
    amountSpan = pre.amounts[0];
    amountConf = 1;
  } else if (pre.amounts.length > 1) {
    const aq = choiceOf("amount");
    const pick = aq && aq.choice !== "none" && prob(aq, aq.choice) >= BAR.amount ? aq.choice : null;
    const found = pick ? pre.amounts.find((c) => c.text === pick) : answers ? null : pre.amounts[pre.amounts.length - 1];
    if (found) {
      amount = found.amount;
      amountSpan = found;
      amountConf = aq ? prob(aq, aq.choice) : 0.4;
    }
  }

  // Contact: an existing one from the shortlist, else a new name Jev picked out of the text.
  let contactId: string | null = null;
  let contactConf = 0;
  let newContact: ParseResult["draft"]["newContact"] = null;
  const cq = choiceOf("contact");
  if (cq && cq.choice !== "none" && prob(cq, cq.choice) >= BAR.contact) {
    contactId = con.idOf.get(cq.choice) ?? null;
    contactConf = prob(cq, cq.choice);
  } else if (!answers && shortlist[0]?.score >= 2) {
    contactId = shortlist[0].contact.id;
    contactConf = 0.5;
  }
  if (!contactId) {
    const nq = choiceOf("new_contact");
    if (nq && nq.choice !== "none" && prob(nq, nq.choice) >= BAR.newContact) {
      newContact = { name: titleCase(nq.choice), kind: (a.new_contact_person?.noul ?? 0) >= 0.5 ? "person" : "business" };
      contactConf = prob(nq, nq.choice);
    }
  }
  const contact = contactId ? ctx.contacts.find((c) => c.id === contactId) : undefined;

  // Category: a confident read of the text wins; otherwise what you usually
  // use with this contact (a lookup, not a model); otherwise a looser read.
  let categoryId: string | null = null;
  let categoryConf = 0;
  let suggestions: string[] = [];
  if (kind === "expense" || kind === "income") {
    const q = choiceOf(kind === "expense" ? "expense_category" : "income_category");
    const map = kind === "expense" ? exp : inc;
    const pool = kind === "expense" ? lists.expense : lists.income;
    const fromJev = q && q.choice !== "unclear" ? (map.idOf.get(q.choice) ?? null) : null;
    const fromHistory = contact?.topCategoryId && pool.some((c) => c.id === contact.topCategoryId) ? contact.topCategoryId : null;
    if (q) {
      suggestions = Object.entries(q.probabilities)
        .filter(([k, p]) => k !== "unclear" && p >= 0.08)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .flatMap(([k]) => map.idOf.get(k) ?? []);
    }
    if (fromJev && q!.confidence >= BAR.categoryOverHistory) [categoryId, categoryConf] = [fromJev, q!.confidence];
    else if (fromHistory) [categoryId, categoryConf] = [fromHistory, 0.8];
    else if (fromJev && q!.confidence >= BAR.category) [categoryId, categoryConf] = [fromJev, q!.confidence];
    else if (!answers) {
      const guess = guessByWords(text, pool);
      if (guess) [categoryId, categoryConf] = [guess.id, 0.5];
    }
    if (fromHistory && !suggestions.includes(fromHistory)) suggestions = [fromHistory, ...suggestions].slice(0, 3);
  }

  // Accounts: filled when the text names one; otherwise the account you last
  // used with this contact; otherwise the client keeps its own default.
  let accountId: string | null = null;
  let toAccountId: string | null = null;
  let accountConf = 0;
  let toConf = 0;
  if (lists.money.length === 1) {
    accountId = lists.money[0].id;
    accountConf = 1;
  } else if (answers && kind === "transfer") {
    const from = choiceOf("transfer_from");
    const to = choiceOf("transfer_to");
    if (from && prob(from, from.choice) >= BAR.transferLeg) [accountId, accountConf] = [acc.idOf.get(from.choice) ?? null, prob(from, from.choice)];
    if (to && prob(to, to.choice) >= BAR.transferLeg) [toAccountId, toConf] = [acc.idOf.get(to.choice) ?? null, prob(to, to.choice)];
    if (toAccountId && toAccountId === accountId) toAccountId = null;
  } else if (answers) {
    // "Was an account named?" is borderline for both "aws 3,450 company card"
    // (named) and "zepto 640" (not named). A word from the chosen account's
    // name or hint appearing in the text settles the middle band.
    const q = choiceOf("account");
    const chosen = q ? lists.money.find((m) => m.id === acc.idOf.get(q.choice)) : undefined;
    const p = a.account_named?.noul ?? 0;
    const named = p >= BAR.namedAlone || (p >= BAR.named && !!chosen && mentions(text, chosen));
    if (named && q && chosen && prob(q, q.choice) >= BAR.account) [accountId, accountConf] = [chosen.id, prob(q, q.choice)];
  } else {
    const guess = guessByWords(text, lists.money);
    if (guess) [accountId, accountConf] = [guess.id, 0.5];
  }
  if (!accountId && kind !== "transfer" && contact?.lastAccountId && lists.money.some((m) => m.id === contact.lastAccountId)) {
    [accountId, accountConf] = [contact.lastAccountId, 0.6];
  }

  // Note: what's left after removing the amount, the date and (for spending
  // and income) the account the person named.
  const spans: Span[] = [amountSpan, pre.dateFound].filter((s): s is Span => !!s);
  const named = kind !== "transfer" && accountId ? lists.money.find((m) => m.id === accountId) : null;
  const have = new Set(words(text));
  const removeWords = named
    ? (`${named.name} ${named.hint ?? ""}`.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((w) => !GENERIC.has(w) && have.has(w))
    : [];
  const contactName = contact?.name ?? newContact?.name;
  // For lending and paying back, the person is already the contact; the note keeps only the why.
  if ((kind === "gave" || kind === "got") && contactName) removeWords.push(...words(contactName).filter((w) => have.has(w)));
  let note = cleanNote(text, spans, [...new Set(removeWords)]);
  if (note && contactName && note.toLowerCase() === contactName.toLowerCase()) note = null;

  const warnings: AssistWarning[] = [];
  const personal = a.personal?.noul;
  if (kind === "expense" && ctx.entity.kind === "business" && personal !== undefined && personal >= BAR.personal) {
    warnings.push({
      code: "looks_personal",
      probability: personal,
      message: `This looks like a personal expense. Company money spent on personal items can be taxed as a perquisite or disallowed, so record it under your personal entity unless ${ctx.entity.name} should really pay for it.`,
    });
  }

  return {
    draft: { kind, amount, date: pre.date, accountId, toAccountId, categoryId, contactId, newContact, note },
    confidence: { kind: kindConf, amount: amountConf, category: categoryConf, account: accountConf, toAccount: toConf, contact: contactConf },
    suggestions: { categoryIds: suggestions, amounts: [...new Set(pre.amounts.map((c) => c.amount))] },
    warnings,
  };
}

// ---- Ask: "how much did we spend on ads last month?" → a ledger query ---------

const PERIODS = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week so far",
  last_week: "Last week",
  this_month: "This month so far",
  last_month: "Last month",
  named_month: "A specific calendar month named in the question, such as August",
  this_fy: "This financial year (April to March)",
  last_fy: "Last financial year",
  this_year: "This calendar year",
  last_year: "Last calendar year",
  all_time: "All time, since records began",
};
const MONTH_KEYS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function askQuestions(ctx: AssistContext, text: string) {
  const { money, expense, income } = live(ctx.accounts);
  const exp = optionsFor(expense);
  const inc = optionsFor(income);
  const acc = optionsFor(money);
  const con = contactOptions(shortlistContacts(text, ctx.contacts.filter((c) => !c.archived)));
  const questions: Record<string, Question> = {
    intent: choice("What does `text` want to know about the user's money?", {
      spending: "How much was spent, in total, on a category, or at a merchant or person",
      income: "How much money came in or was earned",
      balance: "How much money is in an account right now, or the user's net worth",
      budget: "Whether spending is within budget, or how much budget is left",
      transactions: "To see, list or find specific transactions",
      owed: "Who owes whom: how much a person owes the user, or how much the user owes someone",
      other: "Something else, or not a question about this money",
    }),
    period_named: noul("Does `text` mention a time period, such as a day, week, month, year or financial year?"),
    period: choice("Which time period does `text` ask about?", PERIODS),
    month: choice("Which calendar month does `text` name?", {
      ...Object.fromEntries(MONTH_KEYS.map((m) => [m, null])),
      none: "No calendar month is named",
    }),
    ask_expense_category: choice("Which spending category is `text` about?", {
      ...exp.options,
      all: "Spending overall, not one particular category",
    }),
    ask_income_category: choice("Which income category is `text` about?", {
      ...inc.options,
      all: "Income overall, not one particular category",
    }),
    ask_account: choice("Which of the user's accounts is `text` about?", {
      ...acc.options,
      all: "All accounts together, or no particular account",
    }),
  };
  if (Object.keys(con.options).length) {
    questions.ask_contact = choice("Which person or business is `text` about?", {
      ...con.options,
      none: "No particular person or business",
    });
  }
  return { questions, exp, inc, acc, con };
}

function resolvePeriod(key: string, monthKey: string | null, ctx: AssistContext) {
  const now = today(ctx.entity.timezone);
  const thisMonth = monthOf(now);
  const fy = (d: string) => fiscalYear(d, ctx.entity.fyStartMonth);
  const weekStart = addDays(now, -weekdayIndex(now));
  switch (key) {
    case "today":
      return { from: now, to: now, label: "today" };
    case "yesterday":
      return { from: addDays(now, -1), to: addDays(now, -1), label: "yesterday" };
    case "this_week":
      return { from: weekStart, to: now, label: "this week" };
    case "last_week":
      return { from: addDays(weekStart, -7), to: addDays(weekStart, -1), label: "last week" };
    case "last_month": {
      const m = addMonths(thisMonth, -1);
      return { ...monthRange(m), label: `in ${monthLabel(m)}` };
    }
    case "named_month": {
      const idx = monthKey ? MONTH_KEYS.indexOf(monthKey) : -1;
      if (idx < 0) break;
      // The most recent such month that has started.
      let m = `${now.slice(0, 4)}-${String(idx + 1).padStart(2, "0")}`;
      if (m > thisMonth) m = addMonths(m, -12);
      return { ...monthRange(m), label: `in ${monthLabel(m)}` };
    }
    case "this_fy": {
      const f = fy(now);
      return { from: f.from, to: f.to, label: `in ${f.label}` };
    }
    case "last_fy": {
      const f = fy(addDays(fy(now).from, -1));
      return { from: f.from, to: f.to, label: `in ${f.label}` };
    }
    case "this_year":
      return { from: `${now.slice(0, 4)}-01-01`, to: `${now.slice(0, 4)}-12-31`, label: `in ${now.slice(0, 4)}` };
    case "last_year": {
      const y = Number(now.slice(0, 4)) - 1;
      return { from: `${y}-01-01`, to: `${y}-12-31`, label: `in ${y}` };
    }
    case "all_time":
      return { from: "1900-01-01", to: "2999-12-31", label: "in total" };
  }
  return { ...monthRange(thisMonth), label: `in ${monthLabel(thisMonth)}` };
}

/** Ledger reads the ask flow needs; supplied by the route so this module stays DB-free. */
export interface AskData {
  totals(from: string, to: string, kind: "expense" | "income", filter: { categoryId?: string | null; contactId?: string | null }): Promise<{ amount: number; count: number }>;
  transactions(from: string, to: string, filter: { categoryId?: string | null; accountId?: string | null; contactId?: string | null }, limit: number): Promise<Transaction[]>;
  budget(categoryId: string | null): Promise<number | null>;
}

async function composeAsk(ctx: AssistContext, text: string, built: ReturnType<typeof askQuestions> | null, answers: Answers | null, data: AskData): Promise<AskResult> {
  const a = answers ?? {};
  const c = (q: string) => a[q] as ChoiceAnswer | undefined;
  const fmt = (n: number) => formatMoney(n, { currency: ctx.entity.currency });
  const { money } = live(ctx.accounts);

  let intent: AskIntent = "unknown";
  let confidence = 0;
  const iq = c("intent");
  if (iq && iq.choice !== "other" && prob(iq, iq.choice) >= BAR.intent) {
    intent = iq.choice as AskIntent;
    confidence = iq.confidence;
  } else if (!answers) {
    const t = text.toLowerCase();
    intent = /owe|owes|lent|borrow/.test(t)
      ? "owed"
      : /balance|net worth|how much (do i|is) (have|in)/.test(t)
        ? "balance"
        : /budget/.test(t)
          ? "budget"
          : /earn|income|received|salary/.test(t)
            ? "income"
            : /spen|spent|cost/.test(t)
              ? "spending"
              : "transactions";
    confidence = 0.3;
  }

  const pick = (q: string, map: Map<string, string> | undefined, none = "all") => {
    const ans = c(q);
    if (!ans || ans.choice === none || ans.confidence < BAR.category) return null;
    return map?.get(ans.choice) ?? null;
  };
  const contactId = pick("ask_contact", built?.con.idOf, "none") ?? (!answers ? (shortlistContacts(text, ctx.contacts)[0]?.contact.id ?? null) : null);
  const contact = contactId ? ctx.contacts.find((x) => x.id === contactId) : undefined;
  const named = (a.period_named?.noul ?? 0) >= BAR.named;
  const pq = c("period");
  const mq = c("month");
  const periodKey = named && pq ? pq.choice : contact ? "all_time" : "this_month";
  const period = resolvePeriod(periodKey, mq && mq.choice !== "none" ? mq.choice : null, ctx);
  const name = (id: string | null) => ctx.accounts.find((x) => x.id === id)?.name ?? "";

  const result: AskResult = { intent, answer: "", period, categoryId: null, accountId: null, contactId: contact?.id ?? null, value: null, transactions: [], confidence };

  switch (intent) {
    case "spending":
    case "income": {
      const kind = intent === "spending" ? "expense" : "income";
      const categoryId = pick(intent === "spending" ? "ask_expense_category" : "ask_income_category", intent === "spending" ? built?.exp.idOf : built?.inc.idOf);
      const { amount, count } = await data.totals(period.from, period.to, kind, { categoryId, contactId: contact?.id });
      result.categoryId = categoryId;
      result.value = amount;
      result.transactions = await data.transactions(period.from, period.to, { categoryId, contactId: contact?.id }, 8);
      const what = [categoryId ? ` on ${name(categoryId)}` : "", contact ? ` ${intent === "spending" ? "with" : "from"} ${contact.name}` : ""].join("");
      const verb = intent === "spending" ? "spent" : "received";
      result.answer =
        count === 0
          ? `Nothing ${verb}${what} ${period.label}.`
          : `${fmt(amount)} ${verb}${what} ${period.label}, across ${count} transaction${count === 1 ? "" : "s"}.`;
      break;
    }
    case "owed": {
      result.period = null;
      if (contact) {
        result.value = contact.balance;
        result.answer =
          contact.balance > 0
            ? `${contact.name} owes you ${fmt(contact.balance)}.`
            : contact.balance < 0
              ? `You owe ${contact.name} ${fmt(-contact.balance)}.`
              : `You and ${contact.name} are settled up.`;
        result.transactions = await data.transactions("1900-01-01", "2999-12-31", { contactId: contact.id }, 8);
      } else {
        const open = ctx.contacts.filter((x) => x.balance !== 0).sort((x, y) => Math.abs(y.balance) - Math.abs(x.balance));
        const owedToYou = open.filter((x) => x.balance > 0);
        const youOwe = open.filter((x) => x.balance < 0);
        result.balances = open.map((x) => ({ contactId: x.id, balance: x.balance }));
        result.value = open.reduce((s, x) => s + x.balance, 0);
        const lines = [
          owedToYou.length ? `${owedToYou.length === 1 ? owedToYou[0].name : `${owedToYou.length} people`} owe${owedToYou.length === 1 ? "s" : ""} you ${fmt(owedToYou.reduce((s, x) => s + x.balance, 0))}` : null,
          youOwe.length ? `you owe ${youOwe.length === 1 ? youOwe[0].name : `${youOwe.length} people`} ${fmt(-youOwe.reduce((s, x) => s + x.balance, 0))}` : null,
        ].filter(Boolean);
        result.answer = lines.length ? `${lines.join("; ").replace(/^./, (ch) => ch.toUpperCase())}.` : "Nobody owes anybody. You're settled up with everyone.";
      }
      break;
    }
    case "balance": {
      result.period = null;
      const accountId = pick("ask_account", built?.acc.idOf);
      if (accountId) {
        const acct = money.find((m) => m.id === accountId)!;
        result.accountId = accountId;
        result.value = displayBalance(acct.type, acct.balance);
        result.answer = acct.type === "liability" ? `You owe ${fmt(result.value)} on ${acct.name}.` : `${acct.name} has ${fmt(result.value)}.`;
      } else {
        const iou = ctx.accounts.find((x) => x.id === ctx.entity.iouAccountId)?.balance ?? 0;
        const assets = money.filter((m) => m.type === "asset").reduce((s, m) => s + m.balance, 0) + Math.max(0, iou);
        const owed = money.filter((m) => m.type === "liability").reduce((s, m) => s - m.balance, 0) + Math.max(0, -iou);
        result.value = assets - owed;
        result.answer = `Net worth is ${fmt(assets - owed)}: ${fmt(assets)} held, ${fmt(owed)} owed.`;
      }
      break;
    }
    case "budget": {
      const thisMonth = monthRange(monthOf(today(ctx.entity.timezone)));
      const categoryId = pick("ask_expense_category", built?.exp.idOf);
      const budget = await data.budget(categoryId);
      const { amount } = await data.totals(thisMonth.from, thisMonth.to, "expense", { categoryId });
      result.period = { ...thisMonth, label: "this month" };
      result.categoryId = categoryId;
      const what = categoryId ? `${name(categoryId)} budget` : "total budget";
      if (!budget) {
        result.answer = `No ${what} is set. You've spent ${fmt(amount)} this month.`;
      } else {
        const left = budget - amount;
        result.value = left;
        result.answer =
          left >= 0
            ? `${fmt(left)} left of your ${fmt(budget)} ${what} (${Math.round((amount / budget) * 100)}% used).`
            : `Over the ${fmt(budget)} ${what} by ${fmt(-left)}.`;
      }
      break;
    }
    case "transactions": {
      const categoryId = pick("ask_expense_category", built?.exp.idOf) ?? pick("ask_income_category", built?.inc.idOf);
      const accountId = pick("ask_account", built?.acc.idOf);
      result.categoryId = categoryId;
      result.accountId = accountId;
      result.transactions = await data.transactions(period.from, period.to, { categoryId, accountId, contactId: contact?.id }, 20);
      const what = [categoryId && name(categoryId), contact && `with ${contact.name}`, accountId && `from ${name(accountId)}`].filter(Boolean).join(" ");
      result.answer = result.transactions.length
        ? `${result.transactions.length === 20 ? "Latest 20" : result.transactions.length} transaction${result.transactions.length === 1 ? "" : "s"}${what ? ` · ${what}` : ""} ${period.label}.`
        : `No transactions${what ? ` ${what}` : ""} ${period.label}.`;
      break;
    }
    default:
      result.period = null;
      result.answer = "I couldn't turn that into a question about these books. Try “spent on food last month”, “balance in cash” or “who owes me”.";
  }
  return result;
}

// ---- Finding contacts in old notes ---------------------------------------------

export interface ContactSuggestion {
  contactId: string | null;
  name: string;
  kind: "person" | "business";
  transactionIds: string[];
  examples: string[];
  probability: number;
}

/**
 * Past notes like "Swiggy, dinner" already name merchants. Code matches known
 * contacts and collects candidate words; Jev answers one yes/no per word
 * ("is this a business or person?") in a single request. That's the
 * many-candidates pattern: per-candidate Nouls, never one wide Choice.
 */
export async function findContactsInNotes(env: Env, rows: { id: string; note: string }[], contacts: Contact[], vocabulary: string[]): Promise<ContactSuggestion[]> {
  const out = new Map<string, ContactSuggestion>();
  const unmatched: typeof rows = [];
  for (const r of rows) {
    const best = shortlistContacts(r.note, contacts, 1)[0];
    if (best && best.score >= 2) {
      const s = out.get(best.contact.id) ?? { contactId: best.contact.id, name: best.contact.name, kind: best.contact.kind, transactionIds: [], examples: [], probability: 1 };
      s.transactionIds.push(r.id);
      if (s.examples.length < 3) s.examples.push(r.note);
      out.set(best.contact.id, s);
    } else unmatched.push(r);
  }

  const client = jevClient(env);
  if (client && unmatched.length) {
    const skip = new Set([...STOP, ...vocabulary.flatMap(words), ...MONTH_KEYS, ...MONTH_KEYS.map((m) => m.slice(0, 3))]);
    const byWord = new Map<string, typeof rows>();
    for (const r of unmatched) {
      for (const w of new Set(words(r.note).filter((x) => x.length >= 3 && !skip.has(x) && !/^\d/.test(x)))) byWord.set(w, [...(byWord.get(w) ?? []), r]);
    }
    const candidates = [...byWord.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, 25);
    if (candidates.length) {
      const state = {
        candidates: Object.fromEntries(candidates.map(([w, rs], i) => [`c${i}`, { word: w, seen_in: rs.slice(0, 3).map((r) => r.note) }])),
      };
      const questions: Record<string, Question> = {};
      candidates.forEach((_, i) => {
        questions[`c${i}_name`] = noul(`Is \`candidates.c${i}.word\` the name of a specific business, brand, app or person, rather than an item, an activity, a place or a description?`);
        questions[`c${i}_person`] = noul(`Is \`candidates.c${i}.word\` an individual person, such as a friend or relative, rather than a business?`);
      });
      try {
        const res = await client.systemOne({ state, questions: questions as Parameters<TypeSafeClient["systemOne"]>[0]["questions"] });
        const ans = res.answers as unknown as Answers;
        candidates.forEach(([w, rs], i) => {
          const p = ans[`c${i}_name`]?.noul ?? 0;
          if (p < BAR.isName) return;
          out.set(`new:${w}`, {
            contactId: null,
            name: titleCase(w),
            kind: (ans[`c${i}_person`]?.noul ?? 0) >= 0.5 ? "person" : "business",
            transactionIds: rs.map((r) => r.id),
            examples: rs.slice(0, 3).map((r) => r.note),
            probability: p,
          });
        });
      } catch (err) {
        console.error("jev contact scan failed", err instanceof Error ? err.message : err);
      }
    }
  }
  // A transaction goes to one suggestion only: the first (most frequent) claim wins.
  const claimed = new Set<string>();
  return [...out.values()]
    .sort((x, y) => y.transactionIds.length - x.transactionIds.length)
    .map((s) => ({ ...s, transactionIds: s.transactionIds.filter((id) => !claimed.has(id) && claimed.add(id)) }))
    .filter((s) => s.transactionIds.length > 0);
}

// ---- Entry point -------------------------------------------------------------

const looksLikeQuestion = (t: string) => /\?\s*$|^(how|what|show|list|when|which|who|did|do|does|am|is|are|was|where)\b/i.test(t.trim());

export async function assist(
  env: Env,
  ctx: AssistContext,
  text: string,
  opts: { mode: "auto" | "record" | "ask"; kind?: EntryKind; debug?: boolean },
  data: AskData,
): Promise<AssistResult & { raw?: unknown }> {
  const started = Date.now();
  const client = jevClient(env);
  const wantRecord = opts.mode !== "ask";
  const wantAsk = opts.mode !== "record";
  const parseBuilt = wantRecord ? parseQuestions(ctx, text, opts.kind) : null;
  const askBuilt = wantAsk ? askQuestions(ctx, text) : null;

  let answers: Answers | null = null;
  let model: string | undefined;
  let usage: AssistResult["usage"];
  if (client) {
    // One request, all questions in parallel: the speculative branch we don't
    // use costs a few tokens but saves a second round trip.
    const questions: Record<string, unknown> = { ...parseBuilt?.questions, ...askBuilt?.questions };
    if (opts.mode === "auto") {
      questions.mode = choice("Is `text` recording a new transaction, or asking about money already recorded?", {
        record: "Recording a payment, purchase, income, transfer, or money given to or received from someone, usually with an amount",
        ask: "Asking a question about spending, income, balances, budgets, who owes whom, or past transactions",
      });
    }
    try {
      const res = await client.systemOne({
        state: { text, entity: { name: ctx.entity.name, kind: ctx.entity.kind } },
        questions: questions as Parameters<TypeSafeClient["systemOne"]>[0]["questions"],
      });
      answers = res.answers as unknown as Answers;
      model = res.model;
      usage = { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 };
    } catch (err) {
      console.error("jev failed; falling back to rules", err instanceof Error ? err.message : err);
    }
  }

  let mode: "record" | "ask" = opts.mode === "ask" ? "ask" : "record";
  if (opts.mode === "auto") {
    const m = answers?.mode as { choice: string } | undefined;
    mode = m ? (m.choice as "record" | "ask") : looksLikeQuestion(text) ? "ask" : "record";
    // An entry with no number can't be recorded; treat it as a question.
    if (mode === "record" && parseBuilt && parseBuilt.pre.amounts.length === 0 && looksLikeQuestion(text)) mode = "ask";
  }

  const result: AssistResult & { raw?: unknown } = { mode, source: answers ? "jev" : "rules", model, ms: 0, usage };
  if (opts.debug) result.raw = answers;
  if (mode === "record" && parseBuilt) result.parse = composeParse(ctx, text, opts.kind, parseBuilt, answers);
  if (mode === "ask") result.ask = await composeAsk(ctx, text, askBuilt, answers, data);
  result.ms = Date.now() - started;
  return result;
}

// ---- Statement lines -------------------------------------------------------------

export interface LineToClassify {
  key: number;
  description: string;
  name: string | null;
  upiId: string | null;
  mode: string;
  /** Money out of / into the account being imported. */
  direction: "out" | "in";
  amountText: string;
}

export interface LineGuess {
  kind: EntryKind;
  kindConf: number;
  categoryId: string | null;
  categoryConf: number;
  contactId: string | null;
  newContact: { name: string; kind: "person" | "business" } | null;
  /** The user's other account for a transfer. */
  otherAccountId: string | null;
  why: string[];
}

// No lending/borrowing here: whether someone owes you is a judgement only the
// user can make. A payment to a person is spending (or income) until they say otherwise.
const LINE_KINDS = {
  out: {
    expense: "Paying for something or someone: a purchase, a bill, a fee, a subscription, a service, or a UPI payment to a shop or person",
    transfer: "Moving the user's own money to another of their own accounts: paying their own credit card bill, investing, or moving savings to themselves",
  },
  in: {
    income: "Money earned or received: salary, a client or customer payment, interest, a refund, a gift, or money from a person",
    transfer: "Money arriving from another of the user's own accounts",
  },
};

/**
 * Classifies statement lines the code couldn't settle on its own. Code first
 * (learned UPI IDs, ATM, card payments, your own account numbers, history);
 * Jev only for what's left, several lines per request.
 */
export async function classifyLines(
  env: Env,
  ctx: AssistContext & { accountId: string; identifiers: Map<string, string> },
  lines: LineToClassify[],
): Promise<Map<number, LineGuess>> {
  const out = new Map<number, LineGuess>();
  const { money, expense, income } = live(ctx.accounts);
  const others = money.filter((a) => a.id !== ctx.accountId);
  const self = ctx.accounts.find((a) => a.id === ctx.accountId);
  const byName = (pool: Account[], re: RegExp) => pool.find((a) => re.test(a.name));
  const contacts = ctx.contacts.filter((c) => !c.archived);
  const todo: { line: LineToClassify; guess: LineGuess; shortlist: { contact: Contact }[]; names: string[] }[] = [];

  for (const line of lines) {
    const g: LineGuess = {
      kind: line.direction === "out" ? "expense" : "income",
      kindConf: 0,
      categoryId: null,
      categoryConf: 0,
      contactId: null,
      newContact: null,
      otherAccountId: null,
      why: [],
    };
    // Your own account numbers in the narration mean a transfer.
    const own = others.find((a) => a.numberLast4 && new RegExp(`(?:\\b|x)${a.numberLast4}\\b`, "i").test(line.description));
    // The account holder's own name ("ASHA RAO", "asharao@okaxis") = money to themselves.
    const selfWords = ctx.entity.kind === "personal" ? words(ctx.entity.name).filter((w) => w.length >= 3) : [];
    const flat = line.description.toLowerCase().replace(/[^a-z]/g, "");
    const isSelf = selfWords.length >= 2 && (selfWords.every((w) => flat.includes(w)));
    if (own) {
      Object.assign(g, { kind: "transfer", kindConf: 1, otherAccountId: own.id });
      g.why.push(`mentions ${own.name}`);
    } else if (isSelf) {
      Object.assign(g, { kind: "transfer", kindConf: 0.9 });
      g.why.push("to/from yourself");
    } else if (line.mode === "atm" && self?.subtype !== "cash") {
      const cash = others.find((a) => a.subtype === "cash");
      if (cash) Object.assign(g, { kind: "transfer", kindConf: 1, otherAccountId: cash.id });
      g.why.push("ATM withdrawal");
    } else if (line.mode === "card_payment") {
      // Which card (or bank) is on the other side isn't in the narration: never guess it.
      // The transfer parks in "Transfers in transit" until the other statement claims it.
      Object.assign(g, { kind: "transfer", kindConf: 0.9 });
      g.why.push("card payment, other side not named");
    }
    if (g.kind !== "transfer") {
      if (line.upiId && ctx.identifiers.has(line.upiId)) {
        g.contactId = ctx.identifiers.get(line.upiId)!;
        g.why.push("known UPI ID");
      }
      if (line.mode === "charges" && line.direction === "out") {
        const cat = byName(expense, /bank|charges|fees/i);
        if (cat) Object.assign(g, { categoryId: cat.id, categoryConf: 0.9, kindConf: 0.9 });
      }
      if (line.mode === "interest" && line.direction === "in") {
        const cat = byName(income, /interest/i);
        if (cat) Object.assign(g, { categoryId: cat.id, categoryConf: 0.9, kindConf: 0.9 });
      }
    }
    out.set(line.key, g);
    const settled = g.kind === "transfer" ? g.kindConf >= 0.9 : !!g.categoryId && (!!g.contactId || line.mode === "charges" || line.mode === "interest");
    // Charges and interest have no counterparty worth a contact.
    if (!settled && (line.mode === "charges" || line.mode === "interest")) g.why.push("no contact for charges");
    if (!settled) {
      const text = `${line.name ?? ""} ${line.description}`;
      const noContact = line.mode === "charges" || line.mode === "interest";
      const shortlist = g.contactId || noContact ? [] : shortlistContacts(text, contacts, 6);
      const known = new Set([...money, ...expense, ...income].flatMap((a) => words(a.name)));
      const names = g.contactId || noContact ? [] : nameCandidates(line.name ?? "", known).slice(0, 5);
      todo.push({ line, guess: g, shortlist, names });
    }
  }

  const client = jevClient(env);
  const exp = optionsFor(expense);
  const inc = optionsFor(income);
  const BATCH = 6;
  for (let start = 0; client && start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH);
    const state: Record<string, unknown> = { entity: { name: ctx.entity.name, kind: ctx.entity.kind }, lines: {} };
    const questions: Record<string, Question> = {};
    batch.forEach(({ line, guess, shortlist, names }, i) => {
      const p = `l${i}`;
      (state.lines as Record<string, unknown>)[p] = {
        narration: line.description,
        payee: line.name,
        direction: line.direction === "out" ? "money out of the account" : "money into the account",
        amount: line.amountText,
      };
      const ref = `\`lines.${p}\``;
      if (guess.kindConf < 0.9) questions[`${p}_kind`] = choice(`What kind of money movement is the bank statement line ${ref}?`, LINE_KINDS[line.direction]);
      if (!guess.categoryId) {
        questions[`${p}_cat`] = choice(
          `If ${ref} is ${line.direction === "out" ? "spending" : "money received"}, which category does it belong to?`,
          { ...(line.direction === "out" ? exp : inc).options, unclear: `None of these clearly fits ${ref}` },
        );
      }
      if (shortlist.length) {
        questions[`${p}_contact`] = choice(`Which of these is the person or business on the other side of ${ref}?`, {
          ...contactOptions(shortlist).options,
          none: "None of them",
        });
      }
      if (names.length) {
        questions[`${p}_name`] = choice(`Which words in ${ref} name the person or business on the other side?`, {
          ...Object.fromEntries(names.map((n) => [n, null])),
          none: "No person or business is named",
        });
        questions[`${p}_person`] = noul(`Is the one named in ${ref} an individual person rather than a business?`);
      }
    });
    let ans: Answers;
    try {
      ans = (
        await client.systemOne({
          state: state as Parameters<TypeSafeClient["systemOne"]>[0]["state"],
          questions: questions as Parameters<TypeSafeClient["systemOne"]>[0]["questions"],
        })
      ).answers as unknown as Answers;
    } catch (err) {
      console.error("jev line classification failed", err instanceof Error ? err.message : err);
      break;
    }
    batch.forEach(({ line, guess, shortlist }, i) => {
      const p = `l${i}`;
      const get = (q: string) => ans[`${p}_${q}`] as ChoiceAnswer | undefined;
      const cat = get("cat");
      const kq = get("kind");
      if (kq) {
        const fit = cat ? 1 - prob(cat, "unclear") : 1;
        const scores = Object.keys(LINE_KINDS[line.direction]).map((k) => [k, prob(kq, k) * (k === "expense" || k === "income" ? fit : 1)] as const);
        const total = scores.reduce((s, [, v]) => s + v, 0) || 1;
        const [best, score] = scores.reduce((a, b) => (b[1] > a[1] ? b : a));
        guess.kind = best as EntryKind;
        guess.kindConf = score / total;
      }
      if (cat && cat.choice !== "unclear" && !guess.categoryId) {
        guess.categoryId = (line.direction === "out" ? exp : inc).idOf.get(cat.choice) ?? null;
        guess.categoryConf = cat.confidence;
      }
      const cq = get("contact");
      if (!guess.contactId && cq && cq.choice !== "none" && prob(cq, cq.choice) >= BAR.contact) {
        guess.contactId = contactOptions(shortlist).idOf.get(cq.choice) ?? null;
      }
      const nq = get("name");
      if (!guess.contactId && nq && nq.choice !== "none" && prob(nq, nq.choice) >= BAR.newContact) {
        guess.newContact = { name: titleCase(nq.choice), kind: (ans[`${p}_person`]?.noul ?? 0) >= 0.5 ? "person" : "business" };
      }
    });
  }

  // Your history with a contact beats a loose read of a cryptic narration.
  for (const { guess } of todo) {
    const contact = guess.contactId ? contacts.find((c) => c.id === guess.contactId) : undefined;
    if ((guess.kind === "expense" || guess.kind === "income") && contact?.topCategoryId && guess.categoryConf < BAR.categoryOverHistory) {
      const pool = guess.kind === "expense" ? expense : income;
      if (pool.some((c) => c.id === contact.topCategoryId)) {
        guess.categoryId = contact.topCategoryId;
        guess.categoryConf = 0.8;
        guess.why.push(`usual category for ${contact.name}`);
      }
    }
    if ((guess.kind === "expense" || guess.kind === "income") && guess.categoryConf < 0.5) guess.categoryId = null;
  }
  return out;
}

/**
 * When several recorded transactions have the same amount and date as a
 * statement line, ask one yes/no per pair: is this the same payment?
 */
export async function samePaymentScores(env: Env, pairs: { key: string; line: string; recorded: string }[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const client = jevClient(env);
  if (!client || !pairs.length) return scores;
  for (let i = 0; i < pairs.length; i += 20) {
    const batch = pairs.slice(i, i + 20);
    const state = { pairs: Object.fromEntries(batch.map((p, j) => [`p${j}`, { statement_line: p.line, recorded: p.recorded }])) };
    const questions = Object.fromEntries(
      batch.map((_, j) => [`p${j}`, noul(`Do \`pairs.p${j}.statement_line\` and \`pairs.p${j}.recorded\` describe the same payment?`)]),
    );
    try {
      const res = await client.systemOne({ state, questions: questions as Parameters<TypeSafeClient["systemOne"]>[0]["questions"] });
      const ans = res.answers as unknown as Answers;
      batch.forEach((p, j) => scores.set(p.key, ans[`p${j}`]?.noul ?? 0));
    } catch (err) {
      console.error("jev pair scoring failed", err instanceof Error ? err.message : err);
    }
  }
  return scores;
}
