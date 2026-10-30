import { useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, LogOut, Terminal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError, useMe, useTokens } from "../api";
import { signOut } from "../components/Shell";
import { relativeTime, useToast } from "../components/ui";

export function ProfilePage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const tokens = useTokens();
  const [name, setName] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [forAgent, setForAgent] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  useEffect(() => setName(me.data?.user.name ?? ""), [me.data?.user.name]);
  const origin = window.location.origin;

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="h1">Your account</h1>
        <div className="spacer" />
        <button className="btn btn-ghost" onClick={signOut}>
          <LogOut /> Sign out
        </button>
      </div>

      <form
        className="card card-pad form"
        onSubmit={async (e) => {
          e.preventDefault();
          await api("/me", { method: "PATCH", body: { name } });
          qc.invalidateQueries({ queryKey: ["me"] });
          toast({ message: "Name updated" });
        }}
      >
        <div className="form-row">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <label className="field">
            <span>Email</span>
            <input className="input" value={me.data?.user.email ?? ""} disabled />
          </label>
        </div>
        <div>
          <button className="btn btn-secondary" disabled={!name.trim() || name === me.data?.user.name}>
            Save
          </button>
        </div>
      </form>

      <section className="section">
        <div className="section-head">
          <h2 className="h3">Password</h2>
        </div>
        <form
          className="card card-pad form"
          onSubmit={async (e) => {
            e.preventDefault();
            setPwError(null);
            try {
              await api("/me/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
              setCurrent("");
              setNext("");
              qc.invalidateQueries({ queryKey: ["tokens"] });
              toast({ message: "Password changed. Other sessions and CLI tokens were signed out." });
            } catch (err) {
              setPwError(err instanceof ApiError ? err.message : "Couldn't change the password.");
            }
          }}
        >
          <div className="form-row">
            <label className="field">
              <span>Current password</span>
              <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </label>
            <label className="field">
              <span>New password</span>
              <input className="input" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
            </label>
          </div>
          {pwError && <p className="error-text">{pwError}</p>}
          <div>
            <button className="btn btn-secondary">
              <KeyRound /> Change password
            </button>
          </div>
        </form>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="h3">Command line</h2>
        </div>
        <div className="card card-pad form">
          <p className="muted" style={{ margin: 0 }}>
            The <code>fin</code> CLI adds and reads transactions from your terminal. Sign in once and it keeps a revocable token.
          </p>
          <div className="code">{`fin login --url ${origin}\nfin "chai 40 cash"            # smart add\nfin add 250 food "lunch"      # exact\nfin import statement.json     # bank or card statement\nfin ask "spent on food last month"`}</div>
          <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>
            Give agents their own token marked “For an agent”: everything they add says so, and you can revoke one without touching the others.
          </p>
          <form
            style={{ display: "flex", gap: 8 }}
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await api<{ token: string }>("/me/tokens", { method: "POST", body: { name: tokenName || (forAgent ? "Agent" : "Token"), agent: forAgent } });
              setNewToken(r.token);
              setTokenName("");
              qc.invalidateQueries({ queryKey: ["tokens"] });
            }}
          >
            <input className="input" value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder={forAgent ? "Agent name, e.g. Kaira" : "Token name, e.g. MacBook"} maxLength={80} />
            <label className="chip" style={{ cursor: "pointer", height: 40 }}>
              <input type="checkbox" checked={forAgent} onChange={(e) => setForAgent(e.target.checked)} /> For an agent
            </label>
            <button className="btn btn-secondary">
              <Terminal /> Create token
            </button>
          </form>
          {newToken && (
            <div className="form" style={{ gap: 6 }}>
              <div className="copy-row">
                <input className="input" readOnly value={newToken} onFocus={(e) => e.target.select()} aria-label="New token" />
                <button
                  className="btn btn-secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(newToken);
                    toast({ message: "Token copied" });
                  }}
                >
                  <Copy /> Copy
                </button>
              </div>
              <small className="faint">Shown once. Use it as FIN_TOKEN or an Authorization: Bearer header.</small>
            </div>
          )}
          {!!tokens.data?.length && (
            <div className="list" style={{ margin: "0 -18px -18px", borderTop: "1px solid var(--line)" }}>
              {tokens.data.map((t) => (
                <div key={t.id} className="row">
                  <span className="tile">
                    <Terminal />
                  </span>
                  <div className="row-main">
                    <span className="row-title">
                      {t.name ?? "Token"} {t.agent && <span className="pill">agent</span>}
                    </span>
                    <span className="row-sub">
                      Created {relativeTime(t.createdAt)} · last used {t.lastUsedAt ? relativeTime(t.lastUsedAt) : "never"}
                    </span>
                  </div>
                  <button
                    className="icon-btn"
                    aria-label={`Revoke ${t.name}`}
                    onClick={async () => {
                      await api(`/me/tokens/${t.id}`, { method: "DELETE" });
                      qc.invalidateQueries({ queryKey: ["tokens"] });
                      toast({ message: "Token revoked" });
                    }}
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
