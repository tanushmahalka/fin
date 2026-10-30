import { Archive, ArrowLeft, Check, ChevronRight, Landmark, Pencil, Plus, Scale, Star, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { addDays, fiscalYear, monthName, relativeDay, today } from "../../shared/dates";
import { displayBalance } from "../../shared/ledger";
import { currencySymbol, formatMoney, parseAmount, toInput } from "../../shared/money";
import type { Account, AccountSubtype } from "../../shared/types";
import { ApiError, useAccounts, useContacts, useEmis, useEntityMutation, useInfiniteLedger } from "../api";
import { LoadMore } from "../components/LoadMore";
import { ContactChip } from "../components/ContactPicker";
import { TxRow } from "../components/TxRow";
import { Empty, Money, Sheet, Skeleton, Tile, useToast } from "../components/ui";
import { useActions, useEntity } from "../state";

// A kind = subtype + an optional balance-sheet group (fixed deposits and
// property are investments/other assets with their own heading).
const KINDS: { key: string; subtype: AccountSubtype; type: "asset" | "liability"; label: string; group: string; groupLabel?: string; icon: string }[] = [
  { key: "cash", subtype: "cash", type: "asset", label: "Cash", group: "Cash", icon: "💵" },
  { key: "bank", subtype: "bank", type: "asset", label: "Bank", group: "Bank accounts", icon: "🏦" },
  { key: "wallet", subtype: "wallet", type: "asset", label: "Wallet", group: "Wallets", icon: "📱" },
  { key: "card", subtype: "card", type: "liability", label: "Credit card", group: "Cards", icon: "💳" },
  { key: "investment", subtype: "investment", type: "asset", label: "Investment", group: "Investments", icon: "📈" },
  { key: "deposit", subtype: "investment", type: "asset", label: "Fixed deposit", group: "Fixed deposits", groupLabel: "Fixed deposits", icon: "🔒" },
  { key: "property", subtype: "other", type: "asset", label: "Property", group: "Property", groupLabel: "Property", icon: "🏠" },
  { key: "loan", subtype: "loan", type: "liability", label: "Loan", group: "Loans", icon: "🏛️" },
  { key: "other", subtype: "other", type: "asset", label: "Other", group: "Other", icon: "◻️" },
];
const ASSET_ORDER = ["Cash", "Bank accounts", "Wallets", "Investments", "Fixed deposits", "Property", "Other"];
const LIABILITY_ORDER = ["Cards", "Loans", "Other"];

/** The heading an account sits under on the balance sheet. */
export function groupOf(a: Pick<Account, "type" | "subtype" | "groupLabel">): string {
  if (a.groupLabel) return a.groupLabel;
  const k = KINDS.find((x) => x.subtype === (a.subtype ?? "other") && !x.groupLabel && (x.type === a.type || x.subtype === "other"));
  if (a.type === "liability" && a.subtype !== "card" && a.subtype !== "loan") return "Other";
  return k?.group ?? "Other";
}

/** Your share of an account's balance (joint accounts count only your part). */
const mine = (a: Pick<Account, "balance" | "ownShare">) => Math.round((a.balance * (a.ownShare ?? 100)) / 100);

function kindOf(a: Pick<Account, "subtype" | "groupLabel" | "type">) {
  return KINDS.find((k) => k.groupLabel && k.groupLabel === a.groupLabel) ?? KINDS.find((k) => k.subtype === a.subtype && !k.groupLabel) ?? KINDS[1];
}

export function AccountsPage() {
  const { entity, canEdit } = useEntity();
  const [adding, setAdding] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [asOf, setAsOf] = useState<string | null>(null);
  const accountsQ = useAccounts(entity.id, asOf ?? undefined);
  const contactsQ = useContacts(entity.id, asOf ?? undefined);
  const emisQ = useEmis(entity.id, asOf ?? undefined);
  const fyEnd = fiscalYear(addDays(fiscalYear(today(), entity.fyStartMonth).from, -1), entity.fyStartMonth).to;
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });

  const isTransit = (a: Account) => a.system && a.groupLabel === "Transfers in transit";
  // The in-transit clearing account shows only while something is waiting to be matched.
  const money = (accountsQ.data ?? []).filter((a) => (a.type === "asset" || a.type === "liability") && (!a.system || (isTransit(a) && a.balance !== 0)));
  // Archived accounts drop out unless they still hold money on the chosen date.
  const live = money.filter((a) => !a.archived || a.balance !== 0);
  const archived = money.filter((a) => a.archived && a.balance === 0 && !a.parentId);
  // EMI sub-accounts fold into their card: one line per card, never their own row.
  const childBalance = (id: string) => live.filter((a) => a.parentId === id).reduce((s, a) => s + a.balance, 0);
  const listed = live.filter((a) => !a.parentId).map((a) => ({ ...a, balance: a.balance + childBalance(a.id) }));
  const plans = (emisQ.data ?? []).filter((p) => !p.done);
  // Principal still owed on EMIs billed to this card: in its sub-accounts, or inside its own balance (SBI).
  const onEmi = (id: string) =>
    plans
      .filter((p) => p.accountId === id && (p.balanceAccountId === null || live.some((a) => a.id === p.balanceAccountId && a.parentId === id)))
      .reduce((s, p) => s + p.left, 0);
  const contacts = contactsQ.data ?? [];
  const owedToYou = contacts.filter((c) => c.balance > 0).sort((a, b) => b.balance - a.balance);
  const youOwe = contacts.filter((c) => c.balance < 0).sort((a, b) => a.balance - b.balance);
  const receivable = owedToYou.reduce((s, c) => s + c.balance, 0);
  const payable = -youOwe.reduce((s, c) => s + c.balance, 0);
  const assets = live.filter((a) => a.type === "asset").reduce((s, a) => s + mine(a), 0) + receivable;
  const liabilities = live.filter((a) => a.type === "liability").reduce((s, a) => s - mine(a), 0) + payable;
  const liquid = live.filter((a) => a.subtype === "cash" || a.subtype === "bank" || a.subtype === "wallet").reduce((s, a) => s + mine(a), 0);
  // Borrowing capacity on cards: limit, used, available. Never part of net worth.
  const cards = listed.filter((a) => a.type === "liability" && a.creditLimit);
  const creditLimit = cards.reduce((s, a) => s + a.creditLimit!, 0);
  const creditUsed = cards.reduce((s, a) => s + Math.max(0, -a.balance), 0);
  const utilisation = creditLimit ? creditUsed / creditLimit : 0;
  const cardsWithoutLimit = live.filter((a) => a.type === "liability" && a.subtype === "card" && !a.creditLimit).length;
  const headings = (type: "asset" | "liability") => {
    const order = type === "asset" ? ASSET_ORDER : LIABILITY_ORDER;
    const present = [...new Set(listed.filter((a) => a.type === type).map(groupOf))];
    return [...order.filter((g) => present.includes(g)), ...present.filter((g) => !order.includes(g)).sort()];
  };

  const group = (type: "asset" | "liability", heading: string) => {
    const items = listed.filter((a) => a.type === type && groupOf(a) === heading);
    if (!items.length) return null;
    const sum = items.reduce((s, a) => s + displayBalance(a.type, mine(a)), 0);
    return (
      <section key={type + heading} className="bs-group">
        <div className="section-head">
          <h3 className="h3">{heading}</h3>
          <div className="spacer" />
          <span className="num muted" style={{ fontSize: 13, fontWeight: 500 }}>
            {fmt(sum)}
          </span>
        </div>
        <div className="card list">
          {items.map((a) => (
            <AccountRow key={a.id} account={a} emi={onEmi(a.id)} />
          ))}
        </div>
      </section>
    );
  };

  const people = (title: string, list: typeof contacts, total: number, tone: "income" | "expense") =>
    list.length > 0 && (
      <section className="bs-group">
        <div className="section-head">
          <h3 className="h3">{title}</h3>
          <div className="spacer" />
          <span className={`num ${tone}`} style={{ fontSize: 13, fontWeight: 500 }}>
            {fmt(total)}
          </span>
        </div>
        <div className="card list">
          {list.map((c) => (
            <Link key={c.id} to={`../contacts/${c.id}`} className="row">
              <ContactChip contact={c} size={36} />
              <div className="row-main">
                <span className="row-title">{c.name}</span>
                <span className="row-sub">{c.lastDate ? `Updated ${relativeDay(c.lastDate)}` : "\u00a0"}</span>
              </div>
              <div className={`row-amount num ${tone}`}>{fmt(Math.abs(c.balance))}</div>
              <ChevronRight size={16} className="faint" />
            </Link>
          ))}
        </div>
      </section>
    );

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="h1">Balance sheet</h1>
        <div className="spacer" />
        {canEdit && (
          <button className="btn btn-secondary" onClick={() => setAdding("bank")}>
            <Plus /> Add account
          </button>
        )}
      </div>

      <div className="chips" style={{ marginBottom: 14 }}>
        <button className="chip" aria-pressed={!asOf} onClick={() => setAsOf(null)}>
          Today
        </button>
        <button className="chip" aria-pressed={asOf === fyEnd} onClick={() => setAsOf(fyEnd)}>
          {Number(fyEnd.slice(8))} {monthName(fyEnd.slice(0, 7), true)} {fyEnd.slice(0, 4)}
        </button>
        <input
          type="date"
          className="chip"
          aria-label="Balance sheet as of"
          aria-pressed={!!asOf && asOf !== fyEnd}
          value={asOf ?? today()}
          max={today()}
          onChange={(e) => setAsOf(e.target.value && e.target.value !== today() ? e.target.value : null)}
          style={{ paddingRight: 8 }}
        />
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 14 }}>
          <span className="eyebrow">
            {entity.kind === "business" ? "Net position" : "Net worth"}
            {asOf ? ` on ${Number(asOf.slice(8))} ${monthName(asOf.slice(0, 7), true)} ${asOf.slice(0, 4)}` : ""}
          </span>
          <div className="big-number num" style={{ marginTop: 4 }}>
            {fmt(assets - liabilities)}
          </div>
          <div className="muted num" style={{ fontSize: 13, marginTop: 6 }}>
            {fmt(liquid)} in cash and bank
          </div>
        </div>
        <div className="stats" style={{ gridTemplateColumns: "1fr 1fr", borderTop: "1px solid var(--line)" }}>
          <div className="stat">
            <span className="eyebrow">What you own</span>
            <Money className="stat-value" value={assets} currency={entity.currency} tone="income" />
          </div>
          <div className="stat">
            <span className="eyebrow">What you owe</span>
            <Money className="stat-value" value={liabilities} currency={entity.currency} tone={liabilities ? "expense" : undefined} />
          </div>
        </div>
      </div>

      {(cards.length > 0 || cardsWithoutLimit > 0) && (
        <div className="card card-pad" style={{ marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span className="eyebrow">Credit available on cards</span>
            <div style={{ flex: 1 }} />
            {creditLimit > 0 && (
              <span className={`num ${utilisation > 0.3 ? "expense" : "muted"}`} style={{ fontSize: 12.5, fontWeight: 500 }}>
                {Math.round(utilisation * 100)}% used
              </span>
            )}
          </div>
          <div className="big-number num" style={{ marginTop: 4, fontSize: 26 }}>
            {fmt(Math.max(0, creditLimit - creditUsed))}
          </div>
          {creditLimit > 0 && (
            <>
              <div className={`bar ${utilisation > 1 ? "over" : ""}`} style={{ marginTop: 12 }}>
                <i style={{ width: `${Math.min(100, utilisation * 100)}%`, background: utilisation > 0.3 ? "var(--warn)" : undefined }} />
              </div>
              <div className="muted num" style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginTop: 8 }}>
                <span>{fmt(creditUsed)} used</span>
                <span>of {fmt(creditLimit)} total limit</span>
              </div>
            </>
          )}
          <p className="faint" style={{ fontSize: 12.5, margin: "10px 0 0" }}>
            What you could still borrow, not money you have. Keeping use under 30% of the limit helps your credit score.
            {cardsWithoutLimit > 0 && ` ${cardsWithoutLimit} card${cardsWithoutLimit === 1 ? " has" : "s have"} no limit set yet.`}
          </p>
        </div>
      )}

      {plans.length > 0 && !asOf && (
        <Link to="../emis" className="card card-pad" style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, display: "grid", gap: 4 }}>
            <span className="eyebrow">EMIs</span>
            <span className="num" style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>
              {fmt(plans.reduce((s, p) => s + p.instalment, 0))} a month
            </span>
            <span className="muted num" style={{ fontSize: 12.5 }}>
              {plans.length} running · {fmt(plans.reduce((s, p) => s + p.toPay, 0))} still to pay
            </span>
          </div>
          <ChevronRight size={16} className="faint" />
        </Link>
      )}

      <div className="bs-grid">
        <div>
          <div className="bs-col-head">
            <h2 className="h2">Assets</h2>
            <span className="num">{fmt(assets)}</span>
          </div>
          {headings("asset").map((h) => group("asset", h))}
          {people("Owed to you", owedToYou, receivable, "income")}
          {!live.some((a) => a.type === "asset") && !owedToYou.length && (
            <div className="card">
              <Empty icon={<Wallet />} title="No assets yet" />
            </div>
          )}
        </div>
        <div>
          <div className="bs-col-head">
            <h2 className="h2">Liabilities</h2>
            <span className="num">{fmt(liabilities)}</span>
          </div>
          {headings("liability").map((h) => group("liability", h))}
          {people("You owe", youOwe, payable, "expense")}
          {!live.some((a) => a.type === "liability") && !youOwe.length && (
            <div className="card">
              <Empty icon={<Landmark />} title="Nothing owed">
                Add your credit cards and loans to see what you really own.
              </Empty>
            </div>
          )}
          {canEdit && (
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setAdding("loan")}>
                <Plus /> Add a loan
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setAdding("card")}>
                <Plus /> Add a card
              </button>
            </div>
          )}
        </div>
      </div>

      {archived.length > 0 && (
        <section className="section">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowArchived((s) => !s)}>
            <Archive /> {showArchived ? "Hide" : "Show"} archived ({archived.length})
          </button>
          {showArchived && (
            <div className="card list" style={{ marginTop: 8, opacity: 0.7 }}>
              {archived.map((a) => (
                <AccountRow key={a.id} account={a} />
              ))}
            </div>
          )}
        </section>
      )}

      <AccountSheet open={adding !== null} onClose={() => setAdding(null)} preset={adding ?? undefined} />
    </main>
  );
}

