import { AlertTriangle, ArrowRight, Bot, CircleCheck, FileText, History, Loader2, Sparkles, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, today } from "../../shared/dates";
import { uuidv7 } from "../../shared/ids";
import { displayBalance } from "../../shared/ledger";
import { currencySymbol, formatMoney, isExpression, parseAmount, toInput } from "../../shared/money";
import { ORIGIN_LABEL, type AssistWarning, type Contact, type EntryKind, type ParseResult, type TransactionInput } from "../../shared/types";
import { api, ApiError, assist, useDeleteTransaction, useRestoreTransaction, useSaveTransaction } from "../api";
import { type ComposerOptions, remember, useEntity } from "../state";
import { ContactPicker, type ContactValue } from "./ContactPicker";
import { Segmented, Sheet, Tile, useToast } from "./ui";

type Field = "kind" | "amount" | "category" | "account" | "toAccount" | "date" | "note" | "contact";
type Source = "jev" | "history";
type SplitMode = "none" | "split" | "paidBy";

const KIND_LABEL: Record<EntryKind, string> = { expense: "Expense", income: "Income", transfer: "Transfer", gave: "You gave", got: "You got" };
const isIou = (k: EntryKind) => k === "gave" || k === "got";

/**
 * Add or edit a transaction. Built for micro-entries: the amount is focused on
 * open, the most-used categories come first, the last account is remembered,
 * Enter saves and Shift+Enter saves and starts the next one.
 *
 * The smart line ("chai 40 cash") asks Jev to fill the form; anything Jev was
 * unsure about stays empty, and nothing saves until you press Save. Picking a
 * contact fills the category and account you usually use with them.
 */
