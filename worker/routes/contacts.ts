import { Hono } from "hono";
import { z } from "zod";
import { isValidDate, today } from "../../shared/dates";
import { MAX_AMOUNT } from "../../shared/money";
import { equityAccountId } from "./accounts";
import { uuidv7 } from "../../shared/ids";
import type { Contact, Transaction } from "../../shared/types";
import { audit } from "../audit";
import { type AppEnv, type Ctx, all, badRequest, conflict, first, need, notFound, now, parseBody, sql } from "../http";
import { findContactsInNotes } from "../jev";
import { loadAccountTypes, loadContacts, TX_SELECT, type TxRow, txView } from "../views";

export const contactName = z.string().trim().min(1, "Give the contact a name.").max(80);

const baseContact = z.object({
  name: contactName,
  kind: z.enum(["person", "business"]).default("business"),
  aliases: z.string().trim().max(300).nullable().optional(),
  defaultCategoryId: z.string().nullable().optional(),
});
const createContact = baseContact.extend({
  /** Who owes whom when you start tracking: positive = they owe you, negative = you owe them. */
  openingBalance: z.number().int().min(-MAX_AMOUNT).max(MAX_AMOUNT).optional(),
  openingDate: z.string().refine(isValidDate, "Use a YYYY-MM-DD date.").optional(),
});
const updateContact = baseContact.partial().extend({ archived: z.boolean().optional() });

function asOf(c: Ctx) {
  const v = c.req.query("asOf");
  if (v && !isValidDate(v)) throw badRequest("asOf must be YYYY-MM-DD.");
  return v || undefined;
}

const isUnique = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

async function findContact(c: Ctx, id: string): Promise<Contact> {
  const contact = (await loadContacts(c.env.DB, c.var.entity)).find((x) => x.id === id);
  if (!contact) throw notFound("Contact not found.");
  return contact;
}

/**
 * An existing debt when you start tracking someone: posted between Lent &
 * borrowed and equity, like an account's opening balance, so it never counts
 * as income or spending.
 */
async function openingStmts(c: Ctx, contactId: string, amount: number | undefined, date: string | undefined) {
  if (!amount) return [];
  const iou = c.var.entity.iou_account_id;
  if (!iou) throw badRequest("This entity has no Lent & borrowed account.");
  const db = c.env.DB;
  const equity = await equityAccountId(db, c.var.entity.id);
  const txId = uuidv7();
  const t = now();
  return [
    sql(
      db,
      "INSERT INTO transactions (id, entity_id, date, kind, note, created_by, created_at, origin, agent_name) VALUES (?, ?, ?, 'opening', 'Opening balance', ?, ?, 'manual', ?)",
      txId,
      c.var.entity.id,
      date ?? today(c.var.entity.timezone),
      c.var.user.id,
      t,
      c.var.agentName,
    ),
    sql(db, "INSERT INTO postings (id, transaction_id, entity_id, account_id, amount, contact_id) VALUES (?, ?, ?, ?, ?, ?)", uuidv7(), txId, c.var.entity.id, iou, amount, contactId),
    sql(db, "INSERT INTO postings (id, transaction_id, entity_id, account_id, amount) VALUES (?, ?, ?, ?, ?)", uuidv7(), txId, c.var.entity.id, equity, -amount),
  ];
}

async function checkCategory(c: Ctx, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const row = await first(c.env.DB, "SELECT 1 FROM accounts WHERE id = ? AND entity_id = ? AND type IN ('expense','income')", categoryId, c.var.entity.id);
  if (!row) throw badRequest("Default category must be one of this entity's categories.");
}

