import { Hono } from "hono";
import { z } from "zod";
import { isValidDate, today } from "../../shared/dates";
import { uuidv7 } from "../../shared/ids";
import { adjustmentPostings, displayBalance } from "../../shared/ledger";
import { formatMoney, MAX_AMOUNT } from "../../shared/money";
import type { Account, LedgerRow } from "../../shared/types";
import { audit } from "../audit";
import { type AppEnv, type Ctx, all, badRequest, conflict, first, need, notFound, now, parseBody, sql } from "../http";
import { OPENING_BALANCES } from "../seed";
import { loadAccounts, loadAccountTypes, TX_SELECT, type TxRow, txView } from "../views";

const subtype = z.enum(["cash", "bank", "card", "wallet", "investment", "loan", "other"]);
const date = z.string().refine(isValidDate, "Use a YYYY-MM-DD date.");

const statementDetails = {
  institution: z.string().trim().max(60).nullable().optional(),
  numberLast4: z.string().regex(/^\d{4}$/, "Use the last 4 digits.").nullable().optional(),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "That isn't an IFSC code.").nullable().optional(),
  groupLabel: z.string().trim().max(40).nullable().optional(),
  jointWith: z.string().trim().max(120).nullable().optional(),
  ownShare: z.number().int().min(0).max(100).optional(),
  creditLimit: z.number().int().min(0).max(MAX_AMOUNT).nullable().optional(),
};

/** Two live accounts with the same last 4 digits would make statement mapping a guess, so refuse it. */
async function checkLast4(c: Ctx, last4: string | null | undefined, exceptId?: string) {
  if (!last4) return;
  const other = await first<{ name: string }>(
    c.env.DB,
    "SELECT name FROM accounts WHERE entity_id = ? AND number_last4 = ? AND archived_at IS NULL AND id IS NOT ?",
    c.var.entity.id,
    last4,
    exceptId ?? null,
  );
  if (other) throw conflict(`${other.name} already ends in ${last4}. Statements need the last 4 digits to point at one account.`);
}

const createAccount = z.object({
  type: z.enum(["asset", "liability", "income", "expense"]),
  subtype: subtype.nullable().optional(),
  name: z.string().trim().min(1, "Give it a name.").max(60),
  icon: z.string().trim().max(16).nullable().optional(),
  hint: z.string().trim().max(200).nullable().optional(),
  parentId: z.string().nullable().optional(),
  /** Display terms: money held for assets, money owed for liabilities. */
  openingBalance: z.number().int().min(-MAX_AMOUNT).max(MAX_AMOUNT).optional(),
  openingDate: date.optional(),
  ...statementDetails,
});

const updateAccount = z.object({
  ...statementDetails,
  name: z.string().trim().min(1).max(60).optional(),
  icon: z.string().trim().max(16).nullable().optional(),
  hint: z.string().trim().max(200).nullable().optional(),
  subtype: subtype.nullable().optional(),
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
});

export async function equityAccountId(db: D1Database, entityId: string): Promise<string> {
  const row = await first<{ id: string }>(
    db,
    "SELECT id FROM accounts WHERE entity_id = ? AND type = 'equity' AND system = 1 ORDER BY created_at LIMIT 1",
    entityId,
  );
  if (row) return row.id;
  const id = uuidv7();
  await sql(
    db,
    "INSERT INTO accounts (id, entity_id, type, name, icon, system, created_at) VALUES (?, ?, 'equity', ?, '⚖️', 1, ?)",
    id,
    entityId,
    OPENING_BALANCES,
    now(),
  ).run();
  return id;
}

/** Statements for a balance-moving equity transaction (opening balance or reconciliation). */
function equityTransaction(
  c: Ctx,
  kind: "opening" | "adjustment",
  date: string,
  postings: { accountId: string; amount: number }[],
  note: string,
) {
  const db = c.env.DB;
  const txId = uuidv7();
  const t = now();
  return {
    txId,
    stmts: [
      sql(
        db,
        "INSERT INTO transactions (id, entity_id, date, kind, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        txId,
        c.var.entity.id,
        date,
        kind,
        note,
        c.var.user.id,
        t,
      ),
      ...postings.map((p) =>
        sql(
          db,
          "INSERT INTO postings (id, transaction_id, entity_id, account_id, amount) VALUES (?, ?, ?, ?, ?)",
          uuidv7(),
          txId,
          c.var.entity.id,
          p.accountId,
          p.amount,
        ),
      ),
    ],
  };
}

