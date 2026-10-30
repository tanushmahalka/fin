// Statement import: map → verify → match → classify → preview → commit.
//
//   POST /imports              statement JSON in, a stored preview (plan) out
//   POST /imports/:id/commit   applies exactly the previewed plan
//   POST /imports/:id/undo     soft-deletes what it created, unlinks what it matched
//   GET  /imports, /imports/:id
//   GET  /review               lines waiting for a person + imported guesses to check
//   POST /evidence/:id/link | /dismiss

import { Hono } from "hono";
import { z } from "zod";
import { addDays } from "../../shared/dates";
import { uuidv7 } from "../../shared/ids";
import { buildPostings, displayBalance, LedgerError, storedKind } from "../../shared/ledger";
import { formatMoney } from "../../shared/money";
import { type Candidate, dayGap, findReversals, last4Of, type Line, lineKey, type StatementV1, verifyStatement, tidyNote } from "../../shared/statement";
import type { Account, ImportPlan, PlannedLine, ReviewItem, Transaction } from "../../shared/types";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import { AppError, type AppEnv, type Ctx, all, badRequest, first, need, notFound, now, parseBody, sql } from "../http";
import { classifyLines, samePaymentScores } from "../jev";
import { loadAccounts, loadAccountTypes, loadContacts, TX_SELECT, type TxRow, txView } from "../views";

const WINDOW = { bank: 3, card: 5 };
const UNCATEGORISED = { expense: "Uncategorised", income: "Uncategorised income" };

const unmapped = (message: string) => new AppError(422, "unmapped_account", message);
const invalid = (message: string) => new AppError(422, "invalid_statement", message);

const statementSchema = z.object({
  version: z.literal(1),
  account: z.object({
    institution: z.string().nullish(),
    number: z.string().nullish(),
    last4: z.string().nullish(),
    ifsc: z.string().nullish(),
    holder: z.string().nullish(),
    type: z.enum(["bank", "card"]).nullish(),
  }),
  currency: z.string().nullish(),
  period: z.object({ from: z.string(), to: z.string() }),
  openingBalance: z.union([z.string(), z.number()]),
  closingBalance: z.union([z.string(), z.number()]),
  lines: z
    .array(
      z.object({
        date: z.string(),
        description: z.string(),
        reference: z.union([z.string(), z.number()]).nullish().transform((v) => (v === null || v === undefined ? v : String(v))),
        debit: z.union([z.string(), z.number()]).nullish(),
        credit: z.union([z.string(), z.number()]).nullish(),
        balance: z.union([z.string(), z.number()]).nullish(),
      }),
    )
    .max(5000),
});

const words = (s: string | null | undefined) => new Set((s ?? "").toLowerCase().match(/[a-z]{3,}/g) ?? []);

/**
 * Which account is this statement? Exact identifiers only: the last 4 digits
 * must point at exactly one account (and the bank must agree when both say).
 * A confident guess at an account's identity is still a guess, so anything
 * else is an error with the fix spelled out.
 */
function mapAccount(st: StatementV1, accounts: Account[], overrideId?: string | null): { account: Account; link: Partial<Account> | null; warning?: string } {
  const money = accounts.filter((a) => (a.type === "asset" || a.type === "liability") && !a.system && !a.archived && !a.parentId);
  const last4 = last4Of(st.account);
  const bank = st.account.institution ?? null;
  const ifsc = st.account.ifsc?.toUpperCase() ?? null;
  const sameBank = (a: Account) => {
    if (ifsc && a.ifsc) return ifsc.slice(0, 4) === a.ifsc.slice(0, 4);
    if (!bank || !a.institution) return true;
    const x = words(bank);
    return [...words(a.institution)].some((w) => x.has(w) && w !== "bank");
  };
  const typeOk = (a: Account) => !st.account.type || (st.account.type === "card") === (a.type === "liability");
  const describe = `${bank ?? "This statement"}${last4 ? ` ••${last4}` : ""}`;

  if (overrideId) {
    const a = money.find((x) => x.id === overrideId);
    if (!a) throw unmapped("That account doesn't exist in this entity.");
    // You chose the account explicitly: a different printed number is reported, not fatal
    // (extraction misreads, reissued cards).
    const warning = a.numberLast4 && last4 && a.numberLast4 !== last4 ? `The statement shows ••${last4} but ${a.name} ends in ${a.numberLast4}; imported into ${a.name} because you chose it.` : undefined;
    if (!typeOk(a)) throw unmapped(`This is a ${st.account.type} statement but ${a.name} is a ${a.type === "liability" ? "card or loan" : "bank or cash"} account.`);
    // Linking by hand teaches the account its details, so the next import maps itself.
    const link = !a.numberLast4 && last4 ? { numberLast4: last4, institution: a.institution ?? bank, ifsc: a.ifsc ?? ifsc } : null;
    return { account: a, link, warning };
  }
  if (!last4) throw unmapped("The statement has no account number. Add account.last4 (or account.number) to the JSON, or choose the account explicitly.");
  const matches = money.filter((a) => a.numberLast4 === last4 && sameBank(a) && typeOk(a));
  if (matches.length === 1) return { account: matches[0], link: null };
  if (matches.length > 1) throw unmapped(`${describe} matches ${matches.map((a) => a.name).join(" and ")}. Give each account its own last 4 digits.`);
  const unlinked = money.filter((a) => !a.numberLast4).map((a) => a.name);
  throw unmapped(
    `${describe} matches none of your accounts.${unlinked.length ? ` Add its statement details to one of: ${unlinked.join(", ")}` : ""} (fin accounts link "<account>" --last4 ${last4 ?? "XXXX"}${bank ? ` --bank "${bank}"` : ""}), or import with --account.`,
  );
}

