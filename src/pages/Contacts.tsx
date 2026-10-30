import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, ChevronRight, Handshake, Pencil, Plus, Search, Sparkles, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { relativeDay } from "../../shared/dates";
import { formatMoney } from "../../shared/money";
import type { Contact, ContactKind } from "../../shared/types";
import { api, ApiError, type ContactSuggestion, useContactStatement, useEntityMutation } from "../api";
import { ContactChip } from "../components/ContactPicker";
import { TxRow } from "../components/TxRow";
import { Empty, Money, Segmented, Sheet, Skeleton, useToast } from "../components/ui";
import { useActions, useEntity } from "../state";

type Filter = "all" | "open" | "person" | "business";

/** "owes you ₹2,000" / "you owe ₹650" / "settled". */
export function BalanceText({ contact, currency }: { contact: Contact; currency: string }) {
  if (contact.balance === 0) return <span className="faint">{contact.kind === "person" && contact.transactions ? "settled" : ""}</span>;
  const amt = formatMoney(Math.abs(contact.balance), { currency });
  return contact.balance > 0 ? <span className="income">owes you {amt}</span> : <span className="expense">you owe {amt}</span>;
}

export function ContactsPage() {
  const { entity, contacts, canEdit } = useEntity();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [scanning, setScanning] = useState(false);
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });

  const owedToYou = contacts.filter((c) => c.balance > 0).reduce((s, c) => s + c.balance, 0);
  const youOwe = -contacts.filter((c) => c.balance < 0).reduce((s, c) => s + c.balance, 0);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return contacts
      .filter((c) => (filter === "open" ? c.balance !== 0 : filter === "all" ? true : c.kind === filter))
      .filter((c) => !needle || `${c.name} ${c.aliases ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.balance !== 0) - Number(a.balance !== 0) || (b.lastDate ?? "").localeCompare(a.lastDate ?? "") || a.name.localeCompare(b.name));
  }, [contacts, filter, q]);

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="h1">Contacts</h1>
        <div className="spacer" />
        {canEdit && (
          <>
            <button className="btn btn-ghost hide-mobile" onClick={() => setScanning(true)}>
              <Sparkles /> Find in past notes
            </button>
            <button className="btn btn-secondary" onClick={() => setCreating(true)}>
              <Plus /> New
            </button>
          </>
        )}
      </div>

      <div className="card stats">
        <div className="stat">
          <span className="eyebrow">Owed to you</span>
          <Money className="stat-value" value={owedToYou} currency={entity.currency} tone="income" />
        </div>
        <div className="stat">
          <span className="eyebrow">You owe</span>
          <Money className="stat-value" value={youOwe} currency={entity.currency} tone={youOwe ? "expense" : undefined} />
        </div>
        <div className="stat">
          <span className="eyebrow">Net</span>
          <span className="stat-value num">{fmt(owedToYou - youOwe)}</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "18px 0 12px", flexWrap: "wrap" }}>
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "open", label: "Owe" },
            { value: "person", label: "People" },
            { value: "business", label: "Businesses" },
          ]}
        />
        <div className="smart" style={{ flex: 1, minWidth: 180, height: 38, background: "var(--surface)" }}>
          <Search />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search contacts" />
        </div>
      </div>

      {list.length ? (
        <div className="card list">
          {list.map((c) => (
            <Link key={c.id} to={c.id} className="row">
              <ContactChip contact={c} size={36} />
              <div className="row-main">
                <span className="row-title">{c.name}</span>
                <span className="row-sub num">
                  {[c.sent ? `sent ${fmt(c.sent)}` : null, c.received ? `received ${fmt(c.received)}` : null, c.lastDate ? relativeDay(c.lastDate) : "no transactions yet"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <div className="row-amount num" style={{ fontSize: 13.5 }}>
                <BalanceText contact={c} currency={entity.currency} />
              </div>
              <ChevronRight size={16} className="faint" />
            </Link>
          ))}
        </div>
      ) : (
        <div className="card">
          <Empty
            icon={<Users />}
            title={contacts.length ? "No matches" : "No contacts yet"}
            action={
              canEdit && !contacts.length ? (
                <button className="btn btn-secondary" onClick={() => setScanning(true)}>
                  <Sparkles /> Find contacts in past notes
                </button>
              ) : undefined
            }
          >
            {contacts.length ? null : "Contacts are who's on the other side: Blinkit, Uber, a friend, a client. Add one when you record a transaction, or let the app find them in your notes."}
          </Empty>
        </div>
      )}

      <ContactSheet open={creating} onClose={() => setCreating(false)} />
      <SuggestionsSheet open={scanning} onClose={() => setScanning(false)} />
    </main>
  );
}

export function ContactDetailPage() {
  const { contactId = "" } = useParams();
  const { entity, canEdit } = useEntity();
  const { compose } = useActions();
  const navigate = useNavigate();
  const statement = useContactStatement(entity.id, contactId);
  const [editing, setEditing] = useState(false);
  const contact = statement.data?.contact;
  if (statement.error) return <main className="page"><Empty icon={<Users />} title="Contact not found" /></main>;
  if (!contact) return <main className="page"><Skeleton /></main>;
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency });
  const owes = contact.balance;

  return (
    <main className="page">
      <div className="page-head">
        <button className="icon-btn" onClick={() => navigate("..", { relative: "path" })} aria-label="Back to contacts">
          <ArrowLeft />
        </button>
        <ContactChip contact={contact} size={34} />
        <h1 className="h1" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {contact.name}
        </h1>
        <span className="pill" style={{ textTransform: "capitalize" }}>
          {contact.kind}
        </span>
        <div className="spacer" />
        {canEdit && (
          <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Edit contact">
            <Pencil />
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-pad">
          <span className="eyebrow">{owes > 0 ? `${contact.name} owes you` : owes < 0 ? `You owe ${contact.name}` : "Balance"}</span>
          <div className={`big-number num ${owes > 0 ? "income" : owes < 0 ? "expense" : ""}`} style={{ marginTop: 4 }}>
            {owes === 0 ? "Settled up" : fmt(Math.abs(owes))}
          </div>
          {canEdit && (
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <button className="btn btn-secondary btn-sm" onClick={() => compose({ kind: "gave", contactId: contact.id })}>
                <ArrowUpRight /> You gave
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => compose({ kind: "got", contactId: contact.id })}>
                <ArrowDownLeft /> You got
              </button>
              {owes !== 0 && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => compose({ kind: owes > 0 ? "got" : "gave", contactId: contact.id, draft: { amount: Math.abs(owes), note: "Settled up" } })}
                >
                  <Handshake /> Settle up
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => compose({ kind: "expense", contactId: contact.id })}>
                <Plus /> Expense
              </button>
            </div>
          )}
        </div>
        <div className="stats" style={{ borderTop: "1px solid var(--line)" }}>
          <div className="stat">
            <span className="eyebrow">Sent</span>
            <span className="stat-value num">{fmt(contact.sent)}</span>
          </div>
          <div className="stat">
            <span className="eyebrow">Received</span>
            <span className="stat-value num">{fmt(contact.received)}</span>
          </div>
          <div className="stat">
            <span className="eyebrow">Transactions</span>
            <span className="stat-value num">{contact.transactions}</span>
          </div>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="h3">Statement</h2>
          <div className="spacer" />
          {statement.data!.rows.some((r) => r.owed !== 0) && (
            <span className="faint" style={{ fontSize: 12.5 }}>
              Who owes whom after each, on the right
            </span>
          )}
        </div>
        {statement.data!.rows.length ? (
          <div className="card list">
            {statement.data!.rows.map((r) => (
              <TxRow key={r.id} tx={r} showDate hideContact running={r.owed !== 0 ? r.running : undefined} onClick={() => compose({ tx: r })} />
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty icon={<Users />} title="Nothing with them yet" />
          </div>
        )}
      </section>

      <ContactSheet open={editing} onClose={() => setEditing(false)} contact={contact} />
    </main>
  );
}

function ContactSheet({ open, onClose, contact }: { open: boolean; onClose: () => void; contact?: Contact }) {
  const { entity, expenseCats, incomeCats } = useEntity();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const create = useEntityMutation<Record<string, unknown>, { contact: Contact }>(entity.id, "/contacts");
  const update = useEntityMutation<Record<string, unknown>, { contact: Contact }>(entity.id, `/contacts/${contact?.id}`, "PATCH");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ContactKind>("business");
  const [aliases, setAliases] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(contact?.name ?? "");
    setKind(contact?.kind ?? "business");
    setAliases(contact?.aliases ?? "");
    setCategory(contact?.defaultCategoryId ?? "");
    setError(null);
  }, [open, contact]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const body = { name, kind, aliases: aliases || null, defaultCategoryId: category || null };
      if (contact) await update.mutateAsync(body);
      else {
        const r = await create.mutateAsync(body);
        navigate(`/e/${entity.id}/contacts/${r.contact.id}`);
      }
      qc.invalidateQueries({ queryKey: ["e", entity.id, "contact"] });
      toast({ message: contact ? "Contact saved" : `${name} added` });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={contact ? "Edit contact" : "New contact"}>
      <form className="sheet-body form" onSubmit={submit}>
        <Segmented
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: "business", label: "Business" },
            { value: "person", label: "Person" },
          ]}
        />
        <label className="field">
          <span>Name</span>
          <input className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder={kind === "person" ? "Rahul Sharma" : "Blinkit"} />
        </label>
        <label className="field">
          <span>Also written as</span>
          <input className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} maxLength={300} placeholder={kind === "person" ? "rahul s, rahul.s@okicici" : "grofers, blinkit commerce"} />
          <small>Comma-separated. Helps smart add recognise them in what you type.</small>
        </label>
        <label className="field">
          <span>Usual category</span>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Learn from history</option>
            <optgroup label="Expense">
              {expenseCats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Income">
              {incomeCats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          {contact && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                try {
                  await update.mutateAsync({ archived: !contact.archived });
                  toast({ message: contact.archived ? "Restored" : `${contact.name} archived. Past transactions keep the name.` });
                  onClose();
                  if (!contact.archived) navigate(`/e/${entity.id}/contacts`);
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : "Couldn't archive.");
                }
              }}
            >
              {contact.archived ? "Restore" : "Archive"}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn btn-primary" disabled={!name.trim() || create.isPending || update.isPending}>
            Save
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** Review what the note scan found; nothing is tagged until you apply. */
function SuggestionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { entity } = useEntity();
  const toast = useToast();
  const qc = useQueryClient();
  const [items, setItems] = useState<ContactSuggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = (s: ContactSuggestion) => s.contactId ?? `new:${s.name}`;

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setError(null);
    api<{ suggestions: ContactSuggestion[] }>(`/entities/${entity.id}/contacts/suggestions`).then(
      (r) => {
        setItems(r.suggestions);
        setPicked(new Set(r.suggestions.map(key)));
      },
      (err) => setError(err instanceof ApiError ? err.message : "Couldn't scan."),
    );
  }, [open, entity.id]);

  const apply = async () => {
    if (!items) return;
    setBusy(true);
    try {
      const chosen = items.filter((s) => picked.has(key(s)));
      const r = await api<{ tagged: number }>(`/entities/${entity.id}/contacts/suggestions/apply`, { method: "POST", body: { items: chosen } });
      await qc.invalidateQueries({ queryKey: ["e", entity.id] });
      toast({ message: `Tagged ${r.tagged} transaction${r.tagged === 1 ? "" : "s"}` });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't apply.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Contacts in your notes"
      footer={
        items && items.length > 0 ? (
          <>
            <span className="muted" style={{ fontSize: 13, alignSelf: "center" }}>
              {picked.size} selected
            </span>
            <div style={{ flex: 1 }} />
            <button className="btn btn-primary" onClick={apply} disabled={busy || picked.size === 0}>
              <Check /> Tag transactions
            </button>
          </>
        ) : undefined
      }
    >
      <div className="sheet-body">
        {error ? (
          <p className="error-text">{error}</p>
        ) : !items ? (
          <p className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Sparkles size={15} className="spark" /> Reading your notes…
          </p>
        ) : items.length === 0 ? (
          <Empty icon={<Users />} title="Nothing to tag">
            Your untagged transactions don't name any business or person.
          </Empty>
        ) : (
          <>
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
              Jev checked each word in your notes and kept the ones that are a business or a person. Untick anything that isn't.
            </p>
            <div className="card list">
              {items.map((s) => {
                const k = key(s);
                return (
                  <label key={k} className="row" style={{ cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={picked.has(k)}
                      onChange={(e) =>
                        setPicked((p) => {
                          const n = new Set(p);
                          if (e.target.checked) n.add(k);
                          else n.delete(k);
                          return n;
                        })
                      }
                    />
                    <ContactChip contact={s} size={32} />
                    <div className="row-main">
                      <span className="row-title">
                        {s.name} {!s.contactId && <span className="pill">new · {s.kind}</span>}
                      </span>
                      <span className="row-sub">“{s.examples.join("”, “")}”</span>
                    </div>
                    <span className="num muted" style={{ fontSize: 13 }}>
                      {s.transactionIds.length}
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
