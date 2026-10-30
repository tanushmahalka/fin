import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { uuidv7 } from "../shared/ids";
import type { Role } from "../shared/types";
import { randomToken, sha256Hex } from "./crypto";
import { type AppEnv, type Ctx, type EntityRow, AppError, first, forbidden, notFound, now, sql, unauthorized } from "./http";

export const SESSION_COOKIE = "fin_session";
const DAY = 86_400_000;
const SESSION_TTL = 60 * DAY; // sliding: renewed on use
const RENEW_AFTER = DAY;

export type TokenKind = "session" | "cli";

/** Creates a session or CLI token. The secret is returned once and only its hash is stored. */
export async function createToken(db: D1Database, userId: string, kind: TokenKind, name?: string, agent = false) {
  const secret = randomToken(kind === "cli" ? "fin_" : "");
  const id = uuidv7();
  const t = now();
  const stmt = sql(
    db,
    `INSERT INTO tokens (id, user_id, token_hash, kind, name, created_at, last_used_at, expires_at, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    await sha256Hex(secret),
    kind,
    name ?? null,
    t,
    t,
    kind === "session" ? t + SESSION_TTL : null,
    agent && kind === "cli" ? 1 : 0,
  );
  return { id, secret, stmt };
}

export function setSessionCookie(c: Ctx, secret: string) {
  setCookie(c, SESSION_COOKIE, secret, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
}

export function clearSessionCookie(c: Ctx) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

function readSecret(c: Ctx): { secret: string; viaCookie: boolean } | null {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return { secret: header.slice(7).trim(), viaCookie: false };
  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie ? { secret: cookie, viaCookie: true } : null;
}

/**
 * Cookie-authenticated writes must come from our own origin (CSRF defence on
 * top of SameSite=Lax). Bearer tokens are not sent automatically by browsers,
 * so they don't need the check.
 */
function sameOrigin(c: Ctx): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  return origin === new URL(c.req.url).origin;
}

interface TokenRow {
  id: string;
  kind: TokenKind;
  agent: number;
  token_name: string | null;
  expires_at: number | null;
  last_used_at: number | null;
  user_id: string;
  email: string;
  name: string;
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const found = readSecret(c);
  if (!found) throw unauthorized();
  const method = c.req.method;
  if (found.viaCookie && method !== "GET" && method !== "HEAD" && !sameOrigin(c)) {
    throw new AppError(403, "bad_origin", "Request origin not allowed.");
  }

  const row = await first<TokenRow>(
    c.env.DB,
    `SELECT t.id, t.kind, t.agent, t.name AS token_name, t.expires_at, t.last_used_at, u.id AS user_id, u.email, u.name
     FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    await sha256Hex(found.secret),
  );
  const t = now();
  if (!row || (row.expires_at !== null && row.expires_at < t)) {
    if (found.viaCookie) clearSessionCookie(c);
    throw unauthorized(row ? "Your session expired. Sign in again." : undefined);
  }

  // Touch at most daily to avoid a write per request; sessions slide forward.
  if (!row.last_used_at || t - row.last_used_at > RENEW_AFTER) {
    const expires = row.kind === "session" ? t + SESSION_TTL : null;
    c.executionCtx.waitUntil(
      sql(c.env.DB, "UPDATE tokens SET last_used_at = ?, expires_at = ? WHERE id = ?", t, expires, row.id).run(),
    );
    if (row.kind === "session" && found.viaCookie) setSessionCookie(c, found.secret);
  }

  c.set("user", { id: row.user_id, email: row.email, name: row.name });
  c.set("tokenId", row.id);
  c.set("agentName", row.agent ? (row.token_name ?? "Agent") : null);
  await next();
});

/**
 * Loads the entity named in the path and the caller's role on it. Non-members
 * get 404, not 403, so entity ids can't be probed. Viewers are denied every
 * write by default; handlers raise the bar further with need(c, role).
 */
export const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("entity")) return next();
  const entityId = c.req.param("entityId");
  if (!entityId) throw notFound("Entity not found.");
  const row = await first<EntityRow & { role: Role }>(
    c.env.DB,
    `SELECT e.id, e.name, e.kind, e.currency, e.fy_start_month, e.timezone, e.color, e.default_account_id, e.iou_account_id, m.role
     FROM entities e JOIN memberships m ON m.entity_id = e.id
     WHERE e.id = ? AND m.user_id = ?`,
    entityId,
    c.var.user.id,
  );
  if (!row) throw notFound("Entity not found.");
  const { role, ...entity } = row;
  if (role === "viewer" && c.req.method !== "GET" && c.req.method !== "HEAD") throw forbidden("Viewers can't make changes.");
  c.set("entity", entity);
  c.set("role", role);
  await next();
});
