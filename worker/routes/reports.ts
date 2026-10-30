import { Hono } from "hono";
import { z } from "zod";
import { fiscalYear, isValidDate, today } from "../../shared/dates";
import { formatMoney, MAX_AMOUNT, toDecimal } from "../../shared/money";
import type { ActivityItem, MonthTotal, Summary } from "../../shared/types";
import { audit } from "../audit";
import { type AppEnv, type Ctx, all, badRequest, first, need, notFound, parseBody, sql } from "../http";
import { loadAccountTypes, TX_SELECT, type TxRow, txView } from "../views";

async function contactNames(db: D1Database, entityId: string) {
  const rows = await all<{ id: string; name: string }>(db, "SELECT id, name FROM contacts WHERE entity_id = ?", entityId);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function range(c: Ctx): { from: string; to: string } {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from && to) {
    if (!isValidDate(from) || !isValidDate(to)) throw badRequest("from and to must be YYYY-MM-DD.");
    if (from > to) throw badRequest("from must not be after to.");
    return { from, to };
  }
  const fy = fiscalYear(today(c.var.entity.timezone), c.var.entity.fy_start_month);
  return { from: fy.from, to: fy.to };
}

/** Spreadsheet apps execute cells that start with = + - @; neutralise them in text fields. */
function csvCell(value: string | number | null | undefined, isText = true): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvRow = (cells: string[]) => cells.join(",");

