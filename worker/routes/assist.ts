import { Hono } from "hono";
import { AppError, type AppEnv, all, badRequest, first } from "../http";
import { type AskData, assist } from "../jev";
import { loadAccounts, loadAccountTypes, loadContacts, TX_SELECT, type TxRow, txView } from "../views";

// GET because it never writes: it proposes a draft or answers a question.
// That also lets viewers (e.g. the CA) ask questions without edit rights.
export const assistRoutes = new Hono<AppEnv>().get("/assist", async (c) => {
  const text = (c.req.query("text") ?? "").trim();
  if (!text) throw badRequest("Type something to add or ask.");
  if (text.length > 300) throw badRequest("Keep it under 300 characters.");
  const mode = (c.req.query("mode") ?? "auto") as "auto" | "record" | "ask";
  if (!["auto", "record", "ask"].includes(mode)) throw badRequest("mode must be auto, record or ask.");
  const kindParam = c.req.query("kind");
  const kind = (["expense", "income", "transfer", "gave", "got"] as const).find((k) => k === kindParam);

  const limiter = c.env.ASSIST_LIMITER;
  if (limiter && !(await limiter.limit({ key: `assist:${c.var.user.id}` })).success) {
    throw new AppError(429, "rate_limited", "Slow down a little; try again in a minute.");
  }

  const db = c.env.DB;
  const entity = c.var.entity;
  const [accounts, contacts] = await Promise.all([loadAccounts(db, entity), loadContacts(db, entity)]);

  const data: AskData = {
    async totals(from, to, kind, { categoryId, contactId }) {
      const row = await first<{ total: number | null; n: number }>(
        db,
        `SELECT SUM(p.amount) AS total, COUNT(DISTINCT t.id) AS n
         FROM postings p JOIN transactions t ON t.id = p.transaction_id JOIN accounts a ON a.id = p.account_id
         WHERE t.entity_id = ? AND t.deleted_at IS NULL AND t.date >= ? AND t.date <= ? AND a.type = ?
           ${categoryId ? "AND p.account_id = ?" : ""} ${contactId ? "AND p.contact_id = ?" : ""}`,
        entity.id,
        from,
        to,
        kind,
        ...(categoryId ? [categoryId] : []),
        ...(contactId ? [contactId] : []),
      );
      const total = row?.total ?? 0;
      return { amount: kind === "income" ? -total : total, count: row?.n ?? 0 };
    },
    async transactions(from, to, filter, limit) {
      const where = ["t.entity_id = ?", "t.deleted_at IS NULL", "t.date >= ?", "t.date <= ?"];
      const params: unknown[] = [entity.id, from, to];
      for (const id of [filter.categoryId, filter.accountId]) {
        if (id) {
          where.push("EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.account_id = ?)");
          params.push(id);
        }
      }
      if (filter.contactId) {
        where.push("EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.contact_id = ?)");
        params.push(filter.contactId);
      }
      const [rows, types] = await Promise.all([
        all<TxRow>(db, `${TX_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.date DESC, t.created_at DESC LIMIT ?`, ...params, limit),
        loadAccountTypes(db, entity.id),
      ]);
      return rows.map((r) => txView(r, types, entity.iou_account_id));
    },
    async budget(categoryId) {
      const row = await first<{ total: number | null }>(
        db,
        `SELECT SUM(amount) AS total FROM budgets WHERE entity_id = ? ${categoryId ? "AND account_id = ?" : ""}`,
        entity.id,
        ...(categoryId ? [categoryId] : []),
      );
      return row?.total ?? null;
    },
  };

  const result = await assist(
    c.env,
    {
      entity: {
        name: entity.name,
        kind: entity.kind,
        currency: entity.currency,
        timezone: entity.timezone,
        fyStartMonth: entity.fy_start_month,
        iouAccountId: entity.iou_account_id,
      },
      accounts,
      contacts,
    },
    text,
    { mode, kind, debug: c.req.query("debug") === "1" },
    data,
  );
  return c.json(result);
});
