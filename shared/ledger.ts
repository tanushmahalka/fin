// Double-entry core. Every transaction is a set of postings that sum to zero:
// money never appears or vanishes, it only moves between accounts.
//
// Sign convention (standard debit/credit):
//   debit  (+)  increases assets and expenses
//   credit (−)  increases liabilities, equity and income
//
//   ₹250 chai paid in cash        Food +250             Cash −250
//   ₹80,000 salary into bank      Bank +80,000          Salary −80,000
//   ₹5,000 card bill from bank    Card +5,000           Bank −5,000
//   Lent Rahul ₹2,000 ("gave")    Lent & borrowed +2,000 [Rahul]   Bank −2,000
//   ₹3,000 dinner, Rahul's share  Food +1,000  Lent & borrowed +2,000 [Rahul]  Card −3,000
//
// "Lent & borrowed" is one asset account per entity, split by contact: a
// positive balance with a contact means they owe you, negative means you owe them.

import type { Account, AccountType, EntryKind, Posting, Share, Transaction, TxKind } from "./types";

export const isMoneyAccount = (a: Pick<Account, "type">) => a.type === "asset" || a.type === "liability";
export const isCategory = (a: Pick<Account, "type">) => a.type === "income" || a.type === "expense";

export class LedgerError extends Error {}

type Lookup = (id: string) => Pick<Account, "id" | "type" | "archived"> | undefined;

export interface EntryInput {
  kind: EntryKind;
  amount: number;
  accountId?: string | null;
  categoryId?: string | null;
  toAccountId?: string | null;
  contactId?: string | null;
  paidBy?: string | null;
  share?: Share | null;
}

/** Turns the form people fill in into balanced postings. `iouId` is the entity's Lent & borrowed account. */
export function buildPostings(input: EntryInput, lookup: Lookup, iouId: string | null): Posting[] {
  const { kind, amount } = input;
  const contactId = input.contactId ?? null;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new LedgerError("Amount must be greater than zero.");

  const moneyAccount = (id: string | null | undefined, label = "Choose an account.") => {
    const a = id ? lookup(id) : undefined;
    if (!a || !isMoneyAccount(a) || a.id === iouId) throw new LedgerError(label);
    if (a.archived) throw new LedgerError(`That account is archived.`);
    return a;
  };
  const iou = () => {
    if (!iouId) throw new LedgerError("This entity has no Lent & borrowed account.");
    return iouId;
  };

  if (input.paidBy && kind !== "expense") throw new LedgerError("Only an expense can be paid by someone else.");
  if (input.share && kind !== "expense") throw new LedgerError("Only an expense can be split.");

  if (kind === "gave" || kind === "got") {
    if (!contactId) throw new LedgerError(`Choose who you ${kind} money ${kind === "gave" ? "to" : "from"}.`);
    const account = moneyAccount(input.accountId);
    return kind === "gave"
      ? [
          { accountId: iou(), amount, contactId },
          { accountId: account.id, amount: -amount, contactId },
        ]
      : [
          { accountId: account.id, amount, contactId },
          { accountId: iou(), amount: -amount, contactId },
        ];
  }

  if (kind === "transfer") {
    const from = moneyAccount(input.accountId);
    const to = moneyAccount(input.toAccountId, "Choose the account the money went to.");
    if (to.id === from.id) throw new LedgerError("A transfer needs two different accounts.");
    return [
      { accountId: to.id, amount, contactId },
      { accountId: from.id, amount: -amount, contactId },
    ];
  }

  const category = input.categoryId ? lookup(input.categoryId) : undefined;
  if (!category || category.type !== kind) throw new LedgerError(`Choose an ${kind} category.`);
  if (category.archived) throw new LedgerError("That category is archived.");

  if (kind === "income") {
    const account = moneyAccount(input.accountId);
    return [
      { accountId: account.id, amount, contactId },
      { accountId: category.id, amount: -amount, contactId },
    ];
  }

  // Expense: your share hits the category. Someone else's share is owed to
  // you; if someone else paid, you owe them.
  if (input.paidBy) {
    if (input.share) throw new LedgerError("An expense can be split or paid by someone else, not both.");
    return [
      { accountId: category.id, amount, contactId },
      { accountId: iou(), amount: -amount, contactId: input.paidBy },
    ];
  }
  const account = moneyAccount(input.accountId);
  const share = input.share;
  if (share) {
    if (!share.contactId) throw new LedgerError("Choose who you split with.");
    if (!Number.isSafeInteger(share.amount) || share.amount <= 0) throw new LedgerError("Their share must be greater than zero.");
    return [
      { accountId: category.id, amount, contactId },
      { accountId: iou(), amount: share.amount, contactId: share.contactId },
      { accountId: account.id, amount: -(amount + share.amount), contactId },
    ];
  }
  return [
    { accountId: category.id, amount, contactId },
    { accountId: account.id, amount: -amount, contactId },
  ];
}