export const reportRoutes = new Hono<AppEnv>()
  // Income and expense for a period, by category and by day. Transfers and
  // opening balances never count: they move money, they don't earn or spend it.
  .get("/summary", async (c) => {
    const { from, to } = range(c);
    const db = c.env.DB;
    const base = `FROM postings p
      JOIN transactions t ON t.id = p.transaction_id
      JOIN accounts a ON a.id = p.account_id
      WHERE t.entity_id = ? AND t.deleted_at IS NULL AND t.date >= ? AND t.date <= ? AND a.type IN ('income','expense')`;
    const [cats, days, people] = await Promise.all([
      all<{ account_id: string; type: string; total: number }>(db, `SELECT p.account_id, a.type, SUM(p.amount) AS total ${base} GROUP BY p.account_id`, c.var.entity.id, from, to),
      all<{ date: string; type: string; total: number }>(db, `SELECT t.date, a.type, SUM(p.amount) AS total ${base} GROUP BY t.date, a.type ORDER BY t.date`, c.var.entity.id, from, to),
      all<{ contact_id: string; type: string; total: number }>(
        db,
        `SELECT p.contact_id, a.type, SUM(p.amount) AS total ${base} AND p.contact_id IS NOT NULL GROUP BY p.contact_id, a.type`,
        c.var.entity.id,
        from,
        to,
      ),
    ]);
    const byContact = new Map<string, { contactId: string; expense: number; income: number }>();
    for (const r of people) {
      const row = byContact.get(r.contact_id) ?? { contactId: r.contact_id, expense: 0, income: 0 };
      if (r.type === "income") row.income += -r.total;
      else row.expense += r.total;
      byContact.set(r.contact_id, row);
    }
    const byDay = new Map<string, { date: string; income: number; expense: number }>();
    for (const d of days) {
      const row = byDay.get(d.date) ?? { date: d.date, income: 0, expense: 0 };
      if (d.type === "income") row.income += -d.total;
      else row.expense += d.total;
      byDay.set(d.date, row);
    }
    const summary: Summary = {
      from,
      to,
      income: cats.filter((r) => r.type === "income").reduce((s, r) => s - r.total, 0),
      expense: cats.filter((r) => r.type === "expense").reduce((s, r) => s + r.total, 0),
      byCategory: cats
        .map((r) => ({ accountId: r.account_id, amount: r.type === "income" ? -r.total : r.total }))
        .sort((a, b) => b.amount - a.amount),
      byDay: [...byDay.values()],
      byContact: [...byContact.values()].sort((a, b) => b.expense + b.income - (a.expense + a.income)),
    };
    return c.json(summary);
  })

  .get("/monthly", async (c) => {
    const { from, to } = range(c);
    const rows = await all<{ month: string; type: string; total: number }>(
      c.env.DB,
      `SELECT substr(t.date, 1, 7) AS month, a.type, SUM(p.amount) AS total
       FROM postings p JOIN transactions t ON t.id = p.transaction_id JOIN accounts a ON a.id = p.account_id
       WHERE t.entity_id = ? AND t.deleted_at IS NULL AND t.date >= ? AND t.date <= ? AND a.type IN ('income','expense')
       GROUP BY month, a.type ORDER BY month`,
      c.var.entity.id,
      from,
      to,
    );
    const months = new Map<string, MonthTotal>();
    for (const r of rows) {
      const m = months.get(r.month) ?? { month: r.month, income: 0, expense: 0 };
      if (r.type === "income") m.income += -r.total;
      else m.expense += r.total;
      months.set(r.month, m);
    }
    return c.json({ from, to, months: [...months.values()] });
  })

  .get("/budgets", async (c) => {
    const rows = await all<{ account_id: string; amount: number }>(
      c.env.DB,
      "SELECT account_id, amount FROM budgets WHERE entity_id = ?",
      c.var.entity.id,
    );
    return c.json({ budgets: rows.map((r) => ({ accountId: r.account_id, amount: r.amount })) });
  })

  // Monthly budget per expense category; 0 removes it.
  .put("/budgets/:accountId", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, z.object({ amount: z.number().int().min(0).max(MAX_AMOUNT) }));
    const db = c.env.DB;
    const accountId = c.req.param("accountId");
    const cat = await first<{ name: string }>(db, "SELECT name FROM accounts WHERE id = ? AND entity_id = ? AND type = 'expense'", accountId, c.var.entity.id);
    if (!cat) throw notFound("Expense category not found.");
    await db.batch([
      body.amount === 0
        ? sql(db, "DELETE FROM budgets WHERE entity_id = ? AND account_id = ?", c.var.entity.id, accountId)
        : sql(
            db,
            `INSERT INTO budgets (entity_id, account_id, amount) VALUES (?, ?, ?)
             ON CONFLICT (entity_id, account_id) DO UPDATE SET amount = excluded.amount`,
            c.var.entity.id,
            accountId,
            body.amount,
          ),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "budget.set",
        targetType: "account",
        targetId: accountId,
        summary: body.amount === 0 ? `Removed budget for ${cat.name}` : `Set ${cat.name} budget to ${formatMoney(body.amount, { currency: c.var.entity.currency })}`,
      }),
    ]);
    return c.json({ budget: { accountId, amount: body.amount } });
  })

  .get("/activity", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
    const before = Number(c.req.query("before") ?? 0) || Number.MAX_SAFE_INTEGER;
    const rows = await all<{ id: string; action: string; summary: string; actor_name: string | null; target_type: string; target_id: string | null; created_at: number }>(
      c.env.DB,
      `SELECT l.id, l.action, l.summary, u.name AS actor_name, l.target_type, l.target_id, l.created_at
       FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
       WHERE l.entity_id = ? AND l.created_at < ? ORDER BY l.created_at DESC LIMIT ?`,
      c.var.entity.id,
      before,
      limit,
    );
    const items: ActivityItem[] = rows.map((r) => ({
      id: r.id,
      action: r.action,
      summary: r.summary,
      actorName: r.actor_name,
      targetType: r.target_type,
      targetId: r.target_id,
      createdAt: r.created_at,
    }));
    return c.json({ items });
  })

  // Every transaction must balance. Anything listed here is a bug.
  .get("/integrity", async (c) => {
    const rows = await all<{ transaction_id: string; total: number }>(
      c.env.DB,
      "SELECT transaction_id, SUM(amount) AS total FROM postings WHERE entity_id = ? GROUP BY transaction_id HAVING SUM(amount) <> 0",
      c.var.entity.id,
    );
    return c.json({ ok: rows.length === 0, unbalanced: rows });
  })

  // CSV for the CA. format=transactions (one row each) or format=journal (one row per posting, debit/credit).
  .get("/export.csv", async (c) => {
    const { from, to } = range(c);
    const format = c.req.query("format") === "journal" ? "journal" : "transactions";
    const db = c.env.DB;
    const entity = c.var.entity;
    const [rows, types, people] = await Promise.all([
      all<TxRow>(db, `${TX_SELECT} WHERE t.entity_id = ? AND t.deleted_at IS NULL AND t.date >= ? AND t.date <= ? ORDER BY t.date, t.created_at`, entity.id, from, to),
      loadAccountTypes(db, entity.id),
      contactNames(db, entity.id),
    ]);
    const name = (id: string | null) => (id ? (types.get(id)?.name ?? "") : "");
    const who = (id: string | null | undefined) => (id ? (people.get(id) ?? "") : "");
    const lines: string[] = [];
    if (format === "journal") {
      lines.push(csvRow(["Date", "Transaction ID", "Type", "Account", "Account type", "Debit", "Credit", "Party", "Note"]));
      for (const row of rows) {
        const tx = txView(row, types, entity.iou_account_id);
        for (const p of tx.postings) {
          lines.push(
            csvRow([
              tx.date,
              tx.id,
              tx.kind,
              csvCell(name(p.accountId)),
              types.get(p.accountId)?.type ?? "",
              p.amount > 0 ? toDecimal(p.amount) : "",
              p.amount < 0 ? toDecimal(-p.amount) : "",
              csvCell(who(p.contactId)),
              csvCell(tx.note),
            ]),
          );
        }
      }
    } else {
      lines.push(
        csvRow(["Date", "Type", "Amount", "Currency", "Account", "Category", "To account", "Contact", "Paid by", "Split with", "Their share", "Note", "Added by", "Transaction ID"]),
      );
      for (const row of rows) {
        const tx = txView(row, types, entity.iou_account_id);
        lines.push(
          csvRow([
            tx.date,
            tx.kind,
            toDecimal(tx.amount),
            entity.currency,
            csvCell(name(tx.accountId)),
            csvCell(name(tx.categoryId)),
            csvCell(name(tx.toAccountId)),
            csvCell(who(tx.contactId)),
            csvCell(who(tx.paidBy)),
            csvCell(who(tx.share?.contactId)),
            tx.share ? toDecimal(tx.share.amount) : "",
            csvCell(tx.note),
            csvCell(tx.createdByName),
            tx.id,
          ]),
        );
      }
    }
    const slug = entity.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "entity";
    return new Response("\uFEFF" + lines.join("\r\n") + "\r\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${slug}_${from}_${to}_${format}.csv"`,
        "cache-control": "no-store",
      },
    });
  });
