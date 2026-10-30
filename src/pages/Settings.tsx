import { Archive, Copy, Download, History, Link2, Plus, Sparkles, UserMinus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { addDays, addMonths, fiscalYear, monthOf, monthRange, today } from "../../shared/dates";
import type { Account, Role } from "../../shared/types";
import { ApiError, useActivity, useEntityMutation, useMe, useMembers } from "../api";
import { Avatar, Empty, relativeTime, Segmented, Sheet, Skeleton, Tile, useToast } from "../components/ui";
import { useEntity } from "../state";

const TABS = [
  { id: "general", label: "General" },
  { id: "categories", label: "Categories" },
  { id: "members", label: "Members" },
  { id: "activity", label: "Activity" },
  { id: "export", label: "Export" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export const COLORS = ["#5b5bd6", "#0d9488", "#e5484d", "#f5a524", "#0090ff", "#d6409f", "#30a46c", "#121211"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const ROLE_INFO: Record<Role, string> = {
  owner: "Everything, including members and settings",
  editor: "Adds and edits transactions, accounts and categories",
  viewer: "Reads, asks and exports. Good for a CA or auditor",
};

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "general") as Tab;
  return (
    <main className="page">
      <div className="page-head">
        <h1 className="h1">Settings</h1>
      </div>
      <nav className="subnav" aria-label="Settings">
        {TABS.map((t) => (
          <Link key={t.id} to={`?tab=${t.id}`} aria-current={tab === t.id ? "page" : undefined} onClick={() => setParams({ tab: t.id })}>
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "general" && <General />}
      {tab === "categories" && <Categories />}
      {tab === "members" && <Members />}
      {tab === "activity" && <Activity />}
      {tab === "export" && <Export />}
    </main>
  );
}

function General() {
  const { entity, money, isOwner } = useEntity();
  const toast = useToast();
  const save = useEntityMutation<Record<string, unknown>>(entity.id, "", "PATCH");
  const [name, setName] = useState(entity.name);
  const [color, setColor] = useState(entity.color);
  const [fy, setFy] = useState(entity.fyStartMonth);
  const [def, setDef] = useState(entity.defaultAccountId ?? "");
  useEffect(() => {
    setName(entity.name);
    setColor(entity.color);
    setFy(entity.fyStartMonth);
    setDef(entity.defaultAccountId ?? "");
  }, [entity]);
  const dirty = name !== entity.name || color !== entity.color || fy !== entity.fyStartMonth || def !== (entity.defaultAccountId ?? "");

  return (
    <form
      className="card card-pad form"
      onSubmit={async (e) => {
        e.preventDefault();
        await save.mutateAsync({ name, color, fyStartMonth: fy, defaultAccountId: def || null });
        toast({ message: "Settings saved" });
      }}
    >
      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} maxLength={80} />
      </label>
      <div className="field">
        <span>Colour</span>
        <div className="swatches">
          {COLORS.map((c) => (
            <button key={c} type="button" className="swatch" style={{ background: c }} aria-pressed={color === c} aria-label={c} disabled={!isOwner} onClick={() => setColor(c)} />
          ))}
        </div>
        <small>Shown next to the name everywhere, so you always know whose books you're in.</small>
      </div>
      <div className="form-row">
        <label className="field">
          <span>Financial year starts</span>
          <select className="select" value={fy} onChange={(e) => setFy(Number(e.target.value))} disabled={!isOwner}>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Default account</span>
          <select className="select" value={def} onChange={(e) => setDef(e.target.value)} disabled={!isOwner}>
            <option value="">None</option>
            {money.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <div className="field">
          <span>Currency</span>
          <div className="input" style={{ display: "flex", alignItems: "center", color: "var(--text-2)" }}>
            {entity.currency}
          </div>
          <small>Fixed once created, so every amount means the same thing.</small>
        </div>
        <div className="field">
          <span>Type</span>
          <div className="input" style={{ display: "flex", alignItems: "center", color: "var(--text-2)", textTransform: "capitalize" }}>
            {entity.kind}
          </div>
        </div>
      </div>
      {isOwner && (
        <div>
          <button className="btn btn-primary" disabled={!dirty || save.isPending}>
            Save changes
          </button>
        </div>
      )}
    </form>
  );
}

function Categories() {
  const { expenseCats, incomeCats, accounts, canEdit } = useEntity();
  const [side, setSide] = useState<"expense" | "income">("expense");
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const list = (side === "expense" ? expenseCats : incomeCats).slice().sort((a, b) => a.sort - b.sort);
  const archived = accounts.filter((a) => a.type === side && a.archived);
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
        <Segmented
          label="Category type"
          value={side}
          onChange={setSide}
          options={[
            { value: "expense", label: "Expense" },
            { value: "income", label: "Income" },
          ]}
        />
        <div style={{ flex: 1 }} />
        {canEdit && (
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing("new")}>
            <Plus /> New
          </button>
        )}
      </div>
      <p className="muted" style={{ margin: "0 4px 12px", fontSize: 13 }}>
        <Sparkles size={13} style={{ display: "inline", verticalAlign: -2, color: "var(--focus)" }} /> Smart add reads each category's description. Naming the brands
        and merchants you use (“Swiggy, Zomato”) makes it pick the right one.
      </p>
      <div className="card list">
        {list.map((c) => (
          <button key={c.id} className="row" onClick={() => canEdit && setEditing(c)} disabled={!canEdit}>
            <Tile icon={c.icon} />
            <div className="row-main">
              <span className="row-title">{c.name}</span>
              <span className="row-sub">{c.hint || "No description"}</span>
            </div>
          </button>
        ))}
      </div>
      {archived.length > 0 && (
        <p className="faint" style={{ fontSize: 12.5, margin: "10px 4px" }}>
          Archived: {archived.map((a) => a.name).join(", ")}
        </p>
      )}
      <CategorySheet open={editing !== null} onClose={() => setEditing(null)} category={editing === "new" ? undefined : (editing ?? undefined)} type={side} />
    </>
  );
}

function CategorySheet({ open, onClose, category, type }: { open: boolean; onClose: () => void; category?: Account; type: "expense" | "income" }) {
  const { entity } = useEntity();
  const toast = useToast();
  const create = useEntityMutation<Record<string, unknown>>(entity.id, "/accounts");
  const update = useEntityMutation<Record<string, unknown>>(entity.id, `/accounts/${category?.id}`, "PATCH");
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [hint, setHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(category?.name ?? "");
    setIcon(category?.icon ?? "");
    setHint(category?.hint ?? "");
    setError(null);
  }, [open, category]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (category) await update.mutateAsync({ name, icon: icon || null, hint: hint || null });
      else await create.mutateAsync({ type, name, icon: icon || null, hint: hint || null });
      toast({ message: category ? "Category saved" : `${name} added` });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={category ? "Edit category" : `New ${type} category`}>
      <form className="sheet-body form" onSubmit={submit}>
        <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 10 }}>
          <label className="field">
            <span>Icon</span>
            <input className="input" value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={4} placeholder="🙂" style={{ textAlign: "center", fontSize: 18 }} />
          </label>
          <label className="field">
            <span>Name</span>
            <input className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </label>
        </div>
        <label className="field">
          <span>Description</span>
          <input className="input" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="What goes here, e.g. “Uber, Ola, metro, fuel”" maxLength={200} />
          <small>Used by smart add to recognise this category.</small>
        </label>
        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          {category && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                await update.mutateAsync({ archived: true });
                toast({ message: `${category.name} archived. Past transactions keep it.` });
                onClose();
              }}
            >
              <Archive /> Archive
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