export const contactRoutes = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ contacts: await loadContacts(c.env.DB, c.var.entity, asOf(c)) }))

  .post("/", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, createContact);
    await checkCategory(c, body.defaultCategoryId);
    const db = c.env.DB;
    const id = uuidv7();
    try {
      await db.batch([
        sql(
          db,
          "INSERT INTO contacts (id, entity_id, name, kind, aliases, default_category_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id,
          c.var.entity.id,
          body.name,
          body.kind,
          body.aliases || null,
          body.defaultCategoryId ?? null,
          now(),
        ),
        audit(db, { entityId: c.var.entity.id, actorId: c.var.user.id, action: "contact.create", targetType: "contact", targetId: id, summary: `Added contact ${body.name}`, after: body }),
        ...(await openingStmts(c, id, body.openingBalance, body.openingDate)),
      ]);
    } catch (err) {
      if (isUnique(err)) throw conflict(`There's already a contact called "${body.name}".`);
      throw err;
    }
    return c.json({ contact: await findContact(c, id) }, 201);
  })

  .patch("/:contactId", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, updateContact);
    await checkCategory(c, body.defaultCategoryId);
    const db = c.env.DB;
    const before = await findContact(c, c.req.param("contactId"));
    const next = {
      name: body.name ?? before.name,
      kind: body.kind ?? before.kind,
      aliases: body.aliases === undefined ? before.aliases : body.aliases || null,
      defaultCategoryId: body.defaultCategoryId === undefined ? before.defaultCategoryId : body.defaultCategoryId,
      archived: body.archived ?? before.archived,
    };
    if (next.archived && !before.archived && before.balance !== 0) {
      throw badRequest(`Settle up with ${before.name} before archiving: the balance isn't zero.`);
    }
    try {
      await db.batch([
        sql(
          db,
          `UPDATE contacts SET name = ?, kind = ?, aliases = ?, default_category_id = ?,
             archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END
           WHERE id = ? AND entity_id = ?`,
          next.name,
          next.kind,
          next.aliases,
          next.defaultCategoryId,
          next.archived ? 1 : 0,
          now(),
          before.id,
          c.var.entity.id,
        ),
        audit(db, {
          entityId: c.var.entity.id,
          actorId: c.var.user.id,
          action: "contact.update",
          targetType: "contact",
          targetId: before.id,
          summary: `${next.archived && !before.archived ? "Archived" : "Updated"} contact ${before.name}${next.name !== before.name ? ` → ${next.name}` : ""}`,
          before,
          after: next,
        }),
      ]);
    } catch (err) {
      if (isUnique(err)) throw conflict(`"${next.name}" is already a contact.`);
      throw err;
    }
    return c.json({ contact: await findContact(c, before.id) });
  })

  // Merge duplicates ("Zomato Lim", "Zomatoltd Rz" → "Zomato"): every posting and learned
  // UPI ID moves to the target, the old name becomes an alias so imports recognise it, and
  // the duplicate is archived.
  .post("/:contactId/merge", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, z.object({ into: z.string() }));
    const db = c.env.DB;
    const all = await loadContacts(db, c.var.entity);
    const from = all.find((x) => x.id === c.req.param("contactId"));
    const into = all.find((x) => x.id === body.into && !x.archived);
    if (!from || !into) throw notFound("Contact not found.");
    if (from.id === into.id) throw badRequest("Pick a different contact to merge into.");
    const aliases = [...new Set([...(into.aliases?.split(",").map((s) => s.trim()) ?? []), from.name, ...(from.aliases?.split(",").map((s) => s.trim()) ?? [])].filter(Boolean))].join(", ");
    await db.batch([
      sql(db, "UPDATE postings SET contact_id = ? WHERE contact_id = ? AND entity_id = ?", into.id, from.id, c.var.entity.id),
      sql(db, "UPDATE contact_identifiers SET contact_id = ? WHERE contact_id = ? AND entity_id = ?", into.id, from.id, c.var.entity.id),
      sql(db, "UPDATE contacts SET aliases = ? WHERE id = ?", aliases.slice(0, 300), into.id),
      sql(db, "UPDATE contacts SET archived_at = COALESCE(archived_at, ?) WHERE id = ?", now(), from.id),
      audit(db, { entityId: c.var.entity.id, actorId: c.var.user.id, action: "contact.merge", targetType: "contact", targetId: into.id, summary: `Merged ${from.name} into ${into.name}` }),
    ]);
    return c.json({ contact: await findContact(c, into.id) });
  })

  // Statement with one contact: every transaction that names them, newest
  // first, with the running "who owes whom" balance after each.
  .get("/:contactId/statement", async (c) => {
    const db = c.env.DB;
    const entity = c.var.entity;
    const contact = await findContact(c, c.req.param("contactId"));
    const [rows, types] = await Promise.all([
      all<TxRow>(
        db,
        `${TX_SELECT} WHERE t.entity_id = ? AND t.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.contact_id = ?)
         ORDER BY t.date, t.created_at, t.id`,
        entity.id,
        contact.id,
      ),
      loadAccountTypes(db, entity.id),
    ]);
    let running = 0;
    const out: (Transaction & { owed: number; running: number })[] = rows.map((r) => {
      const tx = txView(r, types, entity.iou_account_id);
      const owed = tx.postings.filter((p) => p.accountId === entity.iou_account_id && p.contactId === contact.id).reduce((s, p) => s + p.amount, 0);
      running += owed;
      return { ...tx, owed, running };
    });
    return c.json({ contact, rows: out.reverse() });
  })

  // Past transactions whose notes name a contact. Code collects candidate
  // words; Jev answers one yes/no per word ("is this a business or person?")
  // in a single request. Nothing changes until you accept a suggestion.
  .get("/suggestions", async (c) => {
    need(c, "editor");
    const db = c.env.DB;
    const rows = await all<{ id: string; note: string }>(
      db,
      `SELECT t.id, t.note FROM transactions t
       WHERE t.entity_id = ? AND t.deleted_at IS NULL AND t.note IS NOT NULL AND t.kind IN ('expense','income')
         AND NOT EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.contact_id IS NOT NULL)
       ORDER BY t.date DESC LIMIT 2000`,
      c.var.entity.id,
    );
    const [contacts, accounts] = await Promise.all([loadContacts(db, c.var.entity), loadAccountTypes(db, c.var.entity.id)]);
    const suggestions = await findContactsInNotes(c.env, rows, contacts.filter((x) => !x.archived), [...accounts.values()].map((a) => a.name));
    return c.json({ suggestions });
  })

  .post("/suggestions/apply", async (c) => {
    need(c, "editor");
    const body = await parseBody(
      c,
      z.object({
        items: z
          .array(
            z.object({
              contactId: z.string().nullable().optional(),
              name: contactName,
              kind: z.enum(["person", "business"]),
              transactionIds: z.array(z.string()).min(1).max(2000),
            }),
          )
          .min(1)
          .max(100),
      }),
    );
    const db = c.env.DB;
    const entityId = c.var.entity.id;
    const iou = c.var.entity.iou_account_id;
    const stmts: D1PreparedStatement[] = [];
    let tagged = 0;
    for (const item of body.items) {
      let contactId = item.contactId ?? null;
      if (contactId) {
        if (!(await first(db, "SELECT 1 FROM contacts WHERE id = ? AND entity_id = ? AND archived_at IS NULL", contactId, entityId))) throw badRequest(`Unknown contact for ${item.name}.`);
      } else {
        const existing = await first<{ id: string }>(db, "SELECT id FROM contacts WHERE entity_id = ? AND name = ? COLLATE NOCASE AND archived_at IS NULL", entityId, item.name);
        contactId = existing?.id ?? uuidv7();
        if (!existing) stmts.push(sql(db, "INSERT INTO contacts (id, entity_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)", contactId, entityId, item.name, item.kind, now()));
      }
      // Only untagged legs of this entity's transactions; Lent & borrowed legs keep their own contact.
      for (let i = 0; i < item.transactionIds.length; i += 50) {
        const chunk = item.transactionIds.slice(i, i + 50);
        stmts.push(
          sql(
            db,
            `UPDATE postings SET contact_id = ? WHERE entity_id = ? AND contact_id IS NULL AND account_id IS NOT ?
               AND transaction_id IN (${chunk.map(() => "?").join(",")})`,
            contactId,
            entityId,
            iou,
            ...chunk,
          ),
        );
      }
      tagged += item.transactionIds.length;
      stmts.push(
        audit(db, {
          entityId,
          actorId: c.var.user.id,
          action: "contact.tag",
          targetType: "contact",
          targetId: contactId,
          summary: `Tagged ${item.transactionIds.length} past transaction${item.transactionIds.length === 1 ? "" : "s"} with ${item.name}`,
          after: { transactionIds: item.transactionIds },
        }),
      );
    }
    await db.batch(stmts);
    return c.json({ ok: true, tagged });
  });
