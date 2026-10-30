import { uuidv7 } from "../shared/ids";
import { now, sql } from "./http";

export interface AuditEvent {
  entityId: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Returns the INSERT so callers put it in the same D1 batch as the change it
 * describes: either both are committed or neither is.
 */
export function audit(db: D1Database, e: AuditEvent): D1PreparedStatement {
  return sql(
    db,
    `INSERT INTO audit_log (id, entity_id, actor_id, action, target_type, target_id, summary, before, after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uuidv7(),
    e.entityId,
    e.actorId,
    e.action,
    e.targetType,
    e.targetId ?? null,
    e.summary,
    e.before === undefined ? null : JSON.stringify(e.before),
    e.after === undefined ? null : JSON.stringify(e.after),
    now(),
  );
}