export const TRANSIT = "Transfers in transit";
const TRANSIT_PLACEHOLDER = "__transit__";

/**
 * Clearing account for money moving between the user's own accounts when the
 * statement doesn't say which account is on the other side (a "CRED payment"
 * could be any card). The other account's statement later claims the entry,
 * turning it into a real transfer. Whatever stays here is a question to answer.
 */
async function transitId(db: D1Database, entityId: string): Promise<string | null> {
  return (await first<{ id: string }>(db, "SELECT id FROM accounts WHERE entity_id = ? AND system = 1 AND name = ?", entityId, TRANSIT))?.id ?? null;
}

async function ensureTransit(c: Ctx, stmts: D1PreparedStatement[]): Promise<string> {
  const existing = await transitId(c.env.DB, c.var.entity.id);
  if (existing) return existing;
  const id = uuidv7();
  stmts.push(
    sql(
      c.env.DB,
      "INSERT INTO accounts (id, entity_id, type, subtype, name, icon, sort, system, group_label, created_at) VALUES (?, ?, 'asset', 'other', ?, '⇄', 998, 1, ?, ?)",
      id,
      c.var.entity.id,
      TRANSIT,
      TRANSIT,
      now(),
    ),
  );
  return id;
}

async function uncategorisedId(c: Ctx, type: "expense" | "income", stmts: D1PreparedStatement[]): Promise<string> {
  const name = UNCATEGORISED[type];
  const row = await first<{ id: string }>(c.env.DB, "SELECT id FROM accounts WHERE entity_id = ? AND type = ? AND name = ? AND system = 1", c.var.entity.id, type, name);
  if (row) return row.id;
  const id = uuidv7();
  stmts.push(
    sql(c.env.DB, "INSERT INTO accounts (id, entity_id, type, name, icon, sort, system, created_at) VALUES (?, ?, ?, ?, '❔', 999, 1, ?)", id, c.var.entity.id, type, name, now()),
  );
  return id;
}

async function loadTxViews(c: Ctx, ids: string[]): Promise<Map<string, Transaction>> {
  const out = new Map<string, Transaction>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const types = await loadAccountTypes(c.env.DB, c.var.entity.id);
  for (let i = 0; i < unique.length; i += 80) {
    const chunk = unique.slice(i, i + 80);
    const rows = await all<TxRow>(c.env.DB, `${TX_SELECT} WHERE t.entity_id = ? AND t.deleted_at IS NULL AND t.id IN (${chunk.map(() => "?").join(",")})`, c.var.entity.id, ...chunk);
    for (const r of rows) out.set(r.id, txView(r, types, c.var.entity.iou_account_id));
  }
  return out;
}

/** Everything the plan refers to, so a preview can be shown without more requests. */
async function withRelated(c: Ctx, plan: ImportPlan) {
  const ids = [...plan.notOnStatement, ...plan.lines.flatMap((l) => [l.transactionId, ...(l.candidates ?? [])]).filter((x): x is string => !!x)];
  const related = Object.fromEntries(await loadTxViews(c, ids));
  return { ...plan, related };
}

