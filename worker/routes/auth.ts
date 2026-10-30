import { Hono } from "hono";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { clearSessionCookie, createToken, requireUser, SESSION_COOKIE, setSessionCookie } from "../auth";
import { DUMMY_HASH, hashPassword, randomToken, sha256Hex, verifyPassword } from "../crypto";
import { getCookie } from "hono/cookie";
import { type AppEnv, type Ctx, AppError, first, forbidden, now, parseBody, sql, unauthorized } from "../http";

const DEVICE_TTL = 10 * 60_000;

export const email = z.string().trim().toLowerCase().email("Enter a valid email.").max(254);
export const password = z.string().min(10, "Use at least 10 characters.").max(200);
export const personName = z.string().trim().min(1, "Enter your name.").max(80);

async function throttle(c: Ctx, key: string) {
  const limiter = c.env.LOGIN_LIMITER;
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw new AppError(429, "rate_limited", "Too many attempts. Wait a minute and try again.");
}

async function checkCredentials(c: Ctx, address: string, pw: string) {
  await throttle(c, `login:${address}`);
  const user = await first<{ id: string; password_hash: string }>(
    c.env.DB,
    "SELECT id, password_hash FROM users WHERE email = ?",
    address,
  );
  // Always run a hash so response time doesn't reveal whether the email exists.
  const ok = await verifyPassword(pw, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized("Email or password is incorrect.");
  return user.id;
}

export const authRoutes = new Hono<AppEnv>()
  .get("/status", async (c) => {
    const row = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM users");
    return c.json({ needsSetup: (row?.n ?? 0) === 0, appName: c.env.APP_NAME });
  })

  // First-run: creates the instance's first account. Afterwards, people join by invite only.
  .post("/setup", async (c) => {
    const body = await parseBody(c, z.object({ name: personName, email, password }));
    const owner = (c.env.OWNER_EMAIL as string).trim().toLowerCase();
    if (owner && owner !== body.email) throw forbidden("This instance is reserved for its owner's email.");
    const id = uuidv7();
    // Single statement, so two racing setups can't both win.
    const result = await sql(
      c.env.DB,
      `INSERT INTO users (id, email, name, password_hash, created_at)
       SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      id,
      body.email,
      body.name,
      await hashPassword(body.password),
      now(),
    ).run();
    if (!result.meta.changes) throw forbidden("Setup is already complete. Ask an owner for an invite.");
    const session = await createToken(c.env.DB, id, "session");
    await session.stmt.run();
    setSessionCookie(c, session.secret);
    return c.json({ ok: true }, 201);
  })

  .post("/login", async (c) => {
    const body = await parseBody(c, z.object({ email, password: z.string().min(1).max(200) }));
    const userId = await checkCredentials(c, body.email, body.password);
    const session = await createToken(c.env.DB, userId, "session");
    await session.stmt.run();
    setSessionCookie(c, session.secret);
    return c.json({ ok: true });
  })

  // CLI login: exchanges credentials for a long-lived, revocable token.
  .post("/token", async (c) => {
    const body = await parseBody(
      c,
      z.object({ email, password: z.string().min(1).max(200), name: z.string().trim().max(80).optional(), agent: z.boolean().optional() }),
    );
    const userId = await checkCredentials(c, body.email, body.password);
    const token = await createToken(c.env.DB, userId, "cli", body.name || "CLI", body.agent);
    await token.stmt.run();
    return c.json({ token: token.secret, id: token.id }, 201);
  })

  // Device login (RFC 8628 style, like `gh auth login`): the CLI asks for a
  // code, the person approves it in a browser where they're already signed in,
  // and the CLI receives a token. Passwords never pass through agents.
  .post("/device", async (c) => {
    const body = await parseBody(c, z.object({ name: z.string().trim().min(1).max(80), agent: z.boolean().optional() }));
    await throttle(c, `device:${c.req.header("cf-connecting-ip") ?? "local"}`);
    const secret = randomToken();
    const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const raw = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    const t = now();
    await sql(
      c.env.DB,
      "INSERT INTO device_logins (id, device_hash, user_code, name, agent, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
      uuidv7(),
      await sha256Hex(secret),
      userCode,
      body.name,
      body.agent ? 1 : 0,
      t,
      t + DEVICE_TTL,
    ).run();
    const origin = new URL(c.req.url).origin;
    return c.json({ deviceCode: secret, userCode, verifyUrl: `${origin}/device?code=${userCode}`, interval: 2, expiresIn: DEVICE_TTL / 1000 }, 201);
  })

  .post("/device/poll", async (c) => {
    const body = await parseBody(c, z.object({ deviceCode: z.string().min(10).max(200) }));
    const db = c.env.DB;
    const row = await first<{ id: string; status: string; user_id: string | null; name: string; agent: number; expires_at: number }>(
      db,
      "SELECT id, status, user_id, name, agent, expires_at FROM device_logins WHERE device_hash = ?",
      await sha256Hex(body.deviceCode),
    );
    if (!row) throw new AppError(404, "unknown_code", "Unknown login request. Start again with fin login.");
    if (row.expires_at < now() && row.status === "pending") return c.json({ status: "expired" });
    if (row.status === "pending" || row.status === "denied") return c.json({ status: row.status });
    if (row.status === "issued") throw new AppError(410, "used", "This login was already completed.");
    // Approved: issue the token exactly once.
    const claimed = await sql(db, "UPDATE device_logins SET status = 'issued' WHERE id = ? AND status = 'approved'", row.id).run();
    if (!claimed.meta.changes) throw new AppError(410, "used", "This login was already completed.");
    const token = await createToken(db, row.user_id!, "cli", row.name, !!row.agent);
    await token.stmt.run();
    return c.json({ status: "approved", token: token.secret });
  })

  .get("/device/:userCode", requireUser, async (c) => {
    const row = await first<{ name: string; agent: number; status: string; expires_at: number }>(
      c.env.DB,
      "SELECT name, agent, status, expires_at FROM device_logins WHERE user_code = ?",
      c.req.param("userCode").toUpperCase(),
    );
    if (!row || (row.status === "pending" && row.expires_at < now())) throw new AppError(404, "unknown_code", "That code isn't valid or has expired. Run fin login again.");
    return c.json({ name: row.name, agent: !!row.agent, status: row.status });
  })

  .post("/device/:userCode", requireUser, async (c) => {
    const body = await parseBody(c, z.object({ approve: z.boolean() }));
    const result = await sql(
      c.env.DB,
      "UPDATE device_logins SET status = ?, user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?",
      body.approve ? "approved" : "denied",
      c.var.user.id,
      c.req.param("userCode").toUpperCase(),
      now(),
    ).run();
    if (!result.meta.changes) throw new AppError(404, "unknown_code", "That code isn't valid or has expired. Run fin login again.");
    return c.json({ ok: true });
  })

  .post("/logout", requireUser, async (c) => {
    await sql(c.env.DB, "DELETE FROM tokens WHERE id = ? AND kind = 'session'", c.var.tokenId).run();
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

// Exported for invite acceptance, which may create a user and sign them in.
export async function startSession(c: Ctx, userId: string) {
  const session = await createToken(c.env.DB, userId, "session");
  await session.stmt.run();
  setSessionCookie(c, session.secret);
}

export async function currentUserId(c: Ctx): Promise<string | null> {
  const secret = getCookie(c, SESSION_COOKIE);
  if (!secret) return null;
  const row = await first<{ user_id: string; expires_at: number | null }>(
    c.env.DB,
    "SELECT user_id, expires_at FROM tokens WHERE token_hash = ?",
    await sha256Hex(secret),
  );
  if (!row || (row.expires_at !== null && row.expires_at < now())) return null;
  return row.user_id;
}
