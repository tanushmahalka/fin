import { Hono } from "hono";
import { z } from "zod";
import type { ApiToken, Me, Role } from "../../shared/types";
import { createToken, requireUser } from "../auth";
import { hashPassword, verifyPassword } from "../crypto";
import { type AppEnv, type EntityRow, all, badRequest, first, notFound, parseBody, sql } from "../http";
import { entityView } from "../views";
import { password, personName } from "./auth";

export const meRoutes = new Hono<AppEnv>()
  .use(requireUser)

  .get("/", async (c) => {
    const rows = await all<EntityRow & { role: Role }>(
      c.env.DB,
      `SELECT e.id, e.name, e.kind, e.currency, e.fy_start_month, e.timezone, e.color, e.default_account_id, e.iou_account_id, m.role
       FROM entities e JOIN memberships m ON m.entity_id = e.id
       WHERE m.user_id = ? ORDER BY e.kind = 'business', e.created_at`,
      c.var.user.id,
    );
    const body: Me = {
      user: c.var.user,
      entities: rows.map(({ role, ...e }) => entityView(e, role)),
      appName: c.env.APP_NAME,
    };
    return c.json(body);
  })

  .patch("/", async (c) => {
    const body = await parseBody(c, z.object({ name: personName }));
    await sql(c.env.DB, "UPDATE users SET name = ? WHERE id = ?", body.name, c.var.user.id).run();
    return c.json({ user: { ...c.var.user, name: body.name } });
  })

  .post("/password", async (c) => {
    const body = await parseBody(c, z.object({ currentPassword: z.string().min(1), newPassword: password }));
    const row = await first<{ password_hash: string }>(c.env.DB, "SELECT password_hash FROM users WHERE id = ?", c.var.user.id);
    if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw badRequest("Current password is incorrect.");
    }
    // Changing a password signs out every other session and CLI token.
    await c.env.DB.batch([
      sql(c.env.DB, "UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(body.newPassword), c.var.user.id),
      sql(c.env.DB, "DELETE FROM tokens WHERE user_id = ? AND id <> ?", c.var.user.id, c.var.tokenId),
    ]);
    return c.json({ ok: true });
  })

  .get("/tokens", async (c) => {
    const rows = await all<{ id: string; name: string | null; agent: number; created_at: number; last_used_at: number | null }>(
      c.env.DB,
      "SELECT id, name, agent, created_at, last_used_at FROM tokens WHERE user_id = ? AND kind = 'cli' ORDER BY created_at DESC",
      c.var.user.id,
    );
    const tokens: ApiToken[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      agent: !!r.agent,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      current: r.id === c.var.tokenId,
    }));
    return c.json({ tokens });
  })

  .post("/tokens", async (c) => {
    const body = await parseBody(c, z.object({ name: z.string().trim().min(1).max(80), agent: z.boolean().optional() }));
    const token = await createToken(c.env.DB, c.var.user.id, "cli", body.name, body.agent);
    await token.stmt.run();
    return c.json({ token: token.secret, id: token.id }, 201);
  })

  .delete("/tokens/:id", async (c) => {
    const result = await sql(
      c.env.DB,
      "DELETE FROM tokens WHERE id = ? AND user_id = ? AND kind = 'cli'",
      c.req.param("id"),
      c.var.user.id,
    ).run();
    if (!result.meta.changes) throw notFound("Token not found.");
    return c.json({ ok: true });
  });
