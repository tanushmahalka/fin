import { Hono } from "hono";
import { z } from "zod";
import { emiProgress } from "../../shared/emi";
import { isValidDate, today } from "../../shared/dates";
import { uuidv7 } from "../../shared/ids";
import { displayBalance } from "../../shared/ledger";
import { formatMoney, MAX_AMOUNT } from "../../shared/money";
import type { Account, EmiPlan } from "../../shared/types";
import { audit } from "../audit";
import { type AppEnv, type Ctx, all, badRequest, first, need, notFound, now, parseBody, sql } from "../http";
import { loadAccounts } from "../views";

interface PlanRow {
  id: string;
  account_id: string;
  balance_account_id: string | null;
  title: string;
  merchant: string | null;
  contact_id: string | null;
  purchase_tx_id: string | null;
  evidence: string | null;
  principal: number | null;
  instalment: number;
  months: number | null;
  first_due: string | null;
  closed_at: number | null;
  created_at: number;
}

const date = z.string().refine(isValidDate, "Use a YYYY-MM-DD date.");
const amount = z.number().int().min(1).max(MAX_AMOUNT);

const fields = {
  title: z.string().trim().min(1, "Say what it paid for.").max(80),
  merchant: z.string().trim().max(60).nullable().optional(),
  contactId: z.string().nullable().optional(),
  purchaseTxId: z.string().nullable().optional(),
  evidence: z.string().trim().max(200).nullable().optional(),
  principal: amount.nullable().optional(),
  instalment: amount,
  months: z.number().int().min(1).max(600).nullable().optional(),
  firstDue: date.nullable().optional(),
};

const createPlan = z.object({
  ...fields,
  accountId: z.string(),
  /**
   * Where the unpaid principal lives:
   *  "separate" — the card bills one instalment a month; a hidden sub-account of the card holds the rest.
   *  "in-account" — the card's own balance already includes it (SBI Card).
   *  an account id — a loan account.
   */
  balance: z.union([z.literal("separate"), z.literal("in-account"), z.object({ accountId: z.string() })]),
});

const updatePlan = z.object({ ...fields, closed: z.boolean().optional() }).partial();

function planView(r: PlanRow, accounts: Map<string, Account>, on: string): EmiPlan {
  const holder = r.balance_account_id ? accounts.get(r.balance_account_id) : undefined;
  const plan = {
    principal: r.principal,
    instalment: r.instalment,
    months: r.months,
    firstDue: r.first_due,
    closed: r.closed_at !== null,
  };
  return {
    id: r.id,
    accountId: r.account_id,
    balanceAccountId: r.balance_account_id,
    title: r.title,
    merchant: r.merchant,
    contactId: r.contact_id,
    purchaseTxId: r.purchase_tx_id,
    evidence: r.evidence,
    createdAt: r.created_at,
    ...plan,
    ...emiProgress(plan, holder ? displayBalance(holder.type, holder.balance) : null, on),
  };
}

