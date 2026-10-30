import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, FileText, Plus, Undo2, X } from "lucide-react";
import { useState } from "react";
import { relativeDay } from "../../shared/dates";
import { formatMoney } from "../../shared/money";
import type { ReviewItem } from "../../shared/types";
import { api, ApiError, useImportPlan, useImports, useReview } from "../api";
import { TxRow } from "../components/TxRow";
import { Empty, relativeTime, Skeleton, useToast } from "../components/ui";
import { useActions, useEntity } from "../state";

/**
 * Statements are read by an agent (a generative model) into JSON and sent with
 * `fin import`. This page is the human half: decide what the importer wasn't
 * sure about, check its guesses, and undo an import as a whole.
 */
export function ImportsPage() {
  const { entity, byId, canEdit } = useEntity();
  const review = useReview(entity.id);
  const imports = useImports(entity.id);
  const [open, setOpen] = useState<string | null>(null);
  const lines = review.data?.lines ?? [];
  const guesses = review.data?.transactions ?? [];
  const { compose } = useActions();

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="h1">Imports</h1>
      </div>

      {review.isLoading ? (
        <Skeleton rows={3} />
      ) : lines.length + guesses.length === 0 ? (
        <div className="card">
          <Empty icon={<CheckCircle2 />} title="Nothing to review">
            Every imported line is matched or recorded.
          </Empty>
        </div>
      ) : (
        <>
          {lines.length > 0 && (
            <section>
              <div className="section-head">
                <h2 className="h3">Needs you</h2>
                <span className="pill">{lines.length}</span>
              </div>
              <div className="card list">
                {lines.map((l) => (
                  <ReviewLine key={l.evidenceId} item={l} />
                ))}
              </div>
            </section>
          )}
          {guesses.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2 className="h3">Check these guesses</h2>
                <span className="pill">{guesses.length}</span>
                <div className="spacer" />
                <span className="faint" style={{ fontSize: 12.5 }}>
                  Open one and save to confirm it
                </span>
              </div>
              <div className="card list">
                {guesses.map((t) => (
                  <TxRow key={t.id} tx={t} showDate onClick={() => compose({ tx: t })} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <section className="section">
        <div className="section-head">
          <h2 className="h3">Statements</h2>
        </div>
        {imports.data?.length ? (
          <div className="card list">
            {imports.data.map((i) => (
              <div key={i.id}>
                <button className="row" onClick={() => setOpen(open === i.id ? null : i.id)} style={i.status === "undone" ? { opacity: 0.5 } : undefined}>
                  <span className="tile">
                    <FileText />
                  </span>
                  <div className="row-main">
                    <span className="row-title">
                      {byId.get(i.accountId)?.name ?? "Account"} · {i.period.from} to {i.period.to}
                    </span>
                    <span className="row-sub">
                      {i.status === "undone" ? "Undone · " : ""}
                      {i.created} new · {i.matched} matched{i.review ? ` · ${i.review} to review` : ""} · {i.by} · {relativeTime(i.createdAt)}
                    </span>
                  </div>
                  <ChevronDown size={16} className="faint" style={{ transform: open === i.id ? "rotate(180deg)" : undefined }} />
                </button>
                {open === i.id && <ImportDetail importId={i.id} canUndo={canEdit && i.status === "committed"} onUndone={() => setOpen(null)} />}
              </div>
            ))}
          </div>
        ) : (
          <div className="card card-pad">
            <p className="muted" style={{ margin: "0 0 12px" }}>
              Hand a bank or card statement (PDF, CSV or Excel) to your agent and ask it to import it. It reads the statement into JSON, then:
            </p>
            <div className="code">{`fin import --schema              # the format to fill in
fin import statement.json        # preview: matched, new, needs you
fin import statement.json --yes  # commit`}</div>
            <p className="faint" style={{ fontSize: 12.5, margin: "12px 0 0" }}>
              Every line's running balance is checked, so a misread digit stops the import. The statement must match one account's last 4 digits (set them under Balance
              sheet → account → edit).
            </p>
          </div>
        )}
      </section>
    </main>
  );
}

function ReviewLine({ item }: { item: ReviewItem }) {
  const { entity, byId, canEdit } = useEntity();
  const { compose } = useActions();
  const toast = useToast();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const fmt = (n: number) => formatMoney(n, { currency: entity.currency, sign: "always" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["e", entity.id] });
  const out = item.amount < 0;

  const link = async (transactionId: string) => {
    setError(null);
    try {
      await api(`/entities/${entity.id}/evidence/${item.evidenceId}/link`, { method: "POST", body: { transactionId } });
      await refresh();
      toast({ message: "Matched" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't match.");
    }
  };

  return (
    <div className="row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 10, paddingTop: 12, paddingBottom: 12 }}>
      <div style={{ display: "flex", gap: 12, width: "100%", alignItems: "center" }}>
        <span className="tile">
          <FileText />
        </span>
        <div className="row-main">
          <span className="row-title" style={{ whiteSpace: "normal" }}>
            {item.description}
          </span>
          <span className="row-sub">
            {relativeDay(item.date)} · {byId.get(item.accountId)?.name} · {item.reason}
          </span>
        </div>
        <span className={`row-amount num ${out ? "expense" : "income"}`}>{fmt(item.amount)}</span>
      </div>
      {item.candidates.length > 0 && (
        <div className="card list" style={{ width: "100%", boxShadow: "inset 0 0 0 1px var(--line)" }}>
          {item.candidates.map((t) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TxRow tx={t} showDate onClick={() => compose({ tx: t })} />
              </div>
              {canEdit && (
                <button className="btn btn-secondary btn-sm" style={{ marginRight: 12 }} onClick={() => link(t.id)}>
                  This one
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {canEdit && (
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              compose({
                kind: out ? "expense" : "income",
                evidenceId: item.evidenceId,
                draft: { amount: Math.abs(item.amount), date: item.date, accountId: item.accountId, note: item.description.slice(0, 80) },
              })
            }
          >
            <Plus /> Add as new
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await api(`/entities/${entity.id}/evidence/${item.evidenceId}/dismiss`, { method: "POST" });
              await refresh();
              toast({ message: "Ignored" });
            }}
          >
            <X /> Ignore
          </button>
        </div>
      )}
      {error && <p className="error-text" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}

function ImportDetail({ importId, canUndo, onUndone }: { importId: string; canUndo: boolean; onUndone: () => void }) {
  const { entity } = useEntity();
  const plan = useImportPlan(entity.id, importId);
  const qc = useQueryClient();
  const toast = useToast();
  if (!plan.data) return <div style={{ padding: 16 }}><Skeleton rows={2} /></div>;
  const p = plan.data;
  const label = { link: "matched", new: "new", pending: "needs you", duplicate: "seen before", reversal: "reversal" };
  return (
    <div style={{ padding: "4px 16px 16px", borderTop: "1px solid var(--line)" }}>
      <div className="muted num" style={{ fontSize: 12.5, margin: "10px 0" }}>
        Opening {formatMoney(p.opening, { currency: entity.currency })} → closing {formatMoney(p.closing, { currency: entity.currency })} · balance chain verified ✓
      </div>
      {p.warnings.map((w) => (
        <p key={w} className="banner" style={{ marginTop: 0, marginBottom: 8 }}>
          {w}
        </p>
      ))}
      <div style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
        {p.lines.map((l) => (
          <div key={l.lineNo} style={{ display: "grid", gridTemplateColumns: "84px 1fr 96px 90px", gap: 8 }} className="num">
            <span className="faint">{l.date}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.description}</span>
            <span className={l.amount < 0 ? "expense" : "income"} style={{ textAlign: "right" }}>
              {formatMoney(l.amount, { currency: entity.currency, sign: "always" })}
            </span>
            <span className="faint">{label[l.action]}</span>
          </div>
        ))}
      </div>
      {canUndo && (
        <button
          className="btn btn-danger btn-sm"
          style={{ marginTop: 12, marginLeft: -10 }}
          onClick={async () => {
            if (!confirm("Undo this import? Transactions it created are removed (even if you edited them); matches are unlinked.")) return;
            await api(`/entities/${entity.id}/imports/${importId}/undo`, { method: "POST" });
            await qc.invalidateQueries({ queryKey: ["e", entity.id] });
            toast({ message: "Import undone" });
            onUndone();
          }}
        >
          <Undo2 /> Undo import
        </button>
      )}
    </div>
  );
}
