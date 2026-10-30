import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { Role } from "../shared/types";
import { ROLE_RANK } from "../shared/types";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export interface EntityRow {
  id: string;
  name: string;
  kind: "personal" | "business";
  currency: string;
  fy_start_month: number;
  timezone: string;
  color: string;
  default_account_id: string | null;
  iou_account_id: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SessionUser;
    tokenId: string;
    /** The token's name when an agent is calling, e.g. "Kaira". */
    agentName: string | null;
    entity: EntityRow;
    role: Role;
  };
};

export type Ctx = Context<AppEnv>;

export class AppError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "invalid_request") => new AppError(400, code, message);
export const unauthorized = (message = "Sign in to continue.") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You don't have permission to do that.") => new AppError(403, "forbidden", message);
export const notFound = (what = "Not found") => new AppError(404, "not_found", what);
export const conflict = (message: string) => new AppError(409, "conflict", message);

export async function parseBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw badRequest(message);
  }
  return result.data;
}

/** Throws unless the caller's role on the current entity is at least `min`. */
export function need(c: Ctx, min: Role): void {
  if (ROLE_RANK[c.var.role] < ROLE_RANK[min]) {
    throw forbidden(min === "owner" ? "Only owners can do that." : "Viewers can't make changes.");
  }
}

// Thin D1 helpers. D1 rejects `undefined` bindings, so normalise to null.
const clean = (params: unknown[]) => params.map((p) => (p === undefined ? null : p));

export function sql(db: D1Database, query: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(query).bind(...clean(params));
}

export async function all<T>(db: D1Database, query: string, ...params: unknown[]): Promise<T[]> {
  return (await sql(db, query, ...params).all<T>()).results;
}

export async function first<T>(db: D1Database, query: string, ...params: unknown[]): Promise<T | null> {
  return sql(db, query, ...params).first<T>();
}

export const now = () => Date.now();
