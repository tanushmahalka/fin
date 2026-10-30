import { Hono } from "hono";
import { z } from "zod";
import { addDays, today } from "../../shared/dates";
import { uuidv7 } from "../../shared/ids";
import { formatMoney, MAX_AMOUNT } from "../../shared/money";
import { assignCharges, CADENCES, type Cadence, type Charge, detectRecurring, subProgress } from "../../shared/subscriptions";
import type { Subscription } from "../../shared/types";
import { audit } from "../audit";
import { type AppEnv, type Ctx, all, badRequest, first, need, notFound, now, parseBody, sql } from "../http";
import { loadAccountTypes, TX_SELECT, type TxRow, txView } from "../views";

interface SubRow {
  id: string;
  name: string;
  contact_id: string | null;
  match_text: string | null;
  amount: number;
  cadence: Cadence;
  account_id: string | null;
  for_contact_id: string | null;
  note: string | null;
  cancelled_at: number | null;
  created_at: number;
}

const fields = {
  name: z.string().trim().min(1, "Name it.").max(60),
  contactId: z.string().nullable().optional(),
  matchText: z.string().trim().max(60).nullable().optional(),
  amount: z.number().int().min(1).max(MAX_AMOUNT),
  cadence: z.enum(CADENCES as [Cadence, ...Cadence[]]),
  accountId: z.string().nullable().optional(),
  forContactId: z.string().nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
};
const createSub = z.object(fields).refine((b) => b.contactId || b.matchText, "Say how to recognise its charges: a contact or text in the note.");
const updateSub = z.object({ ...fields, cancelled: z.boolean() }).partial();

/** Spending in the last ~13 months: what a charge can be. "Gave" counts (paid on a company's behalf). */
async function loadCharges(c: Ctx, on: string): Promise<Charge[]> {
  const entity = c.var.entity;
  const [rows, types] = await Promise.all([
    all<TxRow>(c.env.DB, `${TX_SELECT} WHERE t.entity_id = ? AND t.deleted_at IS NULL AND t.date >= ? AND t.date <= ? AND t.kind IN ('expense', 'transfer')`, entity.id, addDays(on, -400), on),
    loadAccountTypes(c.env.DB, entity.id),
  ]);
  return rows
    .map((r) => txView(r, types, entity.iou_account_id))
    .filter((t) => (t.kind === "expense" || t.kind === "gave") && t.accountId)
    .map((t) => ({ id: t.id, date: t.date, amount: t.amount, accountId: t.accountId!, categoryId: t.categoryId, contactId: t.contactId, note: t.note }));
}

async function loadSubs(c: Ctx) {
  const on = today(c.var.entity.timezone);
  const [rows, charges] = await Promise.all([
    all<SubRow>(c.env.DB, "SELECT * FROM subscriptions WHERE entity_id = ? ORDER BY created_at", c.var.entity.id),
    loadCharges(c, on),
  ]);
  // How far each account's books go (statements arrive weeks after the charges they list).
  const through = new Map(
    (
      await all<{ account_id: string; last: string }>(
        c.env.DB,
        `SELECT p.account_id, MAX(t.date) AS last FROM postings p JOIN transactions t ON t.id = p.transaction_id
         WHERE p.entity_id = ? AND t.deleted_at IS NULL GROUP BY p.account_id`,
        c.var.entity.id,
      )
    ).map((r) => [r.account_id, r.last]),
  );
  const byId = assignCharges(rows.map((r) => ({ id: r.id, contactId: r.contact_id, matchText: r.match_text, amount: r.amount })), charges);
  const yearAgo = addDays(on, -365);
  const subs: Subscription[] = rows.map((r) => {
    const list = byId.get(r.id) ?? [];
    return {
      id: r.id,
      name: r.name,
      contactId: r.contact_id,
      matchText: r.match_text,
      amount: r.amount,
      cadence: r.cadence,
      accountId: r.account_id ?? list[0]?.accountId ?? null,
      forContactId: r.for_contact_id,
      note: r.note,
      cancelled: r.cancelled_at !== null,
      createdAt: r.created_at,
      categoryId: list[0]?.categoryId ?? null,
      charges: list.filter((x) => x.date > yearAgo),
      ...subProgress({ amount: r.amount, cadence: r.cadence, cancelled: r.cancelled_at !== null }, list, on, through.get(list[0]?.accountId ?? r.account_id ?? "") ?? on),
    };
  });
  return { subs, charges, tracked: new Set(subs.flatMap((s) => s.charges.map((x) => x.id))) };
}

async function checkRefs(c: Ctx, b: { contactId?: string | null; forContactId?: string | null; accountId?: string | null }) {
  const db = c.env.DB;
  const id = c.var.entity.id;
  for (const k of [b.contactId, b.forContactId]) if (k && !(await first(db, "SELECT 1 FROM contacts WHERE id = ? AND entity_id = ?", k, id))) throw badRequest("That contact isn't in this book.");
  if (b.accountId && !(await first(db, "SELECT 1 FROM accounts WHERE id = ? AND entity_id = ? AND type IN ('asset','liability')", b.accountId, id)))
    throw badRequest("That account isn't in this book.");
}