function sub(account: Account, isDefault: boolean) {
  if (account.system && account.groupLabel === "Transfers in transit") return "Left one of your accounts, waiting for the other statement";
  const label = account.type === "liability" ? "Owed" : kindOf(account).label;
  const joint = account.jointWith ? `Joint with ${account.jointWith}${account.ownShare !== 100 ? ` · yours ${account.ownShare}%` : ""}` : null;
  const limit = account.creditLimit
    ? `${formatMoney(Math.max(0, account.creditLimit + account.balance), { compact: true })} available of ${formatMoney(account.creditLimit, { compact: true })}`
    : null;
  return [limit ?? (label !== account.name ? label : null), joint, isDefault ? "Default" : null].filter(Boolean).join(" · ") || "\u00a0";
}

function AccountRow({ account, emi = 0 }: { account: Account; emi?: number }) {
  const { entity } = useEntity();
  const balance = displayBalance(account.type, account.balance);
  const subText = sub(account, entity.defaultAccountId === account.id);
  const emiText = emi > 0 ? `incl. ${formatMoney(emi, { compact: true, currency: entity.currency })} on EMI` : null;
  return (
    <Link to={account.id} className="row">
      <Tile icon={account.icon} />
      <div className="row-main">
        <span className="row-title">{account.name}</span>
        <span className="row-sub">{emiText ? [emiText, subText.trim()].filter(Boolean).join(" · ") : subText}</span>
      </div>
      <div className={`row-amount num ${account.type === "liability" && balance > 0 ? "expense" : ""}`}>{formatMoney(balance, { currency: entity.currency })}</div>
      <ChevronRight size={16} className="faint" />
    </Link>
  );
}

