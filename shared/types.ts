// Wire types shared by the API, the web app and the CLI. All amounts are
// integer minor units (paise); all dates are "YYYY-MM-DD".

import type { EmiProgress } from "./emi";
import type { Cadence, Charge, SubProgress } from "./subscriptions";

export type Role = "owner" | "editor" | "viewer";
export const ROLES: Role[] = ["owner", "editor", "viewer"];
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export type EntityKind = "personal" | "business";

/** Balance-sheet types (asset, liability, equity) plus the P&L types users call categories. */
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type AccountSubtype = "cash" | "bank" | "card" | "wallet" | "investment" | "loan" | "other";

/**
 * Stored kinds are expense, income, transfer, opening and adjustment. "gave" and
 * "got" are transfers with a contact through the Lent & borrowed account
 * (Khatabook's "You gave / You got"); the API reads and writes them by name.
 */
export type TxKind = "expense" | "income" | "transfer" | "gave" | "got" | "opening" | "adjustment";
export type EntryKind = "expense" | "income" | "transfer" | "gave" | "got";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  currency: string;
  fyStartMonth: number;
  timezone: string;
  color: string;
  defaultAccountId: string | null;
  /** The receivable/payable account behind "who owes whom". */
  iouAccountId: string | null;
  role: Role;
}

export interface Me {
  user: User;
  entities: Entity[];
  appName: string;
}

export interface Account {
  id: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  name: string;
  icon: string | null;
  /** What belongs here, in plain words. Shown to smart add as the option's description. */
  hint: string | null;
  parentId: string | null;
  sort: number;
  system: boolean;
  archived: boolean;
  /** Raw ledger balance: debits positive, credits negative. */
  balance: number;
  /** Postings in the last 90 days, used to put frequent categories first. */
  recentUse: number;
  /** Statement details: how an imported statement finds this account. */
  institution: string | null;
  numberLast4: string | null;
  ifsc: string | null;
  /** Balance-sheet heading, e.g. "Fixed deposits", "Property". Null = the subtype's heading. */
  groupLabel: string | null;
  /** Joint account: who else holds it. */
  jointWith: string | null;
  /** Percent of the balance that is the user's (net worth counts this share). */
  ownShare: number;
  /** Cards and credit lines: the most you can owe. Capacity, not money held. */
  creditLimit: number | null;
}

/** A purchase or loan repaid in monthly instalments, with where it stands today. */
export interface EmiPlan extends EmiProgress {
  id: string;
  /** The card or bank account the instalments are billed to or paid from. */
  accountId: string;
  /** Account holding the unpaid principal (hidden card sub-account or a loan); null = inside the card's balance. */
  balanceAccountId: string | null;
  /** What it paid for, in your words. */
  title: string;
  merchant: string | null;
  contactId: string | null;
  purchaseTxId: string | null;
  evidence: string | null;
  principal: number | null;
  instalment: number;
  months: number | null;
  firstDue: string | null;
  closed: boolean;
  createdAt: number;
}

/** A recurring charge, with what's expected and the charges that matched it. */
export interface Subscription extends SubProgress {
  id: string;
  name: string;
  contactId: string | null;
  matchText: string | null;
  amount: number;
  cadence: Cadence;
  /** Card or account it's usually charged to; falls back to the latest charge's. */
  accountId: string | null;
  /** Who it's really for when paid on someone's behalf (e.g. your company). */
  forContactId: string | null;
  note: string | null;
  cancelled: boolean;
  createdAt: number;
  /** Category of the latest charge: a subscription is Entertainment, Food, Software… */
  categoryId: string | null;
  /** Newest first, last 12 months. */
  charges: Charge[];
}

export interface Posting {
  accountId: string;
  amount: number;
  contactId?: string | null;
}

export type ContactKind = "person" | "business";

export interface Contact {
  id: string;
  name: string;
  kind: ContactKind;
  aliases: string | null;
  defaultCategoryId: string | null;
  archived: boolean;
  /** Money that left your accounts to them / arrived from them (gross, all time or as of a date). */
  sent: number;
  received: number;
  /** Lent & borrowed: positive = they owe you, negative = you owe them. */
  balance: number;
  transactions: number;
  lastDate: string | null;
  /** From your history: the category and account you usually use with them. */
  topCategoryId: string | null;
  lastAccountId: string | null;
}

export interface Share {
  contactId: string;
  amount: number;
}

/** Where a transaction's information first came from. Who entered it is createdBy / agentName. */
export type Origin = "manual" | "smart" | "statement" | "sms" | "email" | "api";
export const ORIGIN_LABEL: Record<Origin, string> = {
  manual: "Added by hand",
  smart: "Typed in plain words",
  statement: "From a statement",
  sms: "From an SMS",
  email: "From an email",
  api: "Through the API",
};