async function loadPlans(c: Ctx, asOf?: string): Promise<EmiPlan[]> {
  const on = asOf ?? today(c.var.entity.timezone);
  const [rows, accounts] = await Promise.all([
    all<PlanRow>(c.env.DB, "SELECT * FROM emi_plans WHERE entity_id = ? ORDER BY created_at", c.var.entity.id),
    loadAccounts(c.env.DB, c.var.entity, on),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rows.map((r) => planView(r, byId, on));
}

async function checkRefs(c: Ctx, body: { contactId?: string | null; purchaseTxId?: string | null }) {
  const db = c.env.DB;
  const entityId = c.var.entity.id;
  if (body.contactId && !(await first(db, "SELECT 1 FROM contacts WHERE id = ? AND entity_id = ?", body.contactId, entityId)))
    throw badRequest("That contact isn't in this book.");
  if (body.purchaseTxId && !(await first(db, "SELECT 1 FROM transactions WHERE id = ? AND entity_id = ?", body.purchaseTxId, entityId)))
    throw badRequest("That purchase isn't in this book.");
}

export const emiRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const asOf = c.req.query("asOf");
    if (asOf && !isValidDate(asOf)) throw badRequest("asOf must be YYYY-MM-DD.");
    return c.json({ plans: await loadPlans(c, asOf || undefined) });
  })

  .post("/", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, createPlan);
    const db = c.env.DB;
    const entityId = c.var.entity.id;
    const accounts = await loadAccounts(db, c.var.entity);
    const account = accounts.find((a) => a.id === body.accountId && !a.archived);
    if (!account || (account.type !== "asset" && account.type !== "liability") || account.system)
      throw badRequest("Pick the card or bank account the instalments are paid from.");
    await checkRefs(c, body);
    if (body.balance === "in-account" && (!body.principal || !body.months || !body.firstDue))
      throw badRequest("When the card's balance already includes the EMI, give the amount, the months and the first instalment date so what's left can be worked out.");

    const id = uuidv7();
    const t = now();
    const stmts = [];
    let balanceAccountId: string | null = null;
    if (body.balance === "separate") {
      if (account.type !== "liability") throw badRequest("Only a card or credit line bills EMIs separately.");
      // Hidden sub-account of the card: the conversion credit moves the purchase here and
      // each instalment's principal moves back. Its balance is what's left on the plan.
      balanceAccountId = uuidv7();
      stmts.push(
        sql(
          db,
          `INSERT INTO accounts (id, entity_id, type, subtype, name, icon, hint, parent_id, sort, created_at, institution, own_share)
           VALUES (?, ?, 'liability', 'loan', ?, '🧾', ?, ?, 0, ?, ?, 100)`,
          balanceAccountId,
          entityId,
          `EMI · ${body.title}`.slice(0, 60),
          `Unbilled instalments of the ${body.title} EMI on ${account.name}`.slice(0, 200),
          account.id,
          t,
          account.institution,
        ),
      );
    } else if (typeof body.balance === "object") {
      const loan = accounts.find((a) => a.id === (body.balance as { accountId: string }).accountId);
      if (!loan || loan.type !== "liability") throw badRequest("The balance account must be a loan or card.");
      balanceAccountId = loan.id;
    }
    stmts.push(
      sql(
        db,
        `INSERT INTO emi_plans (id, entity_id, account_id, balance_account_id, title, merchant, contact_id, purchase_tx_id, evidence,
           principal, instalment, months, first_due, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        entityId,
        account.id,
        balanceAccountId,
        body.title,
        body.merchant || null,
        body.contactId ?? null,
        body.purchaseTxId ?? null,
        body.evidence || null,
        body.principal ?? null,
        body.instalment,
        body.months ?? null,
        body.firstDue ?? null,
        c.var.user.id,
        t,
      ),
      audit(db, {
        entityId,
        actorId: c.var.user.id,
        action: "emi.create",
        targetType: "emi_plan",
        targetId: id,
        summary: `Added EMI ${body.title}: ${formatMoney(body.instalment, { currency: c.var.entity.currency })} a month on ${account.name}`,
        after: body,
      }),
    );
    await db.batch(stmts);
    const plan = (await loadPlans(c)).find((p) => p.id === id)!;
    return c.json({ plan }, 201);
  })

  .patch("/:planId", async (c) => {
    need(c, "editor");
    const body = await parseBody(c, updatePlan);
    const db = c.env.DB;
    const before = await first<PlanRow>(db, "SELECT * FROM emi_plans WHERE id = ? AND entity_id = ?", c.req.param("planId"), c.var.entity.id);
    if (!before) throw notFound("EMI plan not found.");
    await checkRefs(c, body);
    const pick = <K extends keyof typeof body>(k: K, current: unknown) => (body[k] === undefined ? current : body[k]);
    const next = {
      title: pick("title", before.title) as string,
      merchant: (pick("merchant", before.merchant) as string | null) || null,
      contact_id: pick("contactId", before.contact_id) as string | null,
      purchase_tx_id: pick("purchaseTxId", before.purchase_tx_id) as string | null,
      evidence: (pick("evidence", before.evidence) as string | null) || null,
      principal: pick("principal", before.principal) as number | null,
      instalment: pick("instalment", before.instalment) as number,
      months: pick("months", before.months) as number | null,
      first_due: pick("firstDue", before.first_due) as string | null,
      closed_at: body.closed === undefined ? before.closed_at : body.closed ? (before.closed_at ?? now()) : null,
    };
    const stmts = [
      sql(
        db,
        `UPDATE emi_plans SET title = ?, merchant = ?, contact_id = ?, purchase_tx_id = ?, evidence = ?, principal = ?, instalment = ?,
           months = ?, first_due = ?, closed_at = ? WHERE id = ? AND entity_id = ?`,
        next.title,
        next.merchant,
        next.contact_id,
        next.purchase_tx_id,
        next.evidence,
        next.principal,
        next.instalment,
        next.months,
        next.first_due,
        next.closed_at,
        before.id,
        c.var.entity.id,
      ),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "emi.update",
        targetType: "emi_plan",
        targetId: before.id,
        summary: `${body.closed === true && !before.closed_at ? "Closed" : "Updated"} EMI ${next.title}`,
        before,
        after: next,
      }),
    ];
    // Keep the hidden sub-account's name in step with the plan.
    if (next.title !== before.title && before.balance_account_id) {
      stmts.push(
        sql(
          db,
          "UPDATE accounts SET name = ? WHERE id = ? AND entity_id = ? AND parent_id = ?",
          `EMI · ${next.title}`.slice(0, 60),
          before.balance_account_id,
          c.var.entity.id,
          before.account_id,
        ),
      );
    }
    await db.batch(stmts);
    const plan = (await loadPlans(c)).find((p) => p.id === before.id)!;
    return c.json({ plan });
  });