async function buildPlan(c: Ctx, st: StatementV1, overrideId: string | null): Promise<{ plan: ImportPlan; link: Partial<Account> | null; fileSha: string }> {
  const db = c.env.DB;
  const entity = c.var.entity;
  const [accounts, contacts] = await Promise.all([loadAccounts(db, entity), loadContacts(db, entity)]);
  const { account, link, warning: mapWarning } = mapAccount(st, accounts, overrideId);
  const liability = account.type === "liability";
  const window = liability ? WINDOW.card : WINDOW.bank;

  const verified = verifyStatement(st, liability);
  if (verified.errors.length) throw invalid(verified.errors.slice(0, 5).join(" "));
  const { lines, opening, closing } = verified;
  const from = st.period.from;
  const to = st.period.to;
  const warnings: string[] = mapWarning ? [mapWarning] : [];
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });

  // 1. Seen before? Same line, same fingerprint.
  const keys = new Map<number, string>();
  for (const l of lines) keys.set(l.lineNo, await sha256Hex(lineKey(account.id, l)));
  const seen = new Set<string>();
  const allKeys = [...keys.values()];
  for (let i = 0; i < allKeys.length; i += 80) {
    const chunk = allKeys.slice(i, i + 80);
    const rows = await all<{ fingerprint: string }>(db, `SELECT fingerprint FROM evidence WHERE entity_id = ? AND fingerprint IN (${chunk.map(() => "?").join(",")})`, entity.id, ...chunk);
    rows.forEach((r) => seen.add(r.fingerprint));
  }

  // 2. What the ledger already has for this account around the period, not yet confirmed by a statement.
  const recorded = await all<TxRow>(
    db,
    `${TX_SELECT} WHERE t.entity_id = ? AND t.deleted_at IS NULL AND t.date >= ? AND t.date <= ?
       AND EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.account_id = ?)
       AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.transaction_id = t.id AND e.account_id = ? AND e.source = 'statement' AND e.status = 'linked')`,
    entity.id,
    addDays(from, -window),
    addDays(to, window),
    account.id,
    account.id,
  );
  const types = await loadAccountTypes(db, entity.id);
  const names = new Map(contacts.map((x) => [x.id, x.name]));
  const candidates: (Candidate & { tx: Transaction })[] = recorded.map((r) => {
    const tx = txView(r, types, entity.iou_account_id);
    const amount = tx.postings.filter((p) => p.accountId === account.id).reduce((s, p) => s + p.amount, 0);
    const label = [tx.note, tx.contactId && names.get(tx.contactId), tx.categoryId && types.get(tx.categoryId)?.name, tx.kind].filter(Boolean).join(" · ");
    return { transactionId: tx.id, date: tx.date, amount, label: `${label} on ${tx.date}`, sameness: [tx.kind, tx.categoryId, tx.contactId, tx.note?.toLowerCase()].join("|"), tx };
  });
  const references = new Map(
    (await all<{ reference: string; transaction_id: string }>(
      db,
      // Only sightings from other sources (SMS, email): a statement never confirms the same line twice,
      // and a refund reuses its original payment's UPI reference.
      "SELECT reference, transaction_id FROM evidence WHERE entity_id = ? AND account_id = ? AND reference IS NOT NULL AND status = 'linked' AND source <> 'statement'",
      entity.id,
      account.id,
    )).map((r) => [r.reference, r.transaction_id]),
  );

  // Parked legs another statement couldn't place: this line may be the other side.
  const transit = await transitId(db, entity.id);
  const parked = transit
    ? await all<{ posting_id: string; transaction_id: string; amount: number; date: string }>(
        db,
        `SELECT p.id AS posting_id, t.id AS transaction_id, p.amount, t.date FROM postings p JOIN transactions t ON t.id = p.transaction_id
         WHERE p.entity_id = ? AND p.account_id = ? AND t.deleted_at IS NULL AND t.date >= ? AND t.date <= ?
           AND NOT EXISTS (SELECT 1 FROM postings q WHERE q.transaction_id = t.id AND q.account_id = ?)`,
        entity.id,
        transit,
        addDays(from, -window),
        addDays(to, window),
        account.id,
      )
    : [];
  const claimedParked = new Set<string>();

  // 3. Match, one statement line per recorded transaction.
  const reversals = findReversals(lines.filter((l) => !seen.has(keys.get(l.lineNo)!)));
  const claimed = new Set<string>();
  const planned = new Map<number, PlannedLine>();
  const ambiguous: { line: Line; options: typeof candidates }[] = [];
  const base = (l: Line): PlannedLine => ({
    lineNo: l.lineNo,
    date: l.date,
    amount: l.amount,
    balance: l.balance,
    description: l.description,
    reference: l.reference,
    upiId: l.upiId,
    action: "new",
  });
  for (const l of lines) {
    const p = base(l);
    planned.set(l.lineNo, p);
    if (seen.has(keys.get(l.lineNo)!)) {
      p.action = "duplicate";
      continue;
    }
    if (reversals.has(l.lineNo)) {
      p.action = "reversal";
      continue;
    }
    const byRef = l.reference ? references.get(l.reference) : undefined;
    if (byRef && !claimed.has(byRef)) {
      Object.assign(p, { action: "link", transactionId: byRef, match: "reference" });
      claimed.add(byRef);
      continue;
    }
    const exact = candidates
      .filter((x) => !claimed.has(x.transactionId) && x.amount === l.amount && dayGap(x.date, l.date) <= window)
      .sort((a, b) => dayGap(a.date, l.date) - dayGap(b.date, l.date));
    if (exact.length === 1 || (exact.length > 1 && exact.every((x) => x.sameness === exact[0].sameness))) {
      Object.assign(p, { action: "link", transactionId: exact[0].transactionId, match: "auto" });
      claimed.add(exact[0].transactionId);
      continue;
    }
    if (exact.length > 1) {
      ambiguous.push({ line: l, options: exact });
      continue;
    }
    // The other side of a transfer another statement parked: same amount, opposite account.
    const pk = parked
      .filter((x) => !claimedParked.has(x.posting_id) && x.amount === l.amount && dayGap(x.date, l.date) <= window)
      .sort((a, b) => dayGap(a.date, l.date) - dayGap(b.date, l.date))[0];
    if (pk) {
      Object.assign(p, { action: "link", transactionId: pk.transaction_id, match: "transit", transitPostingId: pk.posting_id });
      claimedParked.add(pk.posting_id);
      claimed.add(pk.transaction_id);
      continue;
    }
    const tolerance = Math.max(200, Math.round(Math.abs(l.amount) * 0.01));
    const near = candidates
      .filter((x) => !claimed.has(x.transactionId) && Math.sign(x.amount) === Math.sign(l.amount) && Math.abs(x.amount - l.amount) <= tolerance && dayGap(x.date, l.date) <= window)
      .sort((a, b) => Math.abs(a.amount - l.amount) - Math.abs(b.amount - l.amount));
    if (near.length) {
      Object.assign(p, {
        action: "pending",
        candidates: near.map((x) => x.transactionId),
        reason: `Close to what you recorded (${fmt(Math.abs(near[0].amount))}) but the statement says ${fmt(Math.abs(l.amount))}.`,
      });
    }
  }

  // Several identical-amount candidates that differ: one yes/no per pair from Jev.
  if (ambiguous.length) {
    const pairs = ambiguous.flatMap(({ line, options }) =>
      options.map((o) => ({ key: `${line.lineNo}:${o.transactionId}`, line: `${line.description} (${line.date})`, recorded: o.label })),
    );
    const scores = await samePaymentScores(c.env, pairs);
    for (const { line, options } of ambiguous) {
      const p = planned.get(line.lineNo)!;
      const ranked = options
        .filter((o) => !claimed.has(o.transactionId))
        .map((o) => ({ o, s: scores.get(`${line.lineNo}:${o.transactionId}`) ?? 0 }))
        .sort((a, b) => b.s - a.s);
      const [best, second] = ranked;
      if (best && best.s >= 0.7 && (!second || best.s - second.s >= 0.25)) {
        Object.assign(p, { action: "link", transactionId: best.o.transactionId, match: "jev" });
        claimed.add(best.o.transactionId);
      } else {
        Object.assign(p, { action: "pending", candidates: ranked.map((r) => r.o.transactionId), reason: "Several transactions you recorded could be this one." });
      }
    }
  }

  // 4. Classify what's genuinely new.
  const fresh = lines.filter((l) => planned.get(l.lineNo)!.action === "new");
  const identifiers = new Map(
    (await all<{ value: string; contact_id: string }>(db, "SELECT value, contact_id FROM contact_identifiers WHERE entity_id = ? AND kind = 'upi'", entity.id)).map((r) => [r.value.toLowerCase(), r.contact_id]),
  );
  const guesses = await classifyLines(
    c.env,
    {
      entity: { name: entity.name, kind: entity.kind, currency: entity.currency, timezone: entity.timezone, fyStartMonth: entity.fy_start_month, iouAccountId: entity.iou_account_id },
      accounts,
      contacts,
      accountId: account.id,
      identifiers,
    },
    fresh.map((l) => ({
      key: l.lineNo,
      description: l.description,
      name: l.parsed.name,
      upiId: l.upiId,
      mode: l.parsed.mode,
      direction: l.amount < 0 ? "out" : "in",
      amountText: fmt(Math.abs(l.amount)),
    })),
  );
  for (const l of fresh) {
    const p = planned.get(l.lineNo)!;
    const g = guesses.get(l.lineNo)!;
    const out = l.amount < 0;
    const amount = Math.abs(l.amount);
    const contactName = g.contactId ? names.get(g.contactId) : g.newContact?.name;
    // The contact is the title; the raw narration stays on the statement evidence.
    // Without a contact, a tidied narration says what it was ("Interest on EMI").
    const note = contactName ? null : (tidyNote(l.parsed.name) ?? tidyNote(l.description.slice(0, 80)));
    const who = g.contactId ? { contactId: g.contactId } : g.newContact ? { newContact: g.newContact } : {};
    // Your own ledger knows who owes whom: money from someone who owes you is
    // most likely them paying back; money to someone you owe, you paying back.
    const person = g.contactId ? contacts.find((x) => x.id === g.contactId && x.kind === "person") : undefined;
    if (person && g.kind !== "transfer" && g.kindConf < 0.8 && ((!out && person.balance > 0) || (out && person.balance < 0))) {
      // An open balance makes a repayment likely, but it's still a guess: flag it.
      g.kind = out ? "gave" : "got";
      g.kindConf = 0.6;
      g.why.push(out ? `possibly paying back ${person.name} (you owe them)` : `possibly ${person.name} paying back ${fmt(person.balance)}`);
    }
    if (g.kind === "transfer" && (g.otherAccountId || g.kindConf >= 0.6)) {
      const other = g.otherAccountId ?? TRANSIT_PLACEHOLDER;
      p.proposal = {
        kind: "transfer",
        date: l.date,
        amount,
        accountId: out ? account.id : other,
        toAccountId: out ? other : account.id,
        note,
        needsReview: g.kindConf < 0.6,
        why: g.why.join(", ") || undefined,
      };
      continue;
    }
    if ((g.kind === "gave" || g.kind === "got") && g.contactId && g.kindConf >= 0.6) {
      p.proposal = { kind: g.kind, date: l.date, amount, accountId: account.id, ...who, note, needsReview: true, why: g.why.join(", ") || undefined };
      continue;
    }
    const kind = out ? "expense" : "income";
    p.proposal = {
      kind,
      date: l.date,
      amount,
      accountId: account.id,
      categoryId: g.categoryId,
      ...who,
      note,
      needsReview: !g.categoryId || g.kindConf < 0.5,
      why: [...g.why, !g.categoryId ? "category unclear" : null].filter(Boolean).join(", ") || undefined,
    };
  }

  // 5. Cross-checks against the ledger.
  const before = await first<{ total: number | null }>(
    db,
    `SELECT SUM(p.amount) AS total FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.entity_id = ? AND p.account_id = ? AND t.deleted_at IS NULL AND t.date < ?`,
    entity.id,
    account.id,
    from,
  );
  const ledgerOpening = displayBalance(account.type, before?.total ?? 0);
  if (ledgerOpening !== opening) {
    warnings.push(
      `Your books show ${fmt(ledgerOpening)} for ${account.name} on ${addDays(from, -1)}, but the statement opens at ${fmt(opening)}. Earlier transactions are missing or the opening balance is off; reconcile ${account.name} after importing.`,
    );
  }
  const notOnStatement = candidates
    .filter((x) => !claimed.has(x.transactionId) && x.date >= from && x.date <= to && x.tx.kind !== "opening" && x.tx.kind !== "adjustment")
    .map((x) => x.transactionId);
  if (notOnStatement.length) warnings.push(`${notOnStatement.length} transaction${notOnStatement.length === 1 ? "" : "s"} you recorded for ${account.name} in this period ${notOnStatement.length === 1 ? "isn't" : "aren't"} on the statement: check the account or date.`);

  const planLines = lines.map((l) => planned.get(l.lineNo)!);
  const count = (a: PlannedLine["action"]) => planLines.filter((l) => l.action === a).length;
  const plan: ImportPlan = {
    id: uuidv7(),
    status: "preview",
    accountId: account.id,
    accountName: account.name,
    period: { from, to },
    opening,
    closing,
    ledgerOpening,
    lines: planLines,
    counts: {
      duplicate: count("duplicate"),
      link: count("link"),
      new: count("new"),
      pending: count("pending"),
      reversal: count("reversal"),
      review: planLines.filter((l) => l.proposal?.needsReview).length,
    },
    notOnStatement,
    warnings,
    createdAt: now(),
    createdByName: c.var.user.name,
    agentName: c.var.agentName,
  };
  const fileSha = await sha256Hex(JSON.stringify(st));
  return { plan, link, fileSha };
}

