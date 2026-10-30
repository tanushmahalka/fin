import { Hono } from "hono";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { audit } from "../audit";
import { requireMember, requireUser } from "../auth";
import { type AppEnv, type EntityRow, badRequest, first, need, now, parseBody, sql } from "../http";
import { seedAccounts } from "../seed";
import { entityView } from "../views";
import { accountRoutes } from "./accounts";
import { assistRoutes } from "./assist";
import { memberRoutes } from "./members";
import { reportRoutes } from "./reports";
import { contactRoutes } from "./contacts";
import { emiRoutes } from "./emis";
import { subscriptionRoutes } from "./subscriptions";
import { importRoutes } from "./imports";
import { transactionRoutes } from "./transactions";

const color = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a hex colour like #5b5bd6.");
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown time zone.");

const createEntity = z.object({
  name: z.string().trim().min(1, "Give it a name.").max(80),
  kind: z.enum(["personal", "business"]),
  currency: z.string().regex(/^[A-Z]{3}$/).default("INR"),
  fyStartMonth: z.number().int().min(1).max(12).optional(),
  timezone: timezone.default("Asia/Kolkata"),
  color: color.optional(),
});

const updateEntity = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  fyStartMonth: z.number().int().min(1).max(12).optional(),
  timezone: timezone.optional(),
  color: color.optional(),
  defaultAccountId: z.string().nullable().optional(),
});

export const entityRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .post("/", async (c) => {
    const body = await parseBody(c, createEntity);
    const db = c.env.DB;
    const id = uuidv7();
    const t = now();
    const fyStartMonth = body.fyStartMonth ?? (body.currency === "INR" ? 4 : 1);
    const entityColor = body.color ?? (body.kind === "business" ? "#0d9488" : "#5b5bd6");
    const seed = seedAccounts(db, id, body.kind);
    await db.batch([
      sql(
        db,
        `INSERT INTO entities (id, name, kind, currency, fy_start_month, timezone, color, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        body.name,
        body.kind,
        body.currency,
        fyStartMonth,
        body.timezone,
        entityColor,
        c.var.user.id,
        t,
      ),
      sql(db, "INSERT INTO memberships (entity_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", id, c.var.user.id, t),
      ...seed.stmts,
      sql(db, "UPDATE entities SET default_account_id = ?, iou_account_id = ? WHERE id = ?", seed.defaultAccountId, seed.iouAccountId, id),
      audit(db, {
        entityId: id,
        actorId: c.var.user.id,
        action: "entity.create",
        targetType: "entity",
        targetId: id,
        summary: `Created ${body.name}`,
      }),
    ]);
    const row = await first<EntityRow>(db, "SELECT * FROM entities WHERE id = ?", id);
    return c.json({ entity: entityView(row!, "owner") }, 201);
  })

  .use("/:entityId", requireMember)
  .use("/:entityId/*", requireMember)

  .get("/:entityId", (c) => c.json({ entity: entityView(c.var.entity, c.var.role) }))

  .patch("/:entityId", async (c) => {
    need(c, "owner");
    const body = await parseBody(c, updateEntity);
    const db = c.env.DB;
    const e = c.var.entity;
    if (body.defaultAccountId) {
      const acct = await first(
        db,
        "SELECT 1 FROM accounts WHERE id = ? AND entity_id = ? AND type IN ('asset','liability') AND archived_at IS NULL",
        body.defaultAccountId,
        e.id,
      );
      if (!acct) throw badRequest("Default account must be an active money account.");
    }
    const next: EntityRow = {
      ...e,
      name: body.name ?? e.name,
      fy_start_month: body.fyStartMonth ?? e.fy_start_month,
      timezone: body.timezone ?? e.timezone,
      color: body.color ?? e.color,
      default_account_id: body.defaultAccountId === undefined ? e.default_account_id : body.defaultAccountId,
    };
    await db.batch([
      sql(
        db,
        "UPDATE entities SET name = ?, fy_start_month = ?, timezone = ?, color = ?, default_account_id = ? WHERE id = ?",
        next.name,
        next.fy_start_month,
        next.timezone,
        next.color,
        next.default_account_id,
        e.id,
      ),
      audit(db, {
        entityId: e.id,
        actorId: c.var.user.id,
        action: "entity.update",
        targetType: "entity",
        targetId: e.id,
        summary: "Updated entity settings",
        before: e,
        after: next,
      }),
    ]);
    return c.json({ entity: entityView(next, c.var.role) });
  })

  .route("/:entityId/accounts", accountRoutes)
  .route("/:entityId/transactions", transactionRoutes)
  .route("/:entityId/contacts", contactRoutes)
  .route("/:entityId/emis", emiRoutes)
  .route("/:entityId/subscriptions", subscriptionRoutes)
  .route("/:entityId", reportRoutes)
  .route("/:entityId", memberRoutes)
  .route("/:entityId", assistRoutes)
  .route("/:entityId", importRoutes);