function Members() {
  const { entity, isOwner } = useEntity();
  const me = useMe();
  const toast = useToast();
  const members = useMembers(entity.id);
  const invite = useEntityMutation<{ email: string; role: Role }, { url: string }>(entity.id, "/invites");
  const revoke = useEntityMutation<{ id: string }>(entity.id, (v) => `/invites/${v.id}`, "DELETE");
  const setRole = useEntityMutation<{ userId: string; role: Role }>(entity.id, (v) => `/members/${v.userId}`, "PATCH");
  const remove = useEntityMutation<{ userId: string }>(entity.id, (v) => `/members/${v.userId}`, "DELETE");
  const [email, setEmail] = useState("");
  const [role, setRoleValue] = useState<Role>("viewer");
  const [link, setLink] = useState<{ url: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async <T,>(fn: () => Promise<T>, ok?: string) => {
    try {
      await fn();
      if (ok) toast({ message: ok });
    } catch (err) {
      toast({ message: err instanceof ApiError ? err.message : "Something went wrong", tone: "error" });
    }
  };

  if (members.isLoading) return <Skeleton rows={3} />;
  return (
    <>
      <div className="card list">
        {members.data?.members.map((m) => (
          <div key={m.userId} className="row">
            <Avatar name={m.name} />
            <div className="row-main">
              <span className="row-title">
                {m.name} {m.userId === me.data?.user.id && <span className="faint">(you)</span>}
              </span>
              <span className="row-sub">{m.email}</span>
            </div>
            {isOwner && m.userId !== me.data?.user.id ? (
              <>
                <select
                  className="select"
                  style={{ width: 110, height: 32 }}
                  value={m.role}
                  aria-label={`Role for ${m.name}`}
                  onChange={(e) => run(() => setRole.mutateAsync({ userId: m.userId, role: e.target.value as Role }), `${m.name} is now ${e.target.value}`)}
                >
                  <option value="owner">Owner</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button
                  className="icon-btn"
                  aria-label={`Remove ${m.name}`}
                  onClick={() => confirm(`Remove ${m.name} from ${entity.name}?`) && run(() => remove.mutateAsync({ userId: m.userId }), `${m.name} removed`)}
                >
                  <UserMinus />
                </button>
              </>
            ) : (
              <span className="pill" style={{ textTransform: "capitalize" }}>
                {m.role}
              </span>
            )}
          </div>
        ))}
      </div>

      {isOwner && (
        <section className="section">
          <div className="section-head">
            <h2 className="h3">Invite someone</h2>
          </div>
          <form
            className="card card-pad form"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const r = await invite.mutateAsync({ email, role });
                setLink({ url: r.url, email });
                setEmail("");
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Couldn't create the invite.");
              }
            }}
          >
            <div className="form-row" style={{ gridTemplateColumns: "1fr 140px" }}>
              <label className="field">
                <span>Email</span>
                <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ca@firm.in" />
              </label>
              <label className="field">
                <span>Role</span>
                <select className="select" value={role} onChange={(e) => setRoleValue(e.target.value as Role)}>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </select>
              </label>
            </div>
            <small className="faint" style={{ marginTop: -6 }}>
              {ROLE_INFO[role]}.
            </small>
            {error && <p className="error-text">{error}</p>}
            <div>
              <button className="btn btn-primary" disabled={invite.isPending}>
                <Link2 /> Create invite link
              </button>
            </div>
            {link && (
              <div className="form" style={{ gap: 8 }}>
                <div className="copy-row">
                  <input className="input" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Invite link" />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={async () => {
                      await navigator.clipboard.writeText(link.url);
                      toast({ message: "Link copied" });
                    }}
                  >
                    <Copy /> Copy
                  </button>
                </div>
                <small className="faint">Send it to {link.email}. It works once, only for that email, and expires in 7 days. It won't be shown again.</small>
              </div>
            )}
          </form>
        </section>
      )}

      {isOwner && !!members.data?.invites.length && (
        <section className="section">
          <div className="section-head">
            <h2 className="h3">Pending invites</h2>
          </div>
          <div className="card list">
            {members.data.invites.map((i) => (
              <div key={i.id} className="row">
                <Avatar name={i.email} />
                <div className="row-main">
                  <span className="row-title">{i.email}</span>
                  <span className="row-sub">
                    {i.role} · invited by {i.invitedBy} · expires {relativeTime(i.expiresAt).replace(" ago", "")}
                  </span>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => run(() => revoke.mutateAsync({ id: i.id }), "Invite revoked")}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="card card-pad" style={{ display: "grid", gap: 8 }}>
          {(Object.keys(ROLE_INFO) as Role[]).map((r) => (
            <div key={r} style={{ display: "flex", gap: 12, fontSize: 13 }}>
              <b style={{ width: 56, textTransform: "capitalize", fontWeight: 600 }}>{r}</b>
              <span className="muted">{ROLE_INFO[r]}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Activity() {
  const { entity } = useEntity();
  const items = useActivity(entity.id);
  if (items.isLoading) return <Skeleton rows={6} />;
  if (!items.data?.length) return <div className="card"><Empty icon={<History />} title="No activity yet" /></div>;
  return (
    <>
      <p className="muted" style={{ margin: "0 4px 12px", fontSize: 13 }}>
        Every change is recorded here and can't be edited or deleted, including by owners.
      </p>
      <div className="card list">
        {items.data.map((i) => (
          <div key={i.id} className="row">
            <Avatar name={i.actorName ?? "?"} />
            <div className="row-main">
              <span className="row-title" style={{ whiteSpace: "normal" }}>
                {i.summary}
              </span>
              <span className="row-sub">
                {i.actorName ?? "System"} · {relativeTime(i.createdAt)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Export() {
  const { entity } = useEntity();
  const now = today();
  const fy = fiscalYear(now, entity.fyStartMonth);
  const lastFy = fiscalYear(addDays(fy.from, -1), entity.fyStartMonth);
  const presets = [
    { id: "this-month", label: "This month", ...monthRange(monthOf(now)) },
    { id: "last-month", label: "Last month", ...monthRange(addMonths(monthOf(now), -1)) },
    { id: "this-fy", label: fy.label, from: fy.from, to: fy.to },
    { id: "last-fy", label: lastFy.label, from: lastFy.from, to: lastFy.to },
  ];
  const [preset, setPreset] = useState(presets[2].id);
  const [format, setFormat] = useState<"transactions" | "journal">("transactions");
  const p = presets.find((x) => x.id === preset)!;
  const href = `/api/entities/${entity.id}/export.csv?from=${p.from}&to=${p.to}&format=${format}`;
  return (
    <div className="card card-pad form">
      <div className="field">
        <span>Period</span>
        <div className="chips" style={{ flexWrap: "wrap" }}>
          {presets.map((x) => (
            <button key={x.id} className="chip" aria-pressed={preset === x.id} onClick={() => setPreset(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <small className="num">
          {p.from} to {p.to}
        </small>
      </div>
      <div className="field">
        <span>Format</span>
        <Segmented
          label="Format"
          value={format}
          onChange={setFormat}
          options={[
            { value: "transactions", label: "Transactions" },
            { value: "journal", label: "Journal (debit/credit)" },
          ]}
        />
        <small>
          {format === "transactions"
            ? "One row per transaction. Easy to read and pivot."
            : "One row per posting with debit and credit columns, the format accountants import into Tally or Zoho."}
        </small>
      </div>
      <div>
        <a className="btn btn-primary" href={href} download>
          <Download /> Download CSV
        </a>
      </div>
    </div>
  );
}
