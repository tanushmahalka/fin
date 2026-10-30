import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { passedAccess } from "./access";
import { AppError, type AppEnv } from "./http";
import { authRoutes } from "./routes/auth";
import { entityRoutes } from "./routes/entities";
import { inviteRoutes } from "./routes/invites";
import { meRoutes } from "./routes/me";

const api = new Hono<AppEnv>()
  .basePath("/api")
  .use(secureHeaders())
  .use(async (c, next) => {
    await next();
    // Financial data must never sit in a shared cache.
    if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
  })
  .route("/auth", authRoutes)
  .route("/me", meRoutes)
  .route("/entities", entityRoutes)
  .route("/invites", inviteRoutes)
  .notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404))
  .onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    console.error(err);
    return c.json({ error: { code: "internal", message: "Something went wrong. Try again." } }, 500);
  });

export default {
  async fetch(request, env, ctx) {
    const vars = env as unknown as { ACCESS_AUD?: string; ACCESS_TEAM_DOMAIN?: string };
    if (vars.ACCESS_AUD && vars.ACCESS_TEAM_DOMAIN && !(await passedAccess(request, vars.ACCESS_AUD, vars.ACCESS_TEAM_DOMAIN)))
      return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return api.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
