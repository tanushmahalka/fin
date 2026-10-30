import { Hono } from "hono";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import type { Invite, Member, Role } from "../../shared/types";
import { audit } from "../audit";
import { randomToken, sha256Hex } from "../crypto";
import { type AppEnv, type Ctx, all, badRequest, conflict, first, need, notFound, now, parseBody, sql } from "../http";
import { email } from "./auth";

const role = z.enum(["owner", "editor", "viewer"]);
const INVITE_TTL = 7 * 86_400_000;

async function ownerCount(c: Ctx) {
  const row = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM memberships WHERE entity_id = ? AND role = 'owner'", c.var.entity.id);
  return row?.n ?? 0;
}

async function loadMember(c: Ctx, userId: string) {
  const m = await first<{ role: Role; name: string; email: string }>(
    c.env.DB,
    "SELECT m.role, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.entity_id = ? AND m.user_id = ?",
    c.var.entity.id,
    userId,
  );
  if (!m) throw notFound("Member not found.");
  return m;
}

export const memberRoutes = new Hono<AppEnv>()
  .get("/members", async (c) => {
    const db = c.env.DB;
    const members = await all<{ user_id: string; name: string; email: string; role: Role; created_at: number }>(
      db,
      `SELECT m.user_id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.entity_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.name`,
      c.var.entity.id,
    );
    // Pending invites are only shown to owners, who are the ones who can act on them.
    const invites =
      c.var.role === "owner"
        ? await all<{ id: string; email: string; role: Role; created_at: number; expires_at: number; invited_by: string }>(
            db,
            `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, u.name AS invited_by FROM invites i JOIN users u ON u.id = i.created_by
             WHERE i.entity_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`,
            c.var.entity.id,
            now(),
          )
        : [];
    return c.json({
      members: members.map((m): Member => ({ userId: m.user_id, name: m.name, email: m.email, role: m.role, createdAt: m.created_at })),
      invites: invites.map((i): Invite => ({ id: i.id, email: i.email, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at, invitedBy: i.invited_by })),
    });
  })

  // The link is the credential: shown once, stored only as a hash, bound to one email, expires in 7 days.
  .post("/invites", async (c) => {
    need(c, "owner");
    const body = await parseBody(c, z.object({ email, role }));
    const db = c.env.DB;
    const already = await first(
      db,
      "SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.entity_id = ? AND u.email = ?",
      c.var.entity.id,
      body.email,
    );
    if (already) throw conflict(`${body.email} is already a member.`);
    const secret = randomToken();
    const id = uuidv7();
    const t = now();
    await db.batch([
      // Re-inviting replaces any pending invite for the same email.
      sql(db, "UPDATE invites SET revoked_at = ? WHERE entity_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL", t, c.var.entity.id, body.email),
      sql(
        db,
        "INSERT INTO invites (id, entity_id, email, role, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        c.var.entity.id,
        body.email,
        body.role,
        await sha256Hex(secret),
        c.var.user.id,
        t,
        t + INVITE_TTL,
      ),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "invite.create",
        targetType: "invite",
        targetId: id,
        summary: `Invited ${body.email} as ${body.role}`,
      }),
    ]);
    const url = `${new URL(c.req.url).origin}/invite/${secret}`;
    return c.json({ invite: { id, email: body.email, role: body.role, createdAt: t, expiresAt: t + INVITE_TTL, invitedBy: c.var.user.name }, url }, 201);
  })

  .delete("/invites/:inviteId", async (c) => {
    need(c, "owner");
    const db = c.env.DB;
    const invite = await first<{ email: string }>(
      db,
      "SELECT email FROM invites WHERE id = ? AND entity_id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
      c.req.param("inviteId"),
      c.var.entity.id,
    );
    if (!invite) throw notFound("Invite not found.");
    await db.batch([
      sql(db, "UPDATE invites SET revoked_at = ? WHERE id = ?", now(), c.req.param("inviteId")),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "invite.revoke",
        targetType: "invite",
        targetId: c.req.param("inviteId"),
        summary: `Revoked invite for ${invite.email}`,
      }),
    ]);
    return c.json({ ok: true });
  })

  .patch("/members/:userId", async (c) => {
    need(c, "owner");
    const body = await parseBody(c, z.object({ role }));
    const userId = c.req.param("userId");
    const member = await loadMember(c, userId);
    if (member.role === "owner" && body.role !== "owner" && (await ownerCount(c)) <= 1) {
      throw badRequest("An entity needs at least one owner. Make someone else an owner first.");
    }
    const db = c.env.DB;
    await db.batch([
      sql(db, "UPDATE memberships SET role = ? WHERE entity_id = ? AND user_id = ?", body.role, c.var.entity.id, userId),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: "member.role",
        targetType: "user",
        targetId: userId,
        summary: `Changed ${member.name} from ${member.role} to ${body.role}`,
      }),
    ]);
    return c.json({ ok: true });
  })

  .delete("/members/:userId", async (c) => {
    const userId = c.req.param("userId");
    if (userId !== c.var.user.id) need(c, "owner");
    const member = await loadMember(c, userId);
    if (member.role === "owner" && (await ownerCount(c)) <= 1) {
      throw badRequest("An entity needs at least one owner.");
    }
    const db = c.env.DB;
    await db.batch([
      sql(db, "DELETE FROM memberships WHERE entity_id = ? AND user_id = ?", c.var.entity.id, userId),
      // Removing access also ends any pending invite for the same person.
      sql(db, "UPDATE invites SET revoked_at = ? WHERE entity_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL", now(), c.var.entity.id, member.email),
      audit(db, {
        entityId: c.var.entity.id,
        actorId: c.var.user.id,
        action: userId === c.var.user.id ? "member.leave" : "member.remove",
        targetType: "user",
        targetId: userId,
        summary: userId === c.var.user.id ? `${member.name} left` : `Removed ${member.name}`,
      }),
    ]);
    return c.json({ ok: true });
  });
