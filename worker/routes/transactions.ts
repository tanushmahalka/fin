import { Hono } from "hono";
import { z } from "zod";
import { isValidDate, today } from "../../shared/dates";
import { UUID_RE, uuidv7 } from "../../shared/ids";
import { assertBalanced, buildPostings, LedgerError, storedKind } from "../../shared/ledger";
import { formatMoney, MAX_AMOUNT } from "../../shared/money";
import type { EntryKind, Posting, Share, Transaction } from "../../shared/types";
import { audit } from "../audit";
import { type AppEnv, type Ctx, all, badRequest, conflict, first, need, notFound, now, parseBody, sql } from "../http";
import { type AccountInfo, loadAccountTypes, loadTransaction, TX_SELECT, type TxRow, txView } from "../views";
import { contactName } from "./contacts";
import { linkEvidence } from "./imports";

const date = z.string().refine(isValidDate, "Use a YYYY-MM-DD date.");
const text = z.string().trim().max(500).nullable().optional();
const id = z.string().min(1).max(64);
const amount = z.number().int().positive("Amount must be greater than zero.").max(MAX_AMOUNT);
const entryKind = z.enum(["expense", "income", "transfer", "gave", "got"]);

const txInput = z.object({
  id: z.string().regex(UUID_RE, "id must be a UUID").optional(),
  kind: entryKind,
  date: date.optional(),
  amount,
  accountId: id.nullable().optional(),
  categoryId: id.nullable().optional(),
  toAccountId: id.nullable().optional(),
  contactId: id.nullable().optional(),
  newContact: z.object({ name: contactName, kind: z.enum(["person", "business"]) }).nullable().optional(),
  paidBy: id.nullable().optional(),
  share: z.object({ contactId: id, amount }).nullable().optional(),
  note: text,
  origin: z.enum(["manual", "smart", "sms", "email", "api"]).optional(),
  reviewed: z.boolean().optional(),
  /** Create this transaction for a statement line waiting in the review queue. */
  evidenceId: z.string().optional(),
});

const txPatch = txInput.omit({ id: true, evidenceId: true }).partial();

interface Entry {
  kind: EntryKind;
  date: string;
  amount: number;
  accountId: string | null;
  categoryId: string | null;
  toAccountId: string | null;
  contactId: string | null;
  paidBy: string | null;
  share: Share | null;
  note: string | null;
}

/** Fields that don't apply to a kind are dropped, so switching Expense → Transfer can't leave a stale split. */
function normalise(e: Entry): Entry {
  const n = { ...e };
  if (n.kind !== "expense") {
    n.paidBy = null;
    n.share = null;
  }
  if (n.kind !== "expense" && n.kind !== "income") n.categoryId = null;
  if (n.kind !== "transfer") n.toAccountId = null;
  if (n.paidBy) n.accountId = null;
  return n;
}

function postingsFor(c: Ctx, entry: Entry, types: AccountInfo): Posting[] {
  try {
    const postings = buildPostings(entry, (accountId) => types.get(accountId), c.var.entity.iou_account_id);
    assertBalanced(postings);
    return postings;
  } catch (err) {
    if (err instanceof LedgerError) throw badRequest(err.message);
    throw err;
  }
}