interface ImportRow {
  id: string;
  account_id: string;
  status: ImportPlan["status"];
  plan: string;
  file_sha256: string | null;
}

async function loadImport(c: Ctx, id: string) {
  const row = await first<ImportRow>(c.env.DB, "SELECT id, account_id, status, plan, file_sha256 FROM statement_imports WHERE id = ? AND entity_id = ?", id, c.var.entity.id);
  if (!row) throw notFound("Import not found.");
  const plan = JSON.parse(row.plan) as ImportPlan & { link?: Partial<Account> | null };
  plan.status = row.status;
  return { row, plan };
}

export const importRoutes = new Hono<AppEnv>()
  .post("/imports", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, z.object({ statement: statementSchema, accountId: z.string().nullish() }));
    const { plan, link, fileSha } = await buildPlan(c, body.statement as StatementV1, body.accountId ?? null);
    await sql(
      c.env.DB,
      `INSERT INTO statement_imports (id, entity_id, account_id, status, period_from, period_to, opening_balance, closing_balance, file_sha256, plan, line_count, created_by, agent_name, created_at)
       VALUES (?, ?, ?, 'preview', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      plan.id,
      c.var.entity.id,
      plan.accountId,
      plan.period.from,
      plan.period.to,
      plan.opening,
      plan.closing,
      fileSha,
      JSON.stringify({ ...plan, link }),
      plan.lines.length,
      c.var.user.id,
      c.var.agentName,
      plan.createdAt,
    ).run();
    return c.json({ plan: await withRelated(c, plan), linksAccount: !!link }, 201);
  })

  .get("/imports", async (c) => {
    const rows = await all<{ id: string; account_id: string; status: string; period_from: string; period_to: string; line_count: number; created_count: number; matched_count: number; review_count: number; created_at: number; agent_name: string | null; name: string }>(
      c.env.DB,
      `SELECT i.id, i.account_id, i.status, i.period_from, i.period_to, i.line_count, i.created_count, i.matched_count, i.review_count, i.created_at, i.agent_name, u.name
       FROM statement_imports i JOIN users u ON u.id = i.created_by
       WHERE i.entity_id = ? AND i.status <> 'preview' ORDER BY i.created_at DESC LIMIT 100`,
      c.var.entity.id,
    );
    return c.json({
      imports: rows.map((r) => ({
        id: r.id,
        accountId: r.account_id,
        status: r.status,
        period: { from: r.period_from, to: r.period_to },
        lines: r.line_count,
        created: r.created_count,
        matched: r.matched_count,
        review: r.review_count,
        createdAt: r.created_at,
        by: r.agent_name ? `${r.agent_name} (agent)` : r.name,
      })),
    });
  })

  .get("/imports/:importId", async (c) => {
    const { plan } = await loadImport(c, c.req.param("importId"));
    return c.json({ plan: await withRelated(c, plan) });
  })

  .post("/imports/:importId/commit", async (c) => {
    need(c, "editor");
    const db = c.env.DB;
    const entity = c.var.entity;
    const { row, plan } = await loadImport(c, c.req.param("importId"));
    if (row.status !== "preview") throw badRequest(row.status === "committed" ? "This import is already committed." : "This import was undone. Preview the statement again.");
    if (now() - plan.createdAt > 3_600_000) throw badRequest("This preview is over an hour old. Preview the statement again.");
    const types = await loadAccountTypes(db, entity.id);
    const stmts: D1PreparedStatement[] = [];
    const t = now();
    const contactByName = new Map(
      (await all<{ id: string; name: string }>(db, "SELECT id, name FROM contacts WHERE entity_id = ? AND archived_at IS NULL", entity.id)).map((r) => [r.name.toLowerCase(), r.id]),
    );
    const uncategorised: Partial<Record<"expense" | "income", string>> = {};
    let created = 0;
    let matched = 0;
    let review = 0;

    if (plan.link) {
      stmts.push(
        sql(db, "UPDATE accounts SET number_last4 = ?, institution = COALESCE(institution, ?), ifsc = COALESCE(ifsc, ?) WHERE id = ? AND entity_id = ?", plan.link.numberLast4, plan.link.institution ?? null, plan.link.ifsc ?? null, plan.accountId, entity.id),
      );
    }

    for (const l of plan.lines) {
      const fingerprint = await sha256Hex(
        lineKey(plan.accountId, { date: l.date, amount: l.amount, balance: l.balance, reference: l.reference, description: l.description }),
      );
      const evidence = (status: string, transactionId: string | null, match: string | null, candidates?: string[]) =>
        sql(
          db,
          `INSERT INTO evidence (id, entity_id, source, status, transaction_id, account_id, import_id, line_no, date, amount, balance, description, reference, upi_id, fingerprint, match, candidates, created_at)
           VALUES (?, ?, 'statement', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          uuidv7(),
          entity.id,
          status,
          transactionId,
          plan.accountId,
          plan.id,
          l.lineNo,
          l.date,
          l.amount,
          l.balance,
          l.description,
          l.reference,
          l.upiId,
          fingerprint,
          match,
          candidates ? JSON.stringify(candidates) : null,
          t,
        );

      if (l.action === "duplicate") continue;
      if (l.action === "reversal") {
        stmts.push(evidence("reversal", null, null));
        continue;
      }
      if (l.action === "pending") {
        stmts.push(evidence("pending", null, null, l.candidates ?? []));
        review++;
        continue;
      }
      if (l.action === "link") {
        if (l.match === "transit") {
          // Claim the parked leg: the transfer now lands in this account.
          stmts.push(sql(db, "UPDATE postings SET account_id = ? WHERE id = ? AND entity_id = ?", plan.accountId, l.transitPostingId, entity.id));
        }
        stmts.push(evidence("linked", l.transactionId!, l.match === "transit" ? "auto" : (l.match ?? "auto")));
        matched++;
        // The recorded transaction was labelled by a person: its contact owns this UPI ID now.
        if (l.upiId && !c.var.agentName) {
          stmts.push(
            sql(
              db,
              `INSERT INTO contact_identifiers (id, entity_id, contact_id, kind, value, created_at)
               SELECT ?, ?, p.contact_id, 'upi', ?, ? FROM postings p JOIN transactions t ON t.id = p.transaction_id
               WHERE p.transaction_id = ? AND p.contact_id IS NOT NULL AND t.origin IN ('manual', 'smart') LIMIT 1
               ON CONFLICT (entity_id, kind, value) DO NOTHING`,
              uuidv7(),
              entity.id,
              l.upiId,
              t,
              l.transactionId,
            ),
          );
        }
        continue;
      }
      // new
      const p = { ...l.proposal! };
      if (p.accountId === TRANSIT_PLACEHOLDER || p.toAccountId === TRANSIT_PLACEHOLDER) {
        const tid = await ensureTransit(c, stmts);
        types.set(tid, { id: tid, type: "asset", archived: false, name: TRANSIT });
        if (p.accountId === TRANSIT_PLACEHOLDER) p.accountId = tid;
        if (p.toAccountId === TRANSIT_PLACEHOLDER) p.toAccountId = tid;
      }
      let contactId = p.contactId ?? null;
      if (!contactId && p.newContact) {
        contactId = contactByName.get(p.newContact.name.toLowerCase()) ?? null;
        if (!contactId) {
          contactId = uuidv7();
          contactByName.set(p.newContact.name.toLowerCase(), contactId);
          stmts.push(sql(db, "INSERT INTO contacts (id, entity_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)", contactId, entity.id, p.newContact.name, p.newContact.kind, t));
        }
      }
      let categoryId = p.categoryId ?? null;
      if ((p.kind === "expense" || p.kind === "income") && !categoryId) {
        uncategorised[p.kind] ??= await uncategorisedId(c, p.kind, stmts);
        categoryId = uncategorised[p.kind]!;
        types.set(categoryId, { id: categoryId, type: p.kind, archived: false, name: UNCATEGORISED[p.kind] });
      }
      let postings;
      try {
        postings = buildPostings({ ...p, categoryId, contactId }, (id) => types.get(id), entity.iou_account_id);
      } catch (err) {
        if (err instanceof LedgerError) throw badRequest(`Line ${l.lineNo}: ${err.message}`);
        throw err;
      }
      const txId = uuidv7();
      stmts.push(
        sql(
          db,
          `INSERT INTO transactions (id, entity_id, date, kind, note, created_by, created_at, origin, needs_review, agent_name, import_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'statement', ?, ?, ?)`,
          txId,
          entity.id,
          p.date,
          storedKind(p.kind),
          p.note ?? null,
          c.var.user.id,
          t,
          p.needsReview ? 1 : 0,
          c.var.agentName,
          plan.id,
        ),
        ...postings.map((x) =>
          sql(db, "INSERT INTO postings (id, transaction_id, entity_id, account_id, amount, contact_id) VALUES (?, ?, ?, ?, ?, ?)", uuidv7(), txId, entity.id, x.accountId, x.amount, x.contactId ?? null),
        ),
        evidence("linked", txId, "created"),
      );
      created++;
      if (p.needsReview) review++;
    }

    stmts.push(
      sql(
        db,
        "UPDATE statement_imports SET status = 'committed', committed_at = ?, created_count = ?, matched_count = ?, review_count = ? WHERE id = ?",
        t,
        created,
        matched,
        review,
        plan.id,
      ),
      audit(db, {
        entityId: entity.id,
        actorId: c.var.user.id,
        action: "import.commit",
        targetType: "import",
        targetId: plan.id,
        summary: `Imported ${plan.accountName} statement ${plan.period.from} to ${plan.period.to}${c.var.agentName ? ` via ${c.var.agentName}` : ""}: ${created} new, ${matched} matched, ${review} to review`,
      }),
    );
    try {
      // Batches are atomic; very large statements are split, and the import's
      // status is only set in the last chunk so a failure can be undone.
      for (let i = 0; i < stmts.length; i += 900) await db.batch(stmts.slice(i, i + 900));
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: evidence\.entity_id, evidence\.fingerprint/i.test(err.message)) {
        throw badRequest("Some of these lines were imported since the preview. Preview the statement again.");
      }
      if (err instanceof Error && /UNIQUE constraint failed: evidence/i.test(err.message)) {
        throw badRequest(`Two statement lines would confirm the same transaction (${err.message.replace(/^.*UNIQUE constraint failed: /, "")}). Preview again; if it repeats, report it.`);
      }
      throw err;
    }
    const after = await first<{ total: number | null }>(
      db,
      `SELECT SUM(p.amount) AS total FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE p.entity_id = ? AND p.account_id = ? AND t.deleted_at IS NULL AND t.date <= ?`,
      entity.id,
      plan.accountId,
      plan.period.to,
    );
    const account = (await loadAccounts(db, entity)).find((a) => a.id === plan.accountId)!;
    const ledgerClosing = displayBalance(account.type, after?.total ?? 0);
    return c.json({ created, matched, review, ledgerClosing, closing: plan.closing, balanced: ledgerClosing === plan.closing });
  })

  .post("/imports/:importId/undo", async (c) => {
    need(c, "editor");
    const db = c.env.DB;
    const { row, plan } = await loadImport(c, c.req.param("importId"));
    if (row.status !== "committed") throw badRequest("Only a committed import can be undone.");
    const t = now();
    const entityId = c.var.entity.id;
    const transit = await transitId(db, entityId);
    const reparks: D1PreparedStatement[] = [];
    if (transit) {
      // Parked legs this import claimed go back to waiting.
      for (const l of plan.lines.filter((x) => x.match === "transit" && x.transitPostingId)) {
        reparks.push(sql(db, "UPDATE postings SET account_id = ? WHERE id = ? AND entity_id = ?", transit, l.transitPostingId, entityId));
      }
      // Transfers this import created that another statement has since confirmed:
      // keep the other side, park this side instead of deleting the money.
      const confirmedElsewhere = `SELECT t.id FROM transactions t WHERE t.import_id = ? AND t.entity_id = ? AND EXISTS (
        SELECT 1 FROM evidence e WHERE e.transaction_id = t.id AND e.status = 'linked' AND e.import_id IS NOT ?)`;
      reparks.push(
        sql(db, `UPDATE postings SET account_id = ? WHERE account_id = ? AND transaction_id IN (${confirmedElsewhere})`, transit, plan.accountId, row.id, entityId, row.id),
        sql(db, `UPDATE transactions SET import_id = NULL WHERE id IN (${confirmedElsewhere})`, row.id, entityId, row.id),
      );
    }
    await db.batch([
      ...reparks,
      sql(db, "UPDATE transactions SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE import_id = ? AND entity_id = ? AND deleted_at IS NULL", t, c.var.user.id, t, row.id, entityId),
      // A transfer whose every leg is back in transit no longer moves any money.
      ...(transit
        ? [
            sql(
              db,
              `UPDATE transactions SET deleted_at = ? WHERE entity_id = ? AND deleted_at IS NULL AND id IN (
                 SELECT transaction_id FROM postings WHERE entity_id = ? GROUP BY transaction_id HAVING MIN(account_id) = ? AND MAX(account_id) = ?)`,
              t,
              entityId,
              entityId,
              transit,
              transit,
            ),
          ]
        : []),
      sql(db, "DELETE FROM evidence WHERE import_id = ? AND entity_id = ?", row.id, c.var.entity.id),
      sql(db, "UPDATE statement_imports SET status = 'undone', undone_at = ? WHERE id = ?", t, row.id),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "import.undo",
        targetType: "import",
        targetId: row.id,
        summary: `Undid the ${plan.accountName} statement import (${plan.period.from} to ${plan.period.to})`,
      }),
    ]);
    return c.json({ ok: true });
  })

  // What needs a person: statement lines waiting for a decision, and imported
  // transactions whose category or kind was a guess.
  .get("/review", async (c) => {
    const db = c.env.DB;
    const pending = await all<{ id: string; account_id: string; date: string; amount: number; description: string; candidates: string | null; import_id: string | null }>(
      db,
      "SELECT id, account_id, date, amount, description, candidates, import_id FROM evidence WHERE entity_id = ? AND status = 'pending' ORDER BY date",
      c.var.entity.id,
    );
    const views = await loadTxViews(c, pending.flatMap((p) => (p.candidates ? (JSON.parse(p.candidates) as string[]) : [])));
    const fmt = (n: number) => formatMoney(Math.abs(n), { currency: c.var.entity.currency });
    const items: ReviewItem[] = pending.map((p) => {
      const cands = (p.candidates ? (JSON.parse(p.candidates) as string[]) : []).map((id) => views.get(id)).filter((x): x is Transaction => !!x);
      return {
        evidenceId: p.id,
        accountId: p.account_id,
        date: p.date,
        amount: p.amount,
        description: p.description,
        reason: cands.length
          ? cands.length === 1
            ? `Close to a transaction you recorded, but the statement says ${fmt(p.amount)}.`
            : "Several transactions you recorded could be this one."
          : "Not sure what this is. Add it as a transaction.",
        candidates: cands,
        importId: p.import_id,
      };
    });
    const types = await loadAccountTypes(db, c.var.entity.id);
    const guesses = (await all<TxRow>(db, `${TX_SELECT} WHERE t.entity_id = ? AND t.deleted_at IS NULL AND t.needs_review = 1 ORDER BY t.date DESC LIMIT 500`, c.var.entity.id)).map((r) =>
      txView(r, types, c.var.entity.iou_account_id),
    );
    return c.json({ lines: items, transactions: guesses });
  })

  .post("/evidence/:evidenceId/link", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, z.object({ transactionId: z.string() }));
    await linkEvidence(c, c.req.param("evidenceId"), body.transactionId);
    return c.json({ ok: true });
  })

  .post("/evidence/:evidenceId/dismiss", async (c) => {
    need(c, "editor");
    const db = c.env.DB;
    const ev = await first<{ description: string }>(db, "SELECT description FROM evidence WHERE id = ? AND entity_id = ? AND status = 'pending'", c.req.param("evidenceId"), c.var.entity.id);
    if (!ev) throw notFound("That statement line isn't waiting for review.");
    await db.batch([
      sql(db, "UPDATE evidence SET status = 'dismissed' WHERE id = ?", c.req.param("evidenceId")),
      audit(db, { entityId: c.var.entity.id, actorId: c.var.user.id, action: "evidence.dismiss", targetType: "evidence", targetId: c.req.param("evidenceId"), summary: `Ignored statement line “${ev.description.slice(0, 60)}”` }),
    ]);
    return c.json({ ok: true });
  });