function AccountSheet({ open, onClose, account, preset }: { open: boolean; onClose: () => void; account?: Account; preset?: string }) {
  const { entity } = useEntity();
  const toast = useToast();
  const create = useEntityMutation<Record<string, unknown>, { account: Account }>(entity.id, "/accounts");
  const update = useEntityMutation<Record<string, unknown>, { account: Account }>(entity.id, `/accounts/${account?.id}`, "PATCH");
  const [kind, setKind] = useState(KINDS[1]);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🏦");
  const [balance, setBalance] = useState("");
  const [bank, setBank] = useState("");
  const [last4, setLast4] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [jointWith, setJointWith] = useState("");
  const [share, setShare] = useState("100");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const k = account ? kindOf(account) : (KINDS.find((x) => x.key === preset) ?? KINDS[1]);
    setKind(k);
    setName(account?.name ?? "");
    setIcon(account?.icon ?? k.icon);
    setBalance("");
    setBank(account?.institution ?? "");
    setLast4(account?.numberLast4 ?? "");
    setIfsc(account?.ifsc ?? "");
    setJointWith(account?.jointWith ?? "");
    setShare(String(account?.ownShare ?? 100));
    setLimit(account?.creditLimit ? toInput(account.creditLimit) : "");
    setError(null);
  }, [open, account, preset]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const opening = balance ? parseAmount(balance) : 0;
    if (opening === null) return setError("Opening balance isn't a number.");
    try {
      const ownShare = Math.max(0, Math.min(100, Math.round(Number(share) || 0)));
      const parsedLimit = limit.trim() ? parseAmount(limit) : null;
      if (limit.trim() && parsedLimit === null) return setError("Credit limit isn't a number.");
      const details = {
        institution: bank.trim() || null,
        numberLast4: last4.trim() || null,
        ifsc: ifsc.trim() || null,
        groupLabel: kind.groupLabel ?? (account && !KINDS.some((k) => k.groupLabel === account.groupLabel) ? account.groupLabel : null),
        jointWith: jointWith.trim() || null,
        ownShare: jointWith.trim() ? ownShare : 100,
        ...(kind.type === "liability" ? { creditLimit: parsedLimit } : {}),
      };
      if (account) await update.mutateAsync({ name, icon, subtype: kind.subtype, ...details });
      else await create.mutateAsync({ type: kind.type, subtype: kind.subtype, name, icon, openingBalance: opening || undefined, openingDate: today(), ...details });
      toast({ message: account ? "Account updated" : `${name} added` });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={account ? "Edit account" : "New account"}>
      <form className="sheet-body form" onSubmit={submit}>
        {!account && (
          <div className="chips" style={{ flexWrap: "wrap" }}>
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                className="chip"
                aria-pressed={kind.key === k.key}
                onClick={() => {
                  setKind(k);
                  setIcon(k.icon);
                }}
              >
                {k.icon} {k.label}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 10 }}>
          <label className="field">
            <span>Icon</span>
            <input className="input" value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={4} style={{ textAlign: "center", fontSize: 18 }} />
          </label>
          <label className="field">
            <span>Name</span>
            <input className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind.subtype === "loan" ? "Car loan, education loan…" : kind.type === "liability" ? "HDFC Regalia" : "HDFC Savings"} required maxLength={60} />
          </label>
        </div>
        {!account && (
          <label className="field">
            <span>{kind.type === "liability" ? "Amount owed today" : "Balance today"}</span>
            <div className="smart" style={{ background: "var(--surface)", boxShadow: "inset 0 0 0 1px var(--line-strong)" }}>
              <span className="faint">{currencySymbol(entity.currency)}</span>
              <input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" placeholder="0" aria-label="Opening balance" />
            </div>
            <small>Recorded as an opening balance, so it never counts as income or spending.</small>
          </label>
        )}
        {kind.subtype === "card" && (
          <label className="field">
            <span>Credit limit</span>
            <div className="smart" style={{ background: "var(--surface)", boxShadow: "inset 0 0 0 1px var(--line-strong)" }}>
              <span className="faint">{currencySymbol(entity.currency)}</span>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" placeholder="e.g. 3L" aria-label="Credit limit" />
            </div>
            <small>Shows what you can still borrow. It never counts as money you have.</small>
          </label>
        )}
        {(kind.subtype === "bank" || kind.subtype === "investment" || kind.subtype === "loan") && (
          <div className="field">
            <span>Joint account</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
              <input className="input" value={jointWith} onChange={(e) => setJointWith(e.target.value)} placeholder="Held with… (leave empty if only yours)" aria-label="Joint with" maxLength={120} />
              <div className="smart" style={{ background: "var(--surface)", boxShadow: "inset 0 0 0 1px var(--line-strong)", height: 40, opacity: jointWith ? 1 : 0.5 }}>
                <input value={share} onChange={(e) => setShare(e.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" aria-label="Your share percent" disabled={!jointWith} />
                <span className="faint">% yours</span>
              </div>
            </div>
            <small>The account shows its full balance; your net worth counts only your share.</small>
          </div>
        )}
        {kind.subtype !== "cash" && kind.key !== "property" && (
          <div className="field">
            <span>Statement details</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 92px 1fr", gap: 8 }}>
              <input className="input" value={bank} onChange={(e) => setBank(e.target.value)} placeholder="HDFC Bank" aria-label="Bank" maxLength={60} />
              <input className="input num" value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Last 4" aria-label="Last 4 digits" inputMode="numeric" />
              <input className="input" value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} placeholder="IFSC (optional)" aria-label="IFSC" maxLength={11} />
            </div>
            <small>How an imported statement finds this account. Only the last 4 digits are stored.</small>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary btn-lg" disabled={!name.trim() || create.isPending || update.isPending}>
          {account ? "Save" : "Add account"}
        </button>
      </form>
    </Sheet>
  );
}

export function AccountDetailPage() {
  const { accountId = "" } = useParams();
  const { entity, byId, canEdit, isOwner } = useEntity();
  const { compose } = useActions();
  const navigate = useNavigate();
  const toast = useToast();
  const ledger = useInfiniteLedger(entity.id, accountId);
  const ledgerRows = ledger.data?.pages.flatMap((p) => p.rows) ?? [];
  const account = byId.get(accountId);
  const [editing, setEditing] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [target, setTarget] = useState("");
  const adjust = useEntityMutation<{ balance: number }>(entity.id, `/accounts/${accountId}/adjust`);
  const archive = useEntityMutation<{ archived: boolean }>(entity.id, `/accounts/${accountId}`, "PATCH");
  const makeDefault = useEntityMutation<{ defaultAccountId: string }>(entity.id, "", "PATCH");

  const emisQ = useEmis(entity.id);
  if (!account) return <main className="page"><Skeleton /></main>;
  const balance = displayBalance(account.type, account.balance);
  const liability = account.type === "liability";
  // EMIs billed to this card: unbilled ones sit in hidden sub-accounts; SBI-style ones are inside the balance.
  const emiPlans = (emisQ.data ?? []).filter((p) => p.accountId === account.id && !p.done);
  const emiSeparate = emiPlans.filter((p) => p.balanceAccountId && byId.get(p.balanceAccountId)?.parentId === account.id).reduce((s, p) => s + p.left, 0);
  const emiInside = emiPlans.filter((p) => !p.balanceAccountId).reduce((s, p) => s + p.left, 0);
  const used = balance + emiSeparate;

  return (
    <main className="page">
      <div className="page-head">
        <button className="icon-btn" onClick={() => navigate("..", { relative: "path" })} aria-label="Back to accounts">
          <ArrowLeft />
        </button>
        <Tile icon={account.icon} />
        <h1 className="h1" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {account.name}
        </h1>
        <div className="spacer" />
        {canEdit && (
          <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Edit account">
            <Pencil />
          </button>
        )}
      </div>

      <div className="card card-pad">
        <span className="eyebrow">{liability ? "Owed" : "Balance"}</span>
        <div className={`big-number num ${liability && balance > 0 ? "expense" : ""}`} style={{ marginTop: 4 }}>
          {formatMoney(balance, { currency: entity.currency })}
        </div>
        {account.creditLimit ? (
          <div className="muted num" style={{ fontSize: 13, marginTop: 6 }}>
            {formatMoney(Math.max(0, account.creditLimit - used), { currency: entity.currency })} available of {formatMoney(account.creditLimit, { currency: entity.currency })} limit ·{" "}
            {Math.round((used / account.creditLimit) * 100)}% used
          </div>
        ) : null}
        {emiPlans.length > 0 && (
          <Link to="../emis" className="muted num" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, marginTop: 6 }}>
            {emiSeparate > 0 && `+ ${formatMoney(emiSeparate, { currency: entity.currency })} on EMI, billed monthly`}
            {emiSeparate > 0 && emiInside > 0 && " · "}
            {emiInside > 0 && `includes ≈${formatMoney(emiInside, { currency: entity.currency })} on EMI`}
            {" "}({emiPlans.length} EMI{emiPlans.length === 1 ? "" : "s"}) <ChevronRight size={14} />
          </Link>
        )}
        {canEdit && (
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            <button className="btn btn-secondary btn-sm" onClick={() => (setTarget(toInput(balance)), setReconciling(true))}>
              <Scale /> Reconcile
            </button>
            {isOwner && entity.defaultAccountId !== account.id && !account.archived && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await makeDefault.mutateAsync({ defaultAccountId: account.id });
                  toast({ message: `${account.name} is now the default` });
                }}
              >
                <Star /> Make default
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                await archive.mutateAsync({ archived: !account.archived });
                toast({ message: account.archived ? "Restored" : "Archived. History stays intact." });
              }}
            >
              <Archive /> {account.archived ? "Restore" : "Archive"}
            </button>
          </div>
        )}
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="h3">Statement</h2>
          <div className="spacer" />
          <span className="faint" style={{ fontSize: 12.5 }}>
            Running balance on the right
          </span>
        </div>
        {ledger.isLoading ? (
          <Skeleton />
        ) : ledgerRows.length ? (
          <>
            <div className="card list">
              {ledgerRows.map((r) => (
                <TxRow key={r.id} tx={r} showDate delta={liability ? -r.delta : r.delta} running={r.running} onClick={() => compose({ tx: r })} />
              ))}
            </div>
            <LoadMore onMore={() => ledger.fetchNextPage()} hasMore={!!ledger.hasNextPage} loading={ledger.isFetchingNextPage} />
          </>
        ) : (
          <div className="card">
            <Empty icon={<Wallet />} title="No transactions yet" />
          </div>
        )}
      </section>

      <AccountSheet open={editing} onClose={() => setEditing(false)} account={account} />
      <Sheet open={reconciling} onClose={() => setReconciling(false)} title="Reconcile">
        <form
          className="sheet-body form"
          onSubmit={async (e) => {
            e.preventDefault();
            const value = parseAmount(target);
            if (value === null) return;
            await adjust.mutateAsync({ balance: value });
            toast({ message: value === balance ? "Already matches" : "Balance adjusted" });
            setReconciling(false);
          }}
        >
          <p className="muted" style={{ margin: 0 }}>
            Enter what your {liability ? "card statement says you owe" : "bank app or wallet shows"} right now. The difference is recorded as an adjustment, so the
            history stays honest.
          </p>
          <div className="smart" style={{ background: "var(--surface)", boxShadow: "inset 0 0 0 1px var(--line-strong)", height: 48 }}>
            <span className="faint">{currencySymbol(entity.currency)}</span>
            <input data-autofocus value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" aria-label="Actual balance" style={{ fontSize: 18, fontWeight: 600 }} />
          </div>
          {parseAmount(target) !== null && parseAmount(target) !== balance && (
            <p className="muted num" style={{ margin: 0 }}>
              Adjustment: {formatMoney(parseAmount(target)! - balance, { currency: entity.currency, sign: "always" })}
            </p>
          )}
          <button className="btn btn-primary btn-lg" disabled={adjust.isPending || parseAmount(target) === null}>
            <Check /> Set balance
          </button>
        </form>
      </Sheet>
    </main>
  );
}