function isUniqueViolation(err: unknown) {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function asOf(c: Ctx) {
  const v = c.req.query("asOf");
  if (v && !isValidDate(v)) throw badRequest("asOf must be YYYY-MM-DD.");
  return v || undefined;
}

async function findAccount(c: Ctx, id: string): Promise<Account> {
  const account = (await loadAccounts(c.env.DB, c.var.entity)).find((a) => a.id === id);
  if (!account) throw notFound("Account not found.");
  return account;
}

export const accountRoutes = new Hono<AppEnv>()
  // ?asOf=YYYY-MM-DD gives balances at the end of that day (e.g. 31 March for the CA).
  .get("/", async (c) => {
    const accounts = await loadAccounts(c.env.DB, c.var.entity, asOf(c));
    return c.json({ accounts });
  })

  .post("/", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, createAccount);
    const db = c.env.DB;
    const entity = c.var.entity;
    const isMoney = body.type === "asset" || body.type === "liability";
    if (!isMoney && body.openingBalance) throw badRequest("Only money accounts have an opening balance.");
    if (body.parentId) {
      const parent = await first<{ type: string }>(db, "SELECT type FROM accounts WHERE id = ? AND entity_id = ?", body.parentId, entity.id);
      if (!parent || parent.type !== body.type) throw badRequest("Parent must be a category of the same type.");
    }

    await checkLast4(c, body.numberLast4);
    const id = uuidv7();
    const maxSort = await first<{ s: number | null }>(db, "SELECT MAX(sort) AS s FROM accounts WHERE entity_id = ? AND type = ?", entity.id, body.type);
    const stmts = [
      sql(
        db,
        `INSERT INTO accounts (id, entity_id, type, subtype, name, icon, hint, parent_id, sort, created_at, institution, number_last4, ifsc, group_label, joint_with, own_share, credit_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        entity.id,
        body.type,
        isMoney ? (body.subtype ?? "other") : null,
        body.name,
        body.icon ?? null,
        body.hint || null,
        body.parentId ?? null,
        (maxSort?.s ?? 0) + 1,
        now(),
        isMoney ? body.institution || null : null,
        isMoney ? body.numberLast4 || null : null,
        isMoney ? body.ifsc || null : null,
        isMoney ? body.groupLabel || null : null,
        isMoney ? body.jointWith || null : null,
        isMoney ? (body.ownShare ?? 100) : 100,
        body.type === "liability" ? (body.creditLimit ?? null) : null,
      ),
    ];
    const label = isMoney ? "account" : `${body.type} category`;
    stmts.push(
      audit(db, {
        entityId: entity.id,
        actorId: c.var.user.id,
        action: "account.create",
        targetType: "account",
        targetId: id,
        summary: `Added ${label} ${body.name}`,
        after: body,
      }),
    );
    if (isMoney && body.openingBalance) {
      const equityId = await equityAccountId(db, entity.id);
      const raw = body.type === "liability" ? -body.openingBalance : body.openingBalance;
      const tx = equityTransaction(
        c,
        "opening",
        body.openingDate ?? today(entity.timezone),
        [
          { accountId: id, amount: raw },
          { accountId: equityId, amount: -raw },
        ],
        "Opening balance",
      );
      stmts.push(...tx.stmts);
    }
    try {
      await db.batch(stmts);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`There's already a ${label} called "${body.name}".`);
      throw err;
    }
    return c.json({ account: await findAccount(c, id) }, 201);
  })

  .patch("/:accountId", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, updateAccount);
    const db = c.env.DB;
    const before = await findAccount(c, c.req.param("accountId"));
    if (before.system) throw badRequest("System accounts can't be changed.");
    await checkLast4(c, body.numberLast4, before.id);
    const next = {
      name: body.name ?? before.name,
      icon: body.icon === undefined ? before.icon : body.icon,
      hint: body.hint === undefined ? before.hint : body.hint || null,
      subtype: body.subtype === undefined ? before.subtype : body.subtype,
      sort: body.sort ?? before.sort,
      archived: body.archived ?? before.archived,
      institution: body.institution === undefined ? before.institution : body.institution || null,
      numberLast4: body.numberLast4 === undefined ? before.numberLast4 : body.numberLast4 || null,
      ifsc: body.ifsc === undefined ? before.ifsc : body.ifsc || null,
      groupLabel: body.groupLabel === undefined ? before.groupLabel : body.groupLabel || null,
      jointWith: body.jointWith === undefined ? before.jointWith : body.jointWith || null,
      ownShare: body.ownShare ?? before.ownShare,
      creditLimit: before.type !== "liability" ? null : body.creditLimit === undefined ? before.creditLimit : body.creditLimit,
    };
    const verb = body.archived === true && !before.archived ? "Archived" : body.archived === false && before.archived ? "Restored" : "Updated";
    try {
      await db.batch([
        sql(
          db,
          `UPDATE accounts SET name = ?, icon = ?, hint = ?, subtype = ?, sort = ?, institution = ?, number_last4 = ?, ifsc = ?,
             group_label = ?, joint_with = ?, own_share = ?, credit_limit = ?,
             archived_at = CASE WHEN ? THEN COALESCE(archived_at, ?) ELSE NULL END
           WHERE id = ? AND entity_id = ?`,
          next.name,
          next.icon,
          next.hint,
          next.subtype,
          next.sort,
          next.institution,
          next.numberLast4,
          next.ifsc,
          next.groupLabel,
          next.jointWith,
          next.ownShare,
          next.creditLimit,
          next.archived ? 1 : 0,
          now(),
          before.id,
          c.var.entity.id,
        ),
        ...(next.archived && c.var.entity.default_account_id === before.id
          ? [sql(db, "UPDATE entities SET default_account_id = NULL WHERE id = ?", c.var.entity.id)]
          : []),
        audit(db, {
          entityId: c.var.entity.id,
          actorId: c.var.user.id,
          action: "account.update",
          targetType: "account",
          targetId: before.id,
          summary: `${verb} ${before.name}${next.name !== before.name ? ` → ${next.name}` : ""}`,
          before,
          after: next,
        }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`"${next.name}" is already taken.`);
      throw err;
    }
    return c.json({ account: await findAccount(c, before.id) });
  })

  // Reconciliation: "my bank app says ₹42,180" → post the difference against equity.
  .post("/:accountId/adjust", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, z.object({ balance: z.number().int().min(-MAX_AMOUNT).max(MAX_AMOUNT), date: date.optional() }));
    const db = c.env.DB;
    const account = await findAccount(c, c.req.param("accountId"));
    if (account.type !== "asset" && account.type !== "liability") throw badRequest("Only money accounts can be reconciled.");
    // Compare against the balance on that day, not today's: later activity must not leak into a past adjustment.
    const on = body.date ?? today(c.var.entity.timezone);
    const then = (await loadAccounts(db, c.var.entity, on)).find((a) => a.id === account.id)!;
    const postings = adjustmentPostings(then, body.balance, await equityAccountId(db, c.var.entity.id));
    if (!postings.length) return c.json({ account, transactionId: null });
    const from = displayBalance(account.type, then.balance);
    const opts = { currency: c.var.entity.currency };
    const tx = equityTransaction(c, "adjustment", body.date ?? today(c.var.entity.timezone), postings, "Balance adjustment");
    await db.batch([
      ...tx.stmts,
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "account.adjust",
        targetType: "account",
        targetId: account.id,
        summary: `Reconciled ${account.name}: ${formatMoney(from, opts)} → ${formatMoney(body.balance, opts)}`,
        before: { balance: from },
        after: { balance: body.balance },
      }),
    ]);
    return c.json({ account: await findAccount(c, account.id), transactionId: tx.txId });
  })

  // Statement view: every transaction touching the account, newest first, with running balance.
  .get("/:accountId/ledger", async (c) => {
    const db = c.env.DB;
    const entityId = c.var.entity.id;
    const account = await findAccount(c, c.req.param("accountId"));
    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 1000);
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const rows = await all<{ id: string; delta: number; running: number }>(
      db,
      `WITH per_tx AS (
         SELECT t.id, t.date, t.created_at, SUM(p.amount) AS delta
         FROM postings p JOIN transactions t ON t.id = p.transaction_id
         WHERE p.entity_id = ? AND p.account_id = ? AND t.deleted_at IS NULL
         GROUP BY t.id
       )
       SELECT id, delta, SUM(delta) OVER (ORDER BY date, created_at, id ROWS UNBOUNDED PRECEDING) AS running
       FROM per_tx ORDER BY date DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
      entityId,
      account.id,
      limit,
      offset,
    );
    if (!rows.length) return c.json({ account, rows: [], nextOffset: null });
    const types = await loadAccountTypes(db, entityId);
    // D1 allows at most 100 bound parameters per query: look the rows up in chunks.
    const txRows: TxRow[] = [];
    for (let i = 0; i < rows.length; i += 90) {
      const chunk = rows.slice(i, i + 90).map((r) => r.id);
      txRows.push(...(await all<TxRow>(db, `${TX_SELECT} WHERE t.entity_id = ? AND t.id IN (${chunk.map(() => "?").join(",")})`, entityId, ...chunk)));
    }
    const byId = new Map(txRows.map((r) => [r.id, txView(r, types, c.var.entity.iou_account_id)]));
    const sign = account.type === "liability" ? -1 : 1;
    const ledger: LedgerRow[] = rows.flatMap((r) => {
      const tx = byId.get(r.id);
      return tx ? [{ ...tx, delta: r.delta * sign, running: r.running * sign }] : [];
    });
    return c.json({ account, rows: ledger, nextOffset: rows.length === limit ? offset + limit : null });
  });