/** Every contact a write mentions must be a live contact of this entity. */
async function checkContacts(c: Ctx, entry: Entry) {
  const ids = [entry.contactId, entry.paidBy, entry.share?.contactId].filter((x): x is string => !!x);
  if (!ids.length) return;
  const rows = await all<{ id: string }>(
    c.env.DB,
    `SELECT id FROM contacts WHERE entity_id = ? AND archived_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
    c.var.entity.id,
    ...ids,
  );
  const found = new Set(rows.map((r) => r.id));
  if (ids.some((x) => !found.has(x))) throw badRequest("That contact doesn't exist or is archived.");
}

async function contactNames(c: Ctx) {
  const rows = await all<{ id: string; name: string }>(c.env.DB, "SELECT id, name FROM contacts WHERE entity_id = ?", c.var.entity.id);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** "expense ₹250 · Food & dining · Cash · Blinkit" — one line for the activity feed. */
function describe(c: Ctx, tx: Pick<Transaction, "kind" | "amount" | "accountId" | "toAccountId" | "categoryId" | "contactId" | "paidBy" | "share">, types: AccountInfo, contacts: Map<string, string>) {
  const name = (accountId: string | null) => (accountId ? (types.get(accountId)?.name ?? "?") : "?");
  const who = (contactId: string | null | undefined) => (contactId ? (contacts.get(contactId) ?? "someone") : null);
  const fmt = (n: number) => formatMoney(n, { currency: c.var.entity.currency });
  if (tx.kind === "gave") return `gave ${who(tx.contactId)} ${fmt(tx.amount)} from ${name(tx.accountId)}`;
  if (tx.kind === "got") return `got ${fmt(tx.amount)} from ${who(tx.contactId)} into ${name(tx.accountId)}`;
  if (tx.kind === "transfer") return `transfer ${fmt(tx.amount)} · ${name(tx.accountId)} → ${name(tx.toAccountId)}`;
  if (tx.kind === "opening" || tx.kind === "adjustment") return `${tx.kind} ${fmt(tx.amount)} · ${name(tx.accountId)}`;
  const parts = [`${tx.kind} ${fmt(tx.amount)}`, name(tx.categoryId), tx.paidBy ? `paid by ${who(tx.paidBy)}` : name(tx.accountId), who(tx.contactId)];
  if (tx.share) parts.push(`${who(tx.share.contactId)} owes ${fmt(tx.share.amount)}`);
  return parts.filter(Boolean).join(" · ");
}

/**
 * Learning from a person's label: when a transaction confirmed by a statement
 * is given a contact, that statement line's UPI ID now belongs to the contact.
 * Next month the same UPI ID is a lookup, not a guess.
 */
export function learnStmts(c: Ctx, txId: string, contactId: string | null) {
  if (!contactId || c.var.agentName) return [];
  return [
    sql(
      c.env.DB,
      `INSERT INTO contact_identifiers (id, entity_id, contact_id, kind, value, created_at)
       SELECT ?, ?, ?, 'upi', e.upi_id, ? FROM evidence e
       WHERE e.transaction_id = ? AND e.upi_id IS NOT NULL AND e.status = 'linked' LIMIT 1
       ON CONFLICT (entity_id, kind, value) DO NOTHING`,
      uuidv7(),
      c.var.entity.id,
      contactId,
      now(),
      txId,
    ),
  ];
}

function postingStmts(c: Ctx, txId: string, postings: Posting[]) {
  return postings.map((p) =>
    sql(
      c.env.DB,
      "INSERT INTO postings (id, transaction_id, entity_id, account_id, amount, contact_id) VALUES (?, ?, ?, ?, ?, ?)",
      uuidv7(),
      txId,
      c.var.entity.id,
      p.accountId,
      p.amount,
      p.contactId ?? null,
    ),
  );
}

async function mustLoad(c: Ctx, txId: string, includeDeleted = false) {
  const tx = await loadTransaction(c.env.DB, c.var.entity, txId, includeDeleted);
  if (!tx) throw notFound("Transaction not found.");
  return tx;
}

export const transactionRoutes = new Hono<AppEnv>()
  // ?from&to (dates), ?accountId, ?categoryId, ?contactId, ?kind, ?q (search), ?limit
  .get("/", async (c) => {
    const q = c.req.query();
    const where = ["t.entity_id = ?", "t.deleted_at IS NULL"];
    const params: unknown[] = [c.var.entity.id];
    if (q.from) {
      if (!isValidDate(q.from)) throw badRequest("from must be YYYY-MM-DD.");
      where.push("t.date >= ?");
      params.push(q.from);
    }
    if (q.to) {
      if (!isValidDate(q.to)) throw badRequest("to must be YYYY-MM-DD.");
      where.push("t.date <= ?");
      params.push(q.to);
    }
    if (q.kind) {
      where.push("t.kind = ?");
      params.push(q.kind);
    }
    for (const key of ["accountId", "categoryId"] as const) {
      if (q[key]) {
        where.push("EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.account_id = ?)");
        params.push(q[key]);
      }
    }
    if (q.flagged) where.push("t.flag IS NOT NULL");
    if (q.contactId) {
      where.push("EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.contact_id = ?)");
      params.push(q.contactId);
    }
    if (q.q?.trim()) {
      const like = `%${q.q.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(`(t.note LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM postings p LEFT JOIN accounts a ON a.id = p.account_id LEFT JOIN contacts k ON k.id = p.contact_id
        WHERE p.transaction_id = t.id AND (a.name LIKE ? ESCAPE '\\' OR k.name LIKE ? ESCAPE '\\')))`);
      params.push(like, like, like);
    }
    // Keyset pagination for endless scrolling: ?cursor=<date>|<created_at>|<id> from the previous page.
    if (q.cursor) {
      const [d, ca, cid] = q.cursor.split("|");
      if (!isValidDate(d) || !Number.isFinite(Number(ca)) || !cid) throw badRequest("Bad cursor.");
      where.push("(t.date < ? OR (t.date = ? AND (t.created_at < ? OR (t.created_at = ? AND t.id < ?))))");
      params.push(d, d, Number(ca), Number(ca), cid);
    }
    const limit = Math.min(Number(q.limit ?? 1000) || 1000, 5000);
    const db = c.env.DB;
    const [rows, types] = await Promise.all([
      all<TxRow>(db, `${TX_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.date DESC, t.created_at DESC, t.id DESC LIMIT ?`, ...params, limit),
      loadAccountTypes(db, c.var.entity.id),
    ]);
    const last = rows.at(-1);
    return c.json({
      transactions: rows.map((r) => txView(r, types, c.var.entity.iou_account_id)),
      nextCursor: rows.length === limit && last ? `${last.date}|${last.created_at}|${last.id}` : null,
    });
  })

  .get("/:txId", async (c) => c.json({ transaction: await mustLoad(c, c.req.param("txId")) }))

  // Flag for the owner's attention (or clear with reason: null).
  .post("/:txId/flag", async (c) => {
    need(c, "editor");
    const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(280).nullable() }));
    const tx = await mustLoad(c, c.req.param("txId"));
    await c.env.DB.batch([
      sql(c.env.DB, "UPDATE transactions SET flag = ? WHERE id = ? AND entity_id = ?", reason, tx.id, c.var.entity.id),
      audit(c.env.DB, {
        entityId: c.var.entity.id, actorId: c.var.user.id, action: reason ? "transaction.flag" : "transaction.unflag", targetType: "transaction", targetId: tx.id,
        summary: reason ? `Flagged ${tx.date}: ${reason}` : `Cleared flag on ${tx.date}`, before: { flag: tx.flag }, after: { flag: reason },
      }),
    ]);
    return c.json({ transaction: await mustLoad(c, tx.id) });
  })

  .post("/", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, txInput);
    const db = c.env.DB;
    const entityId = c.var.entity.id;

    // Idempotency: retrying a create with the same client id returns the original.
    if (body.id) {
      const existing = await first<{ entity_id: string }>(db, "SELECT entity_id FROM transactions WHERE id = ?", body.id);
      if (existing) {
        if (existing.entity_id !== entityId) throw conflict("That transaction id is already in use.");
        return c.json({ transaction: await mustLoad(c, body.id, true) });
      }
    }

    // A new contact found by smart add is created in the same batch, or reused if the name already exists.
    const stmts: D1PreparedStatement[] = [];
    let contactId = body.contactId ?? null;
    if (!contactId && body.newContact) {
      const existing = await first<{ id: string }>(
        db,
        "SELECT id FROM contacts WHERE entity_id = ? AND name = ? COLLATE NOCASE AND archived_at IS NULL",
        entityId,
        body.newContact.name,
      );
      contactId = existing?.id ?? uuidv7();
      if (!existing) {
        stmts.push(
          sql(db, "INSERT INTO contacts (id, entity_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)", contactId, entityId, body.newContact.name, body.newContact.kind, now()),
          audit(db, { entityId, actorId: c.var.user.id, action: "contact.create", targetType: "contact", targetId: contactId, summary: `Added contact ${body.newContact.name}` }),
        );
      }
    }

    const entry = normalise({
      kind: body.kind,
      date: body.date ?? today(c.var.entity.timezone),
      amount: body.amount,
      accountId: body.accountId ?? null,
      categoryId: body.categoryId ?? null,
      toAccountId: body.toAccountId ?? null,
      contactId,
      paidBy: body.paidBy ?? null,
      share: body.share ?? null,
      note: body.note || null,
    });
    await checkContacts(c, { ...entry, contactId: stmts.length ? null : entry.contactId });
    const [types, names] = await Promise.all([loadAccountTypes(db, entityId), contactNames(c)]);
    if (body.newContact && contactId) names.set(contactId, body.newContact.name);
    const postings = postingsFor(c, entry, types);
    const txId = body.id ?? uuidv7();
    // From a statement line: the new transaction must move that account by exactly the line's amount.
    let fromLine: { import_id: string | null; account_id: string; amount: number } | null = null;
    if (body.evidenceId) {
      fromLine = await first(db, "SELECT import_id, account_id, amount FROM evidence WHERE id = ? AND entity_id = ? AND status = 'pending'", body.evidenceId, entityId);
      if (!fromLine) throw notFound("That statement line isn't waiting for review.");
      const effect = postings.filter((p) => p.accountId === fromLine!.account_id).reduce((s, p) => s + p.amount, 0);
      if (effect !== fromLine.amount) {
        throw badRequest(`This doesn't match the statement line: it should move ${formatMoney(Math.abs(fromLine.amount), { currency: c.var.entity.currency })} ${fromLine.amount < 0 ? "out of" : "into"} that account.`);
      }
    }
    try {
      await db.batch([
        ...stmts,
        sql(
          db,
          "INSERT INTO transactions (id, entity_id, date, kind, note, created_by, created_at, origin, agent_name, import_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          txId,
          entityId,
          entry.date,
          storedKind(entry.kind),
          entry.note,
          c.var.user.id,
          now(),
          fromLine ? "statement" : (body.origin ?? "manual"),
          c.var.agentName,
          fromLine?.import_id ?? null,
        ),
        ...postingStmts(c, txId, postings),
        audit(db, {
          entityId,
          actorId: c.var.user.id,
          action: "transaction.create",
          targetType: "transaction",
          targetId: txId,
          summary: `Added ${describe(c, entry, types, names)}`,
          after: { ...entry, id: txId },
        }),
      ]);
    } catch (err) {
      // A concurrent retry won the race on the same id.
      if (body.id && err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message)) {
        return c.json({ transaction: await mustLoad(c, body.id, true) });
      }
      throw err;
    }
    if (body.evidenceId) await linkEvidence(c, body.evidenceId, txId);
    return c.json({ transaction: await mustLoad(c, txId) }, 201);
  })

  .patch("/:txId", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, txPatch);
    const db = c.env.DB;
    const before = await mustLoad(c, c.req.param("txId"));
    if (before.kind === "opening" || before.kind === "adjustment") {
      throw badRequest("Opening balances and adjustments can't be edited. Delete and re-create them instead.");
    }
    if (body.newContact) throw badRequest("Create the contact first, then pick it.");
    const pick = <K extends keyof Entry>(key: K, fallback: Entry[K]): Entry[K] => (body[key as keyof typeof body] === undefined ? fallback : (body[key as keyof typeof body] as Entry[K]));
    const merged = normalise({
      kind: body.kind ?? (before.kind as EntryKind),
      date: body.date ?? before.date,
      amount: body.amount ?? before.amount,
      accountId: pick("accountId", before.accountId),
      categoryId: pick("categoryId", before.categoryId),
      toAccountId: pick("toAccountId", before.toAccountId),
      contactId: pick("contactId", before.contactId),
      paidBy: pick("paidBy", before.paidBy),
      share: pick("share", before.share),
      note: pick("note", before.note) || null,
    });
    await checkContacts(c, merged);
    const [types, names] = await Promise.all([loadAccountTypes(db, c.var.entity.id), contactNames(c)]);
    const postings = postingsFor(c, merged, types);
    await db.batch([
      sql(
        db,
        // A person saving an imported transaction has reviewed it; an agent editing it hasn't.
        `UPDATE transactions SET date = ?, kind = ?, note = ?, updated_by = ?, updated_at = ?,
           needs_review = CASE WHEN ? THEN 0 ELSE needs_review END
         WHERE id = ? AND entity_id = ?`,
        merged.date,
        storedKind(merged.kind),
        merged.note,
        c.var.user.id,
        now(),
        !c.var.agentName || body.reviewed ? 1 : 0,
        before.id,
        c.var.entity.id,
      ),
      sql(db, "DELETE FROM postings WHERE transaction_id = ?", before.id),
      ...postingStmts(c, before.id, postings),
      ...learnStmts(c, before.id, merged.contactId),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "transaction.update",
        targetType: "transaction",
        targetId: before.id,
        summary: `Edited ${describe(c, merged, types, names)}`,
        before,
        after: merged,
      }),
    ]);
    return c.json({ transaction: await mustLoad(c, before.id) });
  })

  // Soft delete: the row stays for the audit trail and can be restored (undo).
  .delete("/:txId", async (c) => {
    need(c, "editor");
    const db = c.env.DB;
    const tx = await mustLoad(c, c.req.param("txId"));
    const [types, names] = await Promise.all([loadAccountTypes(db, c.var.entity.id), contactNames(c)]);
    await db.batch([
      sql(db, "UPDATE transactions SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?", now(), c.var.user.id, now(), tx.id),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "transaction.delete",
        targetType: "transaction",
        targetId: tx.id,
        summary: `Deleted ${describe(c, tx, types, names)}`,
        before: tx,
      }),
    ]);
    return c.json({ ok: true });
  })

  .post("/:txId/restore", async (c) => {
    need(c, "editor");
    const db = c.env.DB;
    const tx = await mustLoad(c, c.req.param("txId"), true);
    const [types, names] = await Promise.all([loadAccountTypes(db, c.var.entity.id), contactNames(c)]);
    await db.batch([
      sql(db, "UPDATE transactions SET deleted_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?", c.var.user.id, now(), tx.id),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "transaction.restore",
        targetType: "transaction",
        targetId: tx.id,
        summary: `Restored ${describe(c, tx, types, names)}`,
      }),
    ]);
    return c.json({ transaction: await mustLoad(c, tx.id) });
  });