export function Composer({ open, options, onClose }: { open: boolean; options: ComposerOptions; onClose: () => void }) {
  const state = useEntity();
  const { entity, money, expenseCats, incomeCats, byId, contactsById, canEdit } = state;
  const toast = useToast();
  const save = useSaveTransaction(entity.id);
  const del = useDeleteTransaction(entity.id);
  const restore = useRestoreTransaction(entity.id);
  const editing = options.tx;
  const readOnly = !canEdit;

  const liveAccount = (id?: string | null) => (id && money.some((m) => m.id === id) ? id : null);
  const defaultAccount = () => liveAccount(remember.get(`account:${entity.id}`)) ?? liveAccount(entity.defaultAccountId) ?? money[0]?.id ?? "";

  const [kind, setKind] = useState<EntryKind>("expense");
  const [amountText, setAmountText] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [accountTouched, setAccountTouched] = useState(false);
  const [toAccountId, setToAccountId] = useState<string | null>(null);
  const [contact, setContact] = useState<ContactValue>(null);
  const [splitMode, setSplitMode] = useState<SplitMode>("none");
  const [splitWith, setSplitWith] = useState<ContactValue>(null);
  const [theirShare, setTheirShare] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [smartText, setSmartText] = useState("");
  const [smartBusy, setSmartBusy] = useState(false);
  const [filled, setFilled] = useState<Map<Field, Source>>(new Map());
  const [suggested, setSuggested] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<AssistWarning[]>([]);
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const noteSuggestFor = useRef<string>("");

  const mark = (f: Field, s: Source) => setFilled((m) => new Map(m).set(f, s));
  const touched = (f: Field) =>
    setFilled((m) => {
      if (!m.has(f)) return m;
      const n = new Map(m);
      n.delete(f);
      return n;
    });

  /** What you usually do with this contact: a lookup in your own history, no model involved. */
  const applyContactHistory = (c: Contact | undefined, k: EntryKind, opts: { category: boolean; account: boolean }) => {
    if (!c) return;
    const pool = k === "income" ? incomeCats : expenseCats;
    if (opts.category && (k === "expense" || k === "income") && c.topCategoryId && pool.some((x) => x.id === c.topCategoryId)) {
      setCategoryId(c.topCategoryId);
      mark("category", "history");
    }
    if (opts.account && liveAccount(c.lastAccountId)) {
      setAccountId(c.lastAccountId!);
      mark("account", "history");
    }
  };

  const applyParse = (p: ParseResult) => {
    const d = p.draft;
    const next = new Map<Field, Source>([["kind", "jev"]]);
    setKind(d.kind);
    if (d.amount) {
      setAmountText(toInput(d.amount));
      next.set("amount", "jev");
    }
    setCategoryId(d.categoryId);
    if (d.categoryId) next.set("category", "jev");
    if (d.accountId) {
      setAccountId(d.accountId);
      next.set("account", "jev");
    }
    setToAccountId(d.toAccountId);
    if (d.toAccountId) next.set("toAccount", "jev");
    if (d.contactId || d.newContact) {
      setContact(d.contactId ? { id: d.contactId } : d.newContact);
      next.set("contact", "jev");
    }
    if (d.date !== today()) next.set("date", "jev");
    setDate(d.date);
    setNote(d.note ?? "");
    noteSuggestFor.current = d.note ?? "";
    setFilled(next);
    setSuggested(p.suggestions.categoryIds);
    setWarnings(p.warnings);
    // Send the cursor to whatever still needs a decision.
    requestAnimationFrame(() => {
      if (!d.amount) amountRef.current?.focus();
      else saveRef.current?.focus();
    });
  };

  // Reset whenever the sheet opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSmartText(options.smartText ?? "");
    setFilled(new Map());
    setSuggested([]);
    setWarnings([]);
    setAccountTouched(false);
    noteSuggestFor.current = "";
    if (editing) {
      const k = (["expense", "income", "transfer", "gave", "got"] as EntryKind[]).includes(editing.kind as EntryKind) ? (editing.kind as EntryKind) : "expense";
      setKind(k);
      setAmountText(toInput(Math.abs(editing.amount) + (editing.share?.amount ?? 0)));
      setCategoryId(editing.categoryId);
      setAccountId(editing.accountId ?? defaultAccount());
      setToAccountId(editing.toAccountId);
      setContact(editing.contactId ? { id: editing.contactId } : null);
      setSplitMode(editing.share ? "split" : editing.paidBy ? "paidBy" : "none");
      setSplitWith(editing.share ? { id: editing.share.contactId } : editing.paidBy ? { id: editing.paidBy } : null);
      setTheirShare(editing.share ? toInput(editing.share.amount) : "");
      setDate(editing.date);
      setNote(editing.note ?? "");
      noteSuggestFor.current = editing.note ?? "";
    } else {
      const k = options.kind ?? options.draft?.kind ?? "expense";
      setKind(k);
      setAmountText(options.draft?.amount ? toInput(options.draft.amount) : "");
      setCategoryId(options.draft?.categoryId ?? null);
      setAccountId(options.draft?.accountId ?? defaultAccount());
      setToAccountId(options.draft?.toAccountId ?? null);
      setContact(options.contactId ? { id: options.contactId } : null);
      setSplitMode("none");
      setSplitWith(null);
      setTheirShare("");
      setDate(options.draft?.date ?? today());
      setNote(options.draft?.note ?? "");
      if (options.contactId) applyContactHistory(contactsById.get(options.contactId), k, { category: true, account: true });
      if (options.parse) applyParse(options.parse);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = parseAmount(amountText);
  const categories = kind === "income" ? incomeCats : expenseCats;
  const share = splitMode !== "none" ? (theirShare.trim() ? parseAmount(theirShare) : 0) : 0;
  const myShare = total !== null && share !== null ? total - share : null;

  // Category suggestion while typing a note (only when no category is chosen yet).
  useEffect(() => {
    if (!open || readOnly || (kind !== "expense" && kind !== "income") || categoryId || !note.trim() || note === noteSuggestFor.current) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      noteSuggestFor.current = note;
      try {
        const r = await assist(entity.id, note, "record", kind, ctrl.signal);
        if (!r.parse) return;
        setSuggested(r.parse.suggestions.categoryIds);
        setWarnings(r.parse.warnings);
        if (r.parse.draft.categoryId) {
          setCategoryId((cur) => cur ?? r.parse!.draft.categoryId);
          mark("category", "jev");
        }
        if (!contact && (r.parse.draft.contactId || r.parse.draft.newContact)) {
          setContact(r.parse.draft.contactId ? { id: r.parse.draft.contactId } : r.parse.draft.newContact);
          mark("contact", "jev");
        }
      } catch {
        /* suggestions are best-effort */
      }
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [note, kind, categoryId, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const runSmart = async () => {
    const text = smartText.trim();
    if (!text || smartBusy) return;
    setSmartBusy(true);
    setError(null);
    try {
      const r = await assist(entity.id, text, "record");
      if (r.parse) applyParse(r.parse);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't read that. Fill the form instead.");
    } finally {
      setSmartBusy(false);
    }
  };

  const validation = useMemo(() => {
    if (!total || total <= 0) return "Enter an amount.";
    if (isIou(kind) && !contact) return kind === "gave" ? "Who did you give it to?" : "Who did you get it from?";
    if (!(kind === "expense" && splitMode === "paidBy") && !accountId) return "Choose an account.";
    if (kind === "transfer" && !toAccountId) return "Choose where the money went.";
    if (kind === "transfer" && toAccountId === accountId) return "Pick two different accounts.";
    if ((kind === "expense" || kind === "income") && !categoryId) return "Choose a category.";
    if (kind === "expense" && splitMode !== "none") {
      if (!splitWith) return splitMode === "split" ? "Who are you splitting with?" : "Who paid?";
      if (share === null) return "Their share isn't a number.";
      if (splitMode === "split" && share <= 0) return "Enter their share.";
      if (share >= total) return "Their share must be less than the total.";
    }
    return null;
  }, [total, accountId, toAccountId, categoryId, kind, contact, splitMode, splitWith, share]);

  /** New contacts that can't ride along with the transaction are created first. */
  const ensureContact = async (v: ContactValue): Promise<string | null> => {
    if (!v) return null;
    if ("id" in v) return v.id;
    const r = await api<{ contact: Contact }>(`/entities/${entity.id}/contacts`, { method: "POST", body: { name: v.name, kind: v.kind } });
    return r.contact.id;
  };

  const submit = async (another: boolean) => {
    if (readOnly) return;
    if (validation) {
      setError(validation);
      if (!total) amountRef.current?.focus();
      return;
    }
    try {
      const partner = kind === "expense" && splitMode !== "none" ? await ensureContact(splitWith) : null;
      const inline = !editing && contact && !("id" in contact) ? contact : null;
      const contactId = inline ? null : await ensureContact(contact);
      const input: TransactionInput = {
        id: editing ? undefined : uuidv7(),
        kind,
        date,
        amount: kind === "expense" && splitMode !== "none" ? myShare! : total!,
        accountId: kind === "expense" && splitMode === "paidBy" ? null : accountId,
        categoryId: kind === "expense" || kind === "income" ? categoryId : null,
        toAccountId: kind === "transfer" ? toAccountId : null,
        contactId: kind === "transfer" ? null : contactId,
        newContact: kind === "transfer" ? null : inline,
        paidBy: kind === "expense" && splitMode === "paidBy" ? partner : null,
        share: kind === "expense" && splitMode === "split" && partner ? { contactId: partner, amount: share! } : null,
        note: note.trim() || null,
        origin: filled.size > 0 && !options.evidenceId ? "smart" : "manual",
        reviewed: true,
      };
      if (editing) {
        delete input.newContact;
        delete input.origin;
      }
      if (options.evidenceId) (input as TransactionInput & { evidenceId: string }).evidenceId = options.evidenceId;
      const { transaction } = await save.mutateAsync({ id: editing?.id, input });
      if (input.accountId) remember.set(`account:${entity.id}`, input.accountId);
      const shown = formatMoney(kind === "expense" && splitMode !== "none" ? total! : transaction.amount, { currency: entity.currency });
      if (editing) toast({ message: "Saved" });
      else toast({ message: `${KIND_LABEL[kind]} ${shown} saved`, action: { label: "Undo", onClick: () => del.mutate(transaction.id) } });
      if (another && !editing) {
        setAmountText("");
        setNote("");
        setSmartText("");
        setCategoryId(null);
        setContact(null);
        setSplitMode("none");
        setSplitWith(null);
        setTheirShare("");
        setFilled(new Map());
        setSuggested([]);
        setWarnings([]);
        setError(null);
        noteSuggestFor.current = "";
        amountRef.current?.focus();
      } else onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save. Check your connection and try again.");
    }
  };

  const remove = async () => {
    if (!editing) return;
    await del.mutateAsync(editing.id);
    toast({ message: "Deleted", action: { label: "Undo", onClick: () => restore.mutate(editing.id) } });
    onClose();
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(e.shiftKey);
    }
  };

  const badge = (f: Field) => {
    const s = filled.get(f);
    if (!s) return null;
    return s === "jev" ? (
      <span className="ai">
        <Sparkles /> Suggested
      </span>
    ) : (
      <span className="ai history">
        <History /> Usual
      </span>
    );
  };

  const accountChips = (value: string | null, onChange: (id: string) => void, exclude?: string | null, field: Field = "account") => (
    <div className="chips" role="group">
      {money
        .filter((m) => m.id !== exclude)
        .map((m) => (
          <button
            key={m.id}
            type="button"
            className="chip"
            aria-pressed={value === m.id}
            disabled={readOnly}
            onClick={() => {
              onChange(m.id);
              if (field === "account") setAccountTouched(true);
              touched(field);
            }}
          >
            <span>{m.icon}</span> {m.name}
            <span className="chip-sub num">{formatMoney(displayBalance(m.type, m.balance), { currency: entity.currency, compact: true })}</span>
          </button>
        ))}
    </div>
  );

  const segment = isIou(kind) ? "iou" : kind;
  const title = editing ? (readOnly ? "Transaction" : `Edit ${KIND_LABEL[kind].toLowerCase()}`) : "New transaction";
  const isOpening = editing && (editing.kind === "opening" || editing.kind === "adjustment");
  const contactLabel = kind === "expense" ? "Paid to" : kind === "income" ? "Received from" : kind === "gave" ? "Gave to" : "Got from";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={title}
      head={
        <div className="sheet-head" style={{ paddingBottom: 2 }}>
          {isOpening ? (
            <h2 className="h2">{editing!.kind === "opening" ? "Opening balance" : "Balance adjustment"}</h2>
          ) : (
            <Segmented
              label="Type"
              value={segment}
              onChange={(k) => {
                setKind(k === "iou" ? (isIou(kind) ? kind : "gave") : k);
                setCategoryId(null);
                setSuggested([]);
                touched("kind");
              }}
              options={[
                { value: "expense" as const, label: "Expense" },
                { value: "income" as const, label: "Income" },
                { value: "transfer" as const, label: "Transfer" },
                { value: "iou" as const, label: "IOU" },
              ]}
            />
          )}
          <div className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </button>
        </div>
      }
      footer={
        isOpening ? null : readOnly ? (
          <span className="muted" style={{ fontSize: 13 }}>
            You have view-only access to {entity.name}.
          </span>
        ) : (
          <>
            {editing ? (
              <button className="btn btn-danger" onClick={remove} disabled={del.isPending}>
                <Trash2 /> Delete
              </button>
            ) : (
              <button className="btn btn-secondary hide-mobile" onClick={() => submit(true)} disabled={save.isPending} title="Shift + Enter">
                Save & add another
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button ref={saveRef} className="btn btn-primary" style={{ minWidth: 112 }} onClick={() => submit(false)} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="spin" /> : editing?.needsReview ? "Confirm" : "Save"}
            </button>
          </>
        )
      }
    >
      <div className="sheet-body">
        {!editing && !readOnly && (
          <form
            className="smart"
            onSubmit={(e) => {
              e.preventDefault();
              runSmart();
            }}
          >
            {smartBusy ? <Loader2 className="spin spark" /> : <Sparkles className={smartText ? "spark" : ""} />}
            <input
              value={smartText}
              onChange={(e) => setSmartText(e.target.value)}
              placeholder="Type it: “uber to airport 640 card”"
              aria-label="Describe the transaction"
              enterKeyHint="go"
            />
            {smartText && (
              <button type="submit" className="icon-btn" aria-label="Fill the form" disabled={smartBusy}>
                <ArrowRight />
              </button>
            )}
          </form>
        )}

        {isOpening ? (
          <div className="amount-field" style={{ paddingBottom: 18 }}>
            <span className="h1 num">{formatMoney(editing!.amount, { currency: entity.currency })}</span>
          </div>
        ) : (
          <>
            <div className="amount-field">
              <span className="cur">{currencySymbol(entity.currency)}</span>
              <input
                ref={amountRef}
                data-autofocus={editing || options.parse ? undefined : true}
                value={amountText}
                onChange={(e) => {
                  setAmountText(e.target.value);
                  setError(null);
                  touched("amount");
                }}
                onKeyDown={onEnter}
                inputMode="decimal"
                enterKeyHint="done"
                placeholder="0"
                aria-label={splitMode !== "none" ? "Total bill" : "Amount"}
                autoComplete="off"
                readOnly={readOnly}
                className={kind === "income" ? "income" : ""}
                style={{ width: `${Math.max(1, amountText.length) + 0.3}ch` }}
              />
            </div>
            <div className="amount-hint num">
              {amountText && total === null
                ? "Not a number"
                : amountText && isExpression(amountText) && total !== null
                  ? `= ${formatMoney(total, { currency: entity.currency })}`
                  : kind === "expense" && splitMode !== "none" && myShare !== null && total
                    ? `Total bill · your share ${formatMoney(Math.max(0, myShare), { currency: entity.currency })}`
                    : filled.has("amount")
                      ? "Read from your text"
                      : ""}
            </div>
          </>
        )}

        {editing?.needsReview && !readOnly && (
          <div className="banner" role="note">
            <AlertTriangle />
            <span>Imported from a statement with a guess. Check the category and contact, then save to confirm.</span>
          </div>
        )}
        {options.evidenceId && (
          <div className="banner" role="note" style={{ background: "var(--surface-2)", color: "var(--text-2)", boxShadow: "inset 0 0 0 1px var(--line)" }}>
            <FileText />
            <span>Recording a statement line. It must move {formatMoney(total ?? 0, { currency: entity.currency })} through the account it came from.</span>
          </div>
        )}
        {warnings.map((w) => (
          <div key={w.code} className="banner" role="note">
            <AlertTriangle />
            <span>{w.message}</span>
          </div>
        ))}

        {!isOpening && isIou(kind) && (
          <>
            <div className="chips" style={{ marginTop: 6 }}>
              {(["gave", "got"] as const).map((k) => (
                <button key={k} type="button" className="chip" aria-pressed={kind === k} disabled={readOnly} onClick={() => setKind(k)}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            <p className="faint" style={{ fontSize: 12.5, margin: "8px 2px 0" }}>
              Lending, borrowing and paying back. It changes who owes whom, never your income or spending.
            </p>
          </>
        )}

        {!isOpening && kind !== "transfer" && (
          <>
            <div className="composer-label">
              {contactLabel} {isIou(kind) ? null : <span className="faint" style={{ fontWeight: 450 }}>optional</span>} {badge("contact")}
            </div>
            <ContactPicker
              value={contact}
              disabled={readOnly}
              defaultKind={isIou(kind) ? "person" : "business"}
              placeholder={isIou(kind) ? "Who?" : kind === "income" ? "Client, employer, person…" : "Blinkit, Uber, a friend…"}
              onChange={(v) => {
                setContact(v);
                touched("contact");
                if (v && "id" in v) applyContactHistory(contactsById.get(v.id), kind, { category: !categoryId, account: !accountTouched });
              }}
            />
          </>
        )}

        {!isOpening && (kind === "expense" || kind === "income") && (
          <>
            <div className="composer-label">Category {badge("category")}</div>
            <div className="cat-grid" role="group" aria-label="Category">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="cat"
                  aria-pressed={categoryId === c.id}
                  data-suggested={suggested.includes(c.id) || undefined}
                  disabled={readOnly}
                  onClick={() => {
                    setCategoryId(c.id);
                    setError(null);
                    touched("category");
                  }}
                >
                  <Tile icon={c.icon} />
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {!isOpening && !(kind === "expense" && splitMode === "paidBy") && (
          <>
            <div className="composer-label">
              {kind === "transfer" ? "From" : kind === "income" || kind === "got" ? "Into" : "Paid from"} {badge("account")}
            </div>
            {accountChips(accountId, setAccountId)}
          </>
        )}
        {!isOpening && kind === "transfer" && (
          <>
            <div className="composer-label">To {badge("toAccount")}</div>
            {accountChips(toAccountId, setToAccountId, accountId, "toAccount")}
          </>
        )}

        {!isOpening && kind === "expense" && (
          <>
            {splitMode === "none" ? (
              <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 12, marginLeft: -10 }} disabled={readOnly} onClick={() => setSplitMode("split")}>
                <Users /> Split, or someone else paid
              </button>
            ) : (
              <div className="split-box">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Segmented
                    label="Who paid"
                    value={splitMode}
                    onChange={(m) => setSplitMode(m)}
                    options={[
                      { value: "split" as const, label: "I paid, split it" },
                      { value: "paidBy" as const, label: "They paid" },
                    ]}
                  />
                  <div style={{ flex: 1 }} />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => (setSplitMode("none"), setSplitWith(null), setTheirShare(""))}>
                    Remove
                  </button>
                </div>
                <div className="composer-label" style={{ marginTop: 12 }}>
                  {splitMode === "split" ? "Split with" : "Who paid"}
                </div>
                <ContactPicker value={splitWith} onChange={setSplitWith} defaultKind="person" placeholder="A friend, a colleague…" disabled={readOnly} />
                <div className="composer-label">Their share</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    className="input num"
                    style={{ maxWidth: 160 }}
                    value={theirShare}
                    onChange={(e) => setTheirShare(e.target.value)}
                    onKeyDown={onEnter}
                    inputMode="decimal"
                    placeholder={splitMode === "paidBy" ? "0" : "Amount"}
                    aria-label="Their share"
                  />
                  {total ? (
                    <button type="button" className="chip" onClick={() => setTheirShare(toInput(Math.round(total / 2)))}>
                      Half
                    </button>
                  ) : null}
                </div>
                {total && myShare !== null && myShare > 0 && splitWith && (
                  <p className="muted num" style={{ fontSize: 12.5, margin: "10px 2px 0" }}>
                    {splitMode === "split"
                      ? `Your spending: ${formatMoney(myShare, { currency: entity.currency })}. They'll owe you ${formatMoney(share ?? 0, { currency: entity.currency })}.`
                      : `Your spending: ${formatMoney(myShare, { currency: entity.currency })}. You'll owe them ${formatMoney(myShare, { currency: entity.currency })}.`}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {isOpening && editing?.accountId && (
          <p className="muted" style={{ margin: "0 0 8px", textAlign: "center" }}>
            {byId.get(editing.accountId)?.name} · {editing.date}
          </p>
        )}

        {!isOpening && (
          <>
            <div className="composer-label">Date {badge("date")}</div>
            <div className="chips">
              {[
                { label: "Today", value: today() },
                { label: "Yesterday", value: addDays(today(), -1) },
              ].map((d) => (
                <button key={d.label} type="button" className="chip" aria-pressed={date === d.value} disabled={readOnly} onClick={() => setDate(d.value)}>
                  {d.label}
                </button>
              ))}
              <input
                type="date"
                className="chip"
                aria-label="Pick a date"
                aria-pressed={date !== today() && date !== addDays(today(), -1)}
                value={date}
                max="2999-12-31"
                disabled={readOnly}
                onChange={(e) => e.target.value && setDate(e.target.value)}
                style={{ paddingRight: 8 }}
              />
            </div>

            <div className="composer-label">Note</div>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={onEnter}
              placeholder={kind === "transfer" ? "ATM withdrawal" : isIou(kind) ? "Goa trip advance" : "What was it for?"}
              aria-label="Note"
              maxLength={500}
              readOnly={readOnly}
            />
            {editing && (
              <div className="provenance">
                <span className="pill">
                  {editing.origin === "statement" ? <FileText /> : null}
                  {ORIGIN_LABEL[editing.origin]}
                </span>
                {editing.reconciled && (
                  <span className="pill" style={{ color: "var(--good)" }}>
                    <CircleCheck /> On the bank statement
                  </span>
                )}
                {editing.sources.includes("sms") && <span className="pill">Seen in an SMS</span>}
                {editing.sources.includes("email") && <span className="pill">Seen in an email</span>}
                <span className="pill">
                  {editing.agentName ? (
                    <>
                      <Bot /> {editing.agentName} for {editing.createdByName}
                    </>
                  ) : (
                    editing.createdByName
                  )}
                </span>
                {editing.updatedAt && <span className="pill">edited</span>}
              </div>
            )}
          </>
        )}

        {error && (
          <p className="error-text" role="alert" style={{ margin: "14px 2px 0" }}>
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
