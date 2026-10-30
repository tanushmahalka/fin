// Row → wire mappers and loaders shared by the route modules.

import { addDays, today } from "../shared/dates";
import { flatten } from "../shared/ledger";
import type { Account, AccountType, Contact, ContactKind, Entity, Origin, Posting, Role, Transaction, TxKind } from "../shared/types";
import { type EntityRow, all, first } from "./http";

export function entityView(e: EntityRow, role: Role): Entity {
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    currency: e.currency,
    fyStartMonth: e.fy_start_month,
    timezone: e.timezone,
    color: e.color,
    defaultAccountId: e.default_account_id,
    iouAccountId: e.iou_account_id,
    role,
  };
}

interface AccountRow {
  id: string;
  type: AccountType;
  subtype: Account["subtype"];
  name: string;
  icon: string | null;
  hint: string | null;
  parent_id: string | null;
  sort: number;
  system: number;
  archived_at: number | null;
  balance: number | null;
  recent: number | null;
  institution: string | null;
  number_last4: string | null;
  ifsc: string | null;
  group_label: string | null;
  joint_with: string | null;
  own_share: number;
  credit_limit: number | null;
}

const FAR_FUTURE = "9999-12-31";

/** Every account in the entity with its ledger balance, optionally as of a date (deleted transactions excluded). */
export async function loadAccounts(db: D1Database, entity: EntityRow, asOf = FAR_FUTURE): Promise<Account[]> {
  const since = addDays(today(entity.timezone), -90);
  const rows = await all<AccountRow>(
    db,
    `SELECT a.id, a.type, a.subtype, a.name, a.icon, a.hint, a.parent_id, a.sort, a.system, a.archived_at,
            a.institution, a.number_last4, a.ifsc, a.group_label, a.joint_with, a.own_share, a.credit_limit, b.balance, b.recent
     FROM accounts a
     LEFT JOIN (
       SELECT p.account_id, SUM(p.amount) AS balance, SUM(t.date >= ?) AS recent
       FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE p.entity_id = ? AND t.deleted_at IS NULL AND t.date <= ?
       GROUP BY p.account_id
     ) b ON b.account_id = a.id
     WHERE a.entity_id = ?
     ORDER BY a.sort, a.created_at`,
    since,
    entity.id,
    asOf,
    entity.id,
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    subtype: r.subtype,
    name: r.name,
    icon: r.icon,
    hint: r.hint,
    parentId: r.parent_id,
    sort: r.sort,
    system: !!r.system,
    archived: r.archived_at !== null,
    balance: r.balance ?? 0,
    recentUse: r.recent ?? 0,
    institution: r.institution,
    numberLast4: r.number_last4,
    ifsc: r.ifsc,
    groupLabel: r.group_label,
    jointWith: r.joint_with,
    ownShare: r.own_share,
    creditLimit: r.credit_limit,
  }));
}

export type AccountInfo = Map<string, Pick<Account, "id" | "type" | "archived" | "name">>;

export async function loadAccountTypes(db: D1Database, entityId: string): Promise<AccountInfo> {
  const rows = await all<{ id: string; type: AccountType; archived_at: number | null; name: string }>(
    db,
    "SELECT id, type, archived_at, name FROM accounts WHERE entity_id = ?",
    entityId,
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, type: r.type, archived: r.archived_at !== null, name: r.name }]));
}

interface ContactRow {
  id: string;
  name: string;
  kind: ContactKind;
  aliases: string | null;
  default_category_id: string | null;
  archived_at: number | null;
}

/**
 * Contacts with what has flowed between you: money sent and received through
 * your accounts, the Lent & borrowed balance, and the category/account you
 * usually use with them (so picking a contact can fill the rest of the form).
 */