export function assertBalanced(postings: Posting[]): void {
  if (postings.length < 2) throw new LedgerError("A transaction needs at least two postings.");
  const sum = postings.reduce((s, p) => s + p.amount, 0);
  if (sum !== 0) throw new LedgerError(`Postings must sum to zero (off by ${sum}).`);
}

type TypeOf = (accountId: string) => AccountType | undefined;

export type FlatView = Pick<Transaction, "kind" | "amount" | "accountId" | "toAccountId" | "categoryId" | "contactId" | "paidBy" | "share">;

/** Reads the form view (account, category, contact, split) back out of postings. */
export function flatten(stored: TxKind, postings: Posting[], typeOf: TypeOf, iouId: string | null): FlatView {
  const iou = postings.filter((p) => p.accountId === iouId);
  const money = postings.filter((p) => p.accountId !== iouId && (typeOf(p.accountId) === "asset" || typeOf(p.accountId) === "liability"));
  const pl = postings.filter((p) => typeOf(p.accountId) === "income" || typeOf(p.accountId) === "expense");
  const base: FlatView = { kind: stored, amount: 0, accountId: null, toAccountId: null, categoryId: null, contactId: null, paidBy: null, share: null };

  if (stored === "transfer" && iou.length === 1 && money.length === 1) {
    const gave = iou[0].amount > 0;
    return { ...base, kind: gave ? "gave" : "got", amount: Math.abs(iou[0].amount), accountId: money[0].accountId, contactId: iou[0].contactId ?? null };
  }
  if (stored === "transfer") {
    const from = money.find((p) => p.amount < 0);
    const to = money.find((p) => p.amount > 0);
    return { ...base, amount: to?.amount ?? 0, accountId: from?.accountId ?? null, toAccountId: to?.accountId ?? null, contactId: from?.contactId ?? null };
  }
  if (stored === "expense" || stored === "income") {
    const total = pl.reduce((s, p) => s + p.amount, 0);
    const view: FlatView = {
      ...base,
      amount: stored === "expense" ? total : -total,
      categoryId: pl[0]?.accountId ?? null,
      contactId: pl[0]?.contactId ?? null,
      accountId: money[0]?.accountId ?? null,
    };
    if (stored === "expense" && !money.length && iou.length) view.paidBy = iou[0].contactId ?? null;
    const owed = iou.find((p) => p.amount > 0);
    if (stored === "expense" && money.length && owed?.contactId) view.share = { contactId: owed.contactId, amount: owed.amount };
    return view;
  }
  // opening / adjustment: signed effect on the money account, or an opening
  // "who owes whom" balance with a contact
  if (!money.length && iou.length) return { ...base, amount: iou[0].amount, contactId: iou[0].contactId ?? null };
  return { ...base, amount: money[0]?.amount ?? 0, accountId: money[0]?.accountId ?? null };
}

/**
 * What a person expects to see as an account's balance: assets as money held,
 * liabilities as money owed (positive), categories as totals.
 */
export function displayBalance(type: AccountType, raw: number): number {
  return type === "asset" || type === "expense" ? raw : -raw;
}

/** Postings that move an account from its current balance to `target` (both in display terms). */
export function adjustmentPostings(
  account: Pick<Account, "id" | "type" | "balance">,
  targetDisplay: number,
  equityId: string,
): Posting[] {
  const targetRaw = account.type === "liability" ? -targetDisplay : targetDisplay;
  const delta = targetRaw - account.balance;
  if (delta === 0) return [];
  return [
    { accountId: account.id, amount: delta },
    { accountId: equityId, amount: -delta },
  ];
}

/** Stored kind for an entry: gave/got are transfers through Lent & borrowed. */
export const storedKind = (kind: EntryKind): "expense" | "income" | "transfer" => (kind === "gave" || kind === "got" ? "transfer" : kind);