export const subscriptionRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ subscriptions: (await loadSubs(c)).subs }))

  // Recurring charges nobody tracks yet.
  .get("/suggestions", async (c) => {
    const { charges, tracked } = await loadSubs(c);
    const names = new Map((await all<{ id: string; name: string }>(c.env.DB, "SELECT id, name FROM contacts WHERE entity_id = ?", c.var.entity.id)).map((r) => [r.id, r.name]));
    const dismissed = new Set(
      (await all<{ target_id: string }>(c.env.DB, "SELECT target_id FROM audit_log WHERE entity_id = ? AND action = 'subscription.dismiss'", c.var.entity.id)).map((r) => r.target_id),
    );
    // Interest, fees and loan repayments recur too, but they're the cost of borrowing, not something you signed up for.
    const skip = new Set(
      (await all<{ id: string }>(c.env.DB, "SELECT id FROM accounts WHERE entity_id = ? AND type = 'expense' AND name IN ('Bank & card charges', 'Loan interest', 'Card EMIs', 'Taxes')", c.var.entity.id)).map((r) => r.id),
    );
    const candidates = charges.filter((x) => !x.categoryId || !skip.has(x.categoryId));
    return c.json({ suggestions: detectRecurring(candidates, tracked, names).filter((s) => !dismissed.has(s.key)) });
  })

  .post("/suggestions/dismiss", async (c) => {
    need(c, "editor");
    const { key, name } = await parseBody(c, z.object({ key: z.string().max(200), name: z.string().max(80) }));
    await audit(c.env.DB, { entityId: c.var.entity.id, actorId: c.var.user.id, action: "subscription.dismiss", targetType: "subscription", targetId: key, summary: `Not a subscription: ${name}` }).run();
    return c.json({ ok: true });
  })

  .post("/", async (c) => {
    need(c, "editor");
    const b = await parseBody(c, createSub);
    await checkRefs(c, b);
    const id = uuidv7();
    const db = c.env.DB;
    await db.batch([
      sql(
        db,
        `INSERT INTO subscriptions (id, entity_id, name, contact_id, match_text, amount, cadence, account_id, for_contact_id, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, c.var.entity.id, b.name, b.contactId ?? null, b.matchText || null, b.amount, b.cadence, b.accountId ?? null, b.forContactId ?? null, b.note || null, c.var.user.id, now(),
      ),
      audit(db, {
        entityId: c.var.entity.id, actorId: c.var.user.id, action: "subscription.create", targetType: "subscription", targetId: id,
        summary: `Added subscription ${b.name}: ${formatMoney(b.amount, { currency: c.var.entity.currency })} ${b.cadence}`, after: b,
      }),
    ]);
    return c.json({ subscription: (await loadSubs(c)).subs.find((s) => s.id === id)! }, 201);
  })

  .patch("/:id", async (c) => {
    need(c, "editor");
    const b = await parseBody(c, updateSub);
    const db = c.env.DB;
    const before = await first<SubRow>(db, "SELECT * FROM subscriptions WHERE id = ? AND entity_id = ?", c.req.param("id"), c.var.entity.id);
    if (!before) throw notFound("Subscription not found.");
    await checkRefs(c, b);
    const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
    const next = {
      name: pick(b.name, before.name),
      contact_id: pick(b.contactId, before.contact_id),
      match_text: pick(b.matchText, before.match_text) || null,
      amount: pick(b.amount, before.amount),
      cadence: pick(b.cadence, before.cadence),
      account_id: pick(b.accountId, before.account_id),
      for_contact_id: pick(b.forContactId, before.for_contact_id),
      note: pick(b.note, before.note) || null,
      cancelled_at: b.cancelled === undefined ? before.cancelled_at : b.cancelled ? (before.cancelled_at ?? now()) : null,
    };
    if (!next.contact_id && !next.match_text) throw badRequest("Keep a contact or note text to recognise its charges.");
    await db.batch([
      sql(
        db,
        `UPDATE subscriptions SET name = ?, contact_id = ?, match_text = ?, amount = ?, cadence = ?, account_id = ?, for_contact_id = ?, note = ?, cancelled_at = ?
         WHERE id = ? AND entity_id = ?`,
        next.name, next.contact_id, next.match_text, next.amount, next.cadence, next.account_id, next.for_contact_id, next.note, next.cancelled_at, before.id, c.var.entity.id,
      ),
      audit(db, {
        entityId: c.var.entity.id, actorId: c.var.user.id, action: "subscription.update", targetType: "subscription", targetId: before.id,
        summary: `${b.cancelled === true && !before.cancelled_at ? "Cancelled" : "Updated"} subscription ${next.name}`, before, after: next,
      }),
    ]);
    return c.json({ subscription: (await loadSubs(c)).subs.find((s) => s.id === before.id)! });
  });
