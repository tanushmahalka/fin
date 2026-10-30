import { useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, User } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router";
import type { Role } from "../../shared/types";
import { api, ApiError, useCreateEntity, useMe, useStatus } from "../api";
import { Mark } from "../components/Mark";
import { remember } from "../state";
import { COLORS, ROLE_INFO } from "./Settings";

function AuthFrame({ title, lead, children }: { title: string; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-mark" style={{ color: "var(--text)" }}>
          <Mark size={40} />
        </div>
        <h1 className="h1">{title}</h1>
        {lead && <p className="lead">{lead}</p>}
        {children}
      </div>
    </main>
  );
}

/** Gate for signed-in pages: unauthenticated visitors go to /login (or /setup on a fresh instance). */
export function RequireAuth() {
  const me = useMe();
  const status = useStatus();
  const location = useLocation();
  if (me.isLoading) return null;
  if (me.error instanceof ApiError && me.error.status === 401) {
    if (status.data?.needsSetup) return <Navigate to="/setup" replace />;
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  if (me.error) return <AuthFrame title="Can't reach the server" lead={me.error.message}>{null}</AuthFrame>;
  return <Outlet />;
}

export function Home() {
  const me = useMe();
  if (!me.data) return null;
  const last = remember.get("entity");
  const target = me.data.entities.find((e) => e.id === last) ?? me.data.entities[0];
  return target ? <Navigate to={`/e/${target.id}/transactions`} replace /> : <Navigate to="/new" replace />;
}

export function Login() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useStatus();
  const next = new URLSearchParams(useLocation().search).get("next") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status.data?.needsSetup) return <Navigate to="/setup" replace />;
  return (
    <AuthFrame title={`Sign in to ${status.data?.appName ?? "Finance"}`} lead="Money for every entity you look after, in one place.">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api("/auth/login", { method: "POST", body: { email, password } });
            await qc.invalidateQueries({ queryKey: ["me"] });
            navigate(next.startsWith("/") ? next : "/", { replace: true });
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Couldn't sign in.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? <Loader2 className="spin" /> : "Sign in"}
        </button>
        <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>
          New here? Ask an owner for an invite link.
        </p>
      </form>
    </AuthFrame>
  );
}

export function Setup() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useStatus();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (status.data && !status.data.needsSetup) return <Navigate to="/login" replace />;
  return (
    <AuthFrame title="Set up" lead="Create the owner account. After this, people join by invite only.">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api("/auth/setup", { method: "POST", body: { name, email, password } });
            await qc.invalidateQueries();
            navigate("/new", { replace: true });
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Couldn't finish setup.");
          }
        }}
      >
        <label className="field">
          <span>Your name</span>
          <input className="input" autoFocus required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <small>At least 10 characters. A passphrase works well.</small>
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary btn-lg">Create account</button>
      </form>
    </AuthFrame>
  );
}

interface InvitePreview {
  entityName: string;
  email: string;
  role: Role;
  invitedBy: string;
  userExists: boolean;
  signedInEmail: string | null;
}

export function InviteAccept() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InvitePreview>(`/invites/${token}`).then(setPreview, (err) => setError(err instanceof ApiError ? err.message : "This invite can't be opened."));
  }, [token]);

  const accept = async (body?: object) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ entityId: string }>(`/invites/${token}/accept`, { method: "POST", body: body ?? {} });
      await qc.invalidateQueries();
      navigate(`/e/${r.entityId}/transactions`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't accept the invite.");
    } finally {
      setBusy(false);
    }
  };

  if (error && !preview) return <AuthFrame title="Invite unavailable" lead={error}>{null}</AuthFrame>;
  if (!preview) return null;
  const mismatch = preview.signedInEmail && preview.signedInEmail.toLowerCase() !== preview.email.toLowerCase();

  return (
    <AuthFrame
      title={`Join ${preview.entityName}`}
      lead={
        <>
          {preview.invitedBy} invited <b>{preview.email}</b> as {preview.role === "owner" ? "an" : "a"} {preview.role}. {ROLE_INFO[preview.role]}.
        </>
      }
    >
      {mismatch ? (
        <p className="error-text">You're signed in as {preview.signedInEmail}. Sign out, then open this link again.</p>
      ) : preview.signedInEmail ? (
        <button className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={() => accept()}>
          Accept invite
        </button>
      ) : preview.userExists ? (
        <button className="btn btn-primary btn-lg btn-block" onClick={() => navigate(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)}>
          Sign in to accept
        </button>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            accept({ name, password });
          }}
        >
          <label className="field">
            <span>Your name</span>
            <input className="input" autoFocus required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
          <label className="field">
            <span>Choose a password</span>
            <input className="input" type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <button className="btn btn-primary btn-lg" disabled={busy}>
            Create account and join
          </button>
        </form>
      )}
      {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}
    </AuthFrame>
  );
}

export function NewEntity() {
  const navigate = useNavigate();
  const me = useMe();
  const create = useCreateEntity();
  const first = !me.data?.entities.length;
  const [kind, setKind] = useState<"personal" | "business">(first ? "personal" : "business");
  const [name, setName] = useState(first ? (me.data?.user.name ?? "") : "");
  const [currency, setCurrency] = useState("INR");
  const [fy, setFy] = useState(4);
  const [color, setColor] = useState(first ? COLORS[0] : COLORS[1]);
  const [error, setError] = useState<string | null>(null);

  return (
    <AuthFrame
      title={first ? "Create your first entity" : "New entity"}
      lead="An entity is anyone whose money you keep separately: you, your company, a family member. Each has its own accounts, categories and members."
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const r = await create.mutateAsync({ name, kind, currency, fyStartMonth: fy, color });
            navigate(`/e/${r.entity.id}/transactions`, { replace: true });
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Couldn't create it.");
          }
        }}
      >
        <div className="choice-cards">
          {(
            [
              { k: "personal", icon: User, title: "Personal", sub: "You or a family member" },
              { k: "business", icon: Building2, title: "Business", sub: "A company or firm, shared with a team or CA" },
            ] as const
          ).map(({ k, icon: Icon, title, sub }) => (
            <button
              key={k}
              type="button"
              className="choice-card"
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                setColor(k === "business" ? COLORS[1] : COLORS[0]);
              }}
            >
              <Icon />
              <b className="h3">{title}</b>
              <small>{sub}</small>
            </button>
          ))}
        </div>
        <label className="field">
          <span>Name</span>
          <input className="input" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "business" ? "Acme Studio Pvt Ltd" : "Your name"} maxLength={80} />
        </label>
        <div className="form-row">
          <label className="field">
            <span>Currency</span>
            <select
              className="select"
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                setFy(e.target.value === "INR" ? 4 : 1);
              }}
            >
              {["INR", "USD", "EUR", "GBP", "AED", "SGD"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Financial year starts</span>
            <select className="select" value={fy} onChange={(e) => setFy(Number(e.target.value))}>
              {["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          <span>Colour</span>
          <div className="swatches">
            {COLORS.map((c) => (
              <button key={c} type="button" className="swatch" style={{ background: c }} aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary btn-lg" disabled={create.isPending || !name.trim()}>
          Create {kind === "business" ? "business" : "entity"}
        </button>
        {!first && (
          <button type="button" className="btn btn-ghost" onClick={() => navigate(-1)}>
            Cancel
          </button>
        )}
      </form>
    </AuthFrame>
  );
}
