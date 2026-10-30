import { Bot, Check, Terminal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api, ApiError, useMe } from "../api";
import { Mark } from "../components/Mark";

/** Approve a `fin login` from the browser you're already signed in to. */
export function DevicePage() {
  const [params] = useSearchParams();
  const me = useMe();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [info, setInfo] = useState<{ name: string; agent: boolean; status: string } | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const look = async (c = code) => {
    setError(null);
    setInfo(null);
    try {
      setInfo(await api(`/auth/device/${encodeURIComponent(c.trim().toUpperCase())}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check that code.");
    }
  };
  useEffect(() => {
    if (params.get("code")) look(params.get("code")!);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (approve: boolean) => {
    try {
      await api(`/auth/device/${encodeURIComponent(code.trim().toUpperCase())}`, { method: "POST", body: { approve } });
      setDone(approve ? "approved" : "denied");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that.");
    }
  };

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-mark" style={{ color: "var(--text)" }}>
          <Mark size={40} />
        </div>
        {done ? (
          <>
            <h1 className="h1">{done === "approved" ? "Signed in" : "Request denied"}</h1>
            <p className="lead">{done === "approved" ? "You can close this tab. The command line has its token." : "Nothing was signed in."}</p>
          </>
        ) : info && info.status === "pending" ? (
          <>
            <h1 className="h1">Allow {info.name}?</h1>
            <p className="lead">
              {info.agent ? <Bot size={15} style={{ display: "inline", verticalAlign: -2 }} /> : <Terminal size={15} style={{ display: "inline", verticalAlign: -2 }} />}{" "}
              {info.agent ? "An agent" : "The fin command line"} wants to act as <b>{me.data?.user.name}</b>, with your access to every entity.
              {info.agent ? " Everything it adds will say it came from this agent." : ""} You can revoke it any time under Your account.
            </p>
            <p className="num" style={{ fontSize: 22, fontWeight: 600, letterSpacing: "0.08em", margin: "0 0 20px" }}>
              {code.toUpperCase()}
            </p>
            <p className="faint" style={{ fontSize: 12.5, marginTop: -12 }}>
              Check this matches the code in your terminal.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={() => decide(true)}>
                <Check /> Allow
              </button>
              <button className="btn btn-secondary btn-lg" onClick={() => decide(false)}>
                <X /> Deny
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="h1">Connect the command line</h1>
            <p className="lead">Enter the code shown by fin login.</p>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                look();
              }}
            >
              <input className="input num" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH" autoFocus style={{ fontSize: 18, letterSpacing: "0.08em" }} />
              <button className="btn btn-primary btn-lg">Continue</button>
            </form>
            {info && info.status !== "pending" && <p className="faint">This code was already used.</p>}
          </>
        )}
        {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}
      </div>
    </main>
  );
}