export interface Transaction {
  id: string;
  kind: TxKind;
  date: string;
  /** Positive for entries (for an expense: your share); signed for opening/adjustment. */
  amount: number;
  /** The money account: paid from (expense), paid into (income), moved from (transfer), used for gave/got. */
  accountId: string | null;
  /** Destination of a transfer. */
  toAccountId: string | null;
  categoryId: string | null;
  /** Who was on the other side: the merchant, payer, or the person in a gave/got. */
  contactId: string | null;
  /** Expense paid by this contact on your behalf: you now owe them. */
  paidBy: string | null;
  /** Expense you paid partly for someone else: they now owe you this share. */
  share: Share | null;
  note: string | null;
  origin: Origin;
  /** Every outside source that has seen it, e.g. ["statement"]. */
  sources: ("statement" | "sms" | "email")[];
  /** Confirmed by a bank or card statement. */
  reconciled: boolean;
  /** Imported with a guess a person should check. */
  needsReview: boolean;
  /** Why the agent wants the owner to look at this one; null = nothing to look at. */
  flag: string | null;
  /** Set when an agent's token created it. */
  agentName: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedAt: number | null;
  postings: Posting[];
}

export interface TransactionInput {
  /** Client-generated UUID makes retries idempotent. */
  id?: string;
  kind: EntryKind;
  date: string;
  amount: number;
  /** Required except for an expense with paidBy. */
  accountId?: string | null;
  categoryId?: string | null;
  toAccountId?: string | null;
  contactId?: string | null;
  /** Create the contact in the same write (smart add found a new name). */
  newContact?: { name: string; kind: ContactKind } | null;
  paidBy?: string | null;
  share?: Share | null;
  note?: string | null;
  /** Where the information came from (statements come only through imports). Defaults to manual. */
  origin?: Exclude<Origin, "statement">;
  /** A person confirming an imported guess clears the review flag. */
  reviewed?: boolean;
}

export interface LedgerRow extends Transaction {
  /** Effect on this account. */
  delta: number;
  running: number;
}

export interface Summary {
  from: string;
  to: string;
  income: number;
  expense: number;
  byCategory: { accountId: string; amount: number }[];
  /** Spending and income per contact (untagged entries are left out). */
  byContact: { contactId: string; expense: number; income: number }[];
  byDay: { date: string; income: number; expense: number }[];
}

export interface MonthTotal {
  month: string;
  income: number;
  expense: number;
}

export interface Budget {
  accountId: string;
  amount: number;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  createdAt: number;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
  invitedBy: string;
}

export interface ActivityItem {
  id: string;
  action: string;
  summary: string;
  actorName: string | null;
  targetType: string;
  targetId: string | null;
  createdAt: number;
}

export interface ApiToken {
  id: string;
  name: string | null;
  agent: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  current: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

// ---- Assist (Jev) ------------------------------------------------------------

export interface DraftTransaction {
  kind: EntryKind;
  amount: number | null;
  date: string;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  contactId: string | null;
  /** A name Jev found that isn't a contact yet. */
  newContact: { name: string; kind: ContactKind } | null;
  note: string | null;
}

export interface AssistWarning {
  code: "looks_personal";
  message: string;
  probability: number;
}

/** A proposed transaction. Nothing is saved until the person confirms it. */
export interface ParseResult {
  draft: DraftTransaction;
  /** 0–1 per field; fields below the bar are left empty in the draft. */
  confidence: { kind: number; amount: number; category: number; account: number; toAccount: number; contact: number };
  suggestions: { categoryIds: string[]; amounts: number[] };
  warnings: AssistWarning[];
}

export type AskIntent = "spending" | "income" | "balance" | "budget" | "transactions" | "owed" | "unknown";

export interface AskResult {
  intent: AskIntent;
  answer: string;
  period: { from: string; to: string; label: string } | null;
  categoryId: string | null;
  accountId: string | null;
  contactId: string | null;
  value: number | null;
  transactions: Transaction[];
  /** For "who owes whom": every open balance. */
  balances?: { contactId: string; balance: number }[];
  confidence: number;
}

export interface AssistResult {
  mode: "record" | "ask";
  parse?: ParseResult;
  ask?: AskResult;
  /** "jev" when the model answered; "rules" when it was unavailable and code guessed. */
  source: "jev" | "rules";
  model?: string;
  ms: number;
  usage?: { inputTokens: number; outputTokens: number };
}

// ---- Statement import ----------------------------------------------------------

export type LineAction = "duplicate" | "link" | "new" | "pending" | "reversal";

export interface PlannedLine {
  lineNo: number;
  date: string;
  /** Signed effect on the account's ledger balance. */
  amount: number;
  balance: number | null;
  description: string;
  reference: string | null;
  upiId: string | null;
  action: LineAction;
  /** link: the existing transaction. */
  transactionId?: string;
  match?: "reference" | "auto" | "jev" | "transit";
  /** transit: the parked leg this line claims. */
  transitPostingId?: string;
  /** pending: possible matches, best first. */
  candidates?: string[];
  /** Why a line is pending, in plain words. */
  reason?: string;
  /** new: what will be created. */
  proposal?: TransactionInput & { needsReview: boolean; why?: string };
}

export interface ImportPlan {
  id: string;
  status: "preview" | "committed" | "undone";
  accountId: string;
  accountName: string;
  period: { from: string; to: string };
  opening: number;
  closing: number;
  /** Ledger's own balance for the account the day before the period starts (display terms). */
  ledgerOpening: number;
  lines: PlannedLine[];
  counts: { duplicate: number; link: number; new: number; pending: number; reversal: number; review: number };
  /** Recorded in the ledger for this account and period, but not on the statement. */
  notOnStatement: string[];
  warnings: string[];
  createdAt: number;
  createdByName: string;
  agentName: string | null;
}

export interface ReviewItem {
  evidenceId: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  reason: string;
  candidates: Transaction[];
  importId: string | null;
}