export async function loadContacts(db: D1Database, entity: EntityRow, asOf = FAR_FUTURE): Promise<Contact[]> {
  const [contacts, flows] = await Promise.all([
    all<ContactRow>(db, "SELECT id, name, kind, aliases, default_category_id, archived_at FROM contacts WHERE entity_id = ? ORDER BY name COLLATE NOCASE", entity.id),
    all<{ contact_id: string; account_id: string; type: AccountType; pos: number; neg: number; n: number; last: string }>(
      db,
      `SELECT p.contact_id, p.account_id, a.type,
              SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END) AS pos,
              SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END) AS neg,
              COUNT(*) AS n, MAX(t.date || ' ' || t.created_at) AS last
       FROM postings p JOIN transactions t ON t.id = p.transaction_id JOIN accounts a ON a.id = p.account_id
       WHERE p.entity_id = ? AND p.contact_id IS NOT NULL AND t.deleted_at IS NULL AND t.date <= ?
       GROUP BY p.contact_id, p.account_id`,
      entity.id,
      asOf,
    ),
  ]);
  const txCount = await all<{ contact_id: string; n: number; last: string }>(
    db,
    `SELECT p.contact_id, COUNT(DISTINCT t.id) AS n, MAX(t.date) AS last
     FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.entity_id = ? AND p.contact_id IS NOT NULL AND t.deleted_at IS NULL AND t.date <= ?
     GROUP BY p.contact_id`,
    entity.id,
    asOf,
  );
  const counts = new Map(txCount.map((r) => [r.contact_id, r]));
  const byContact = new Map<string, typeof flows>();
  for (const f of flows) byContact.set(f.contact_id, [...(byContact.get(f.contact_id) ?? []), f]);

  return contacts.map((c) => {
    let sent = 0;
    let received = 0;
    let balance = 0;
    let topCategory: { id: string; n: number } | null = null;
    let lastAccount: { id: string; last: string } | null = null;
    for (const f of byContact.get(c.id) ?? []) {
      if (f.account_id === entity.iou_account_id) {
        balance += f.pos - f.neg;
      } else if (f.type === "asset" || f.type === "liability") {
        sent += f.neg;
        received += f.pos;
        if (!lastAccount || f.last > lastAccount.last) lastAccount = { id: f.account_id, last: f.last };
      } else if ((f.type === "expense" || f.type === "income") && (!topCategory || f.n > topCategory.n)) {
        topCategory = { id: f.account_id, n: f.n };
      }
    }
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      aliases: c.aliases,
      defaultCategoryId: c.default_category_id,
      archived: c.archived_at !== null,
      sent,
      received,
      balance,
      transactions: counts.get(c.id)?.n ?? 0,
      lastDate: counts.get(c.id)?.last ?? null,
      topCategoryId: c.default_category_id ?? topCategory?.id ?? null,
      lastAccountId: lastAccount?.id ?? null,
    };
  });
}

export interface TxRow {
  id: string;
  kind: TxKind;
  date: string;
  note: string | null;
  created_by: string;
  created_by_name: string;
  created_at: number;
  updated_at: number | null;
  origin: Origin;
  needs_review: number;
  flag: string | null;
  agent_name: string | null;
  sources: string | null; // comma-separated evidence sources
  postings: string; // JSON array
}

export const TX_SELECT = `
  SELECT t.id, t.kind, t.date, t.note, t.created_by, u.name AS created_by_name, t.created_at, t.updated_at,
         t.origin, t.needs_review, t.flag, t.agent_name,
         (SELECT group_concat(DISTINCT e.source) FROM evidence e WHERE e.transaction_id = t.id AND e.status = 'linked') AS sources,
         (SELECT json_group_array(json_object('accountId', p.account_id, 'amount', p.amount, 'contactId', p.contact_id))
          FROM postings p WHERE p.transaction_id = t.id) AS postings
  FROM transactions t JOIN users u ON u.id = t.created_by`;

export function txView(row: TxRow, types: Map<string, { type: AccountType }>, iouId: string | null): Transaction {
  const postings = JSON.parse(row.postings) as Posting[];
  return {
    id: row.id,
    date: row.date,
    ...flatten(row.kind, postings, (id) => types.get(id)?.type, iouId),
    note: row.note,
    origin: row.origin,
    sources: (row.sources ? row.sources.split(",") : []) as Transaction["sources"],
    reconciled: !!row.sources?.includes("statement"),
    needsReview: !!row.needs_review,
    flag: row.flag,
    agentName: row.agent_name,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    postings,
  };
}

export async function loadTransaction(db: D1Database, entity: EntityRow, id: string, includeDeleted = false) {
  const row = await first<TxRow>(
    db,
    `${TX_SELECT} WHERE t.entity_id = ? AND t.id = ? ${includeDeleted ? "" : "AND t.deleted_at IS NULL"}`,
    entity.id,
    id,
  );
  if (!row) return null;
  return txView(row, await loadAccountTypes(db, entity.id), entity.iou_account_id);
}
