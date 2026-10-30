import { Hono } from "hono";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import type { Role } from "../../shared/types";
import { audit } from "../audit";
import { hashPassword, sha256Hex } from "../crypto";
import { type AppEnv, type Ctx, AppError, first, forbidden, notFound, now, parseBody, sql, unauthorized } from "../http";
import { currentUserId, password, personName, startSession } from "./auth";

interface InviteRow {
  id: string;
  entity_id: string;
  entity_name: string;
  email: string;
  role: Role;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
  invited_by: string;
}

async function loadInvite(c: Ctx): Promise<InviteRow> {
  const row = await first<InviteRow>(
    c.env.DB,
    `SELECT i.id, i.entity_id, e.name AS entity_name, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, u.name AS invited_by
     FROM invites i JOIN entities e ON e.id = i.entity_id JOIN users u ON u.id = i.created_by
     WHERE i.token_hash = ?`,
    await sha256Hex(c.req.param("token") ?? ""),
  );
  if (!row || row.revoked_at) throw notFound("This invite link isn't valid. Ask for a new one.");
  if (row.accepted_at) throw new AppError(410, "invite_used", "This invite has already been used. Sign in instead.");
  if (row.expires_at < now()) throw new AppError(410, "invite_expired", "This invite has expired. Ask for a new one.");
  return row;
}

export const inviteRoutes = new Hono<AppEnv>()
  .get("/:token", async (c) => {
    const invite = await loadInvite(c);
    const userExists = !!(await first(c.env.DB, "SELECT 1 FROM users WHERE email = ?", invite.email));
    const signedInAs = await currentUserId(c);
    const signedInEmail = signedInAs
      ? (await first<{ email: string }>(c.env.DB, "SELECT email FROM users WHERE id = ?", signedInAs))?.email ?? null
      : null;
    return c.json({
      entityName: invite.entity_name,
      email: invite.email,
      role: invite.role,
      invitedBy: invite.invited_by,
      userExists,
      signedInEmail,
    });
  })

  // Accept as the signed-in user (emails must match) or create an account for the invited email.
  .post("/:token/accept", async (c) => {
    // Same CSRF rule as every other cookie-authenticated write.
    if (c.req.header("origin") !== new URL(c.req.url).origin) throw new AppError(403, "bad_origin", "Request origin not allowed.");
    const invite = await loadInvite(c);
    const db = c.env.DB;
    let userId = await currentUserId(c);
    const stmts: D1PreparedStatement[] = [];

    if (userId) {
      const me = await first<{ email: string }>(db, "SELECT email FROM users WHERE id = ?", userId);
      if (me?.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw forbidden(`This invite is for ${invite.email}. Sign out and open the link again.`);
      }
    } else {
      const existing = await first<{ id: string }>(db, "SELECT id FROM users WHERE email = ?", invite.email);
      if (existing) throw unauthorized(`Sign in as ${invite.email} to accept this invite.`);
      const body = await parseBody(c, z.object({ name: personName, password }));
      userId = uuidv7();
      stmts.push(
        sql(
          db,
          "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
          userId,
          invite.email,
          body.name,
          await hashPassword(body.password),
          now(),
        ),
      );
    }

    const t = now();
    await db.batch([
      ...stmts,
      sql(
        db,
        `INSERT INTO memberships (entity_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (entity_id, user_id) DO NOTHING`,
        invite.entity_id,
        userId,
        invite.role,
        t,
      ),
      sql(db, "UPDATE invites SET accepted_at = ? WHERE id = ?", t, invite.id),
      audit(db, {
        entityId: invite.entity_id,
        actorId: userId,
        action: "invite.accept",
        targetType: "invite",
        targetId: invite.id,
        summary: `${invite.email} joined as ${invite.role}`,
      }),
    ]);
    if (stmts.length) await startSession(c, userId);
    return c.json({ entityId: invite.entity_id });
  });