/**
 * A person says "this statement line is that transaction". The amounts must
 * agree to the paisa, otherwise the books would disagree with the bank.
 */
export async function linkEvidence(c: Ctx, evidenceId: string, transactionId: string, extra: D1PreparedStatement[] = []) {
  const db = c.env.DB;
  const ev = await first<{ account_id: string; amount: number; upi_id: string | null; description: string }>(
    db,
    "SELECT account_id, amount, upi_id, description FROM evidence WHERE id = ? AND entity_id = ? AND status = 'pending'",
    evidenceId,
    c.var.entity.id,
  );
  if (!ev) throw notFound("That statement line isn't waiting for review.");
  const onAccount = await first<{ total: number | null }>(
    db,
    `SELECT SUM(p.amount) AS total FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.transaction_id = ? AND p.account_id = ? AND t.entity_id = ? AND t.deleted_at IS NULL`,
    transactionId,
    ev.account_id,
    c.var.entity.id,
  );
  if (onAccount?.total === null || onAccount?.total === undefined) throw badRequest("That transaction doesn't touch this statement's account.");
  if (onAccount.total !== ev.amount) {
    throw badRequest(`Amounts differ: the statement says ${formatMoney(Math.abs(ev.amount), { currency: c.var.entity.currency })}. Edit the transaction to match first.`);
  }
  try {
    await db.batch([
      ...extra,
      sql(db, "UPDATE evidence SET status = 'linked', transaction_id = ?, match = 'person', candidates = NULL WHERE id = ?", transactionId, evidenceId),
      ...(ev.upi_id
        ? [
            sql(
              db,
              `INSERT INTO contact_identifiers (id, entity_id, contact_id, kind, value, created_at)
               SELECT ?, ?, p.contact_id, 'upi', ?, ? FROM postings p WHERE p.transaction_id = ? AND p.contact_id IS NOT NULL LIMIT 1
               ON CONFLICT (entity_id, kind, value) DO NOTHING`,
              uuidv7(),
              c.var.entity.id,
              ev.upi_id,
              now(),
              transactionId,
            ),
          ]
        : []),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "evidence.link",
        targetType: "transaction",
        targetId: transactionId,
        summary: `Matched statement line “${ev.description.slice(0, 60)}”`,
      }),
    ]);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: evidence/i.test(err.message)) throw badRequest("That transaction is already matched to another line from this account's statement.");
    throw err;
  }
}
