import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { monthOf } from "../../shared/dates";
import { formatMoney } from "../../shared/money";
import type { AskResult } from "../../shared/types";
import { ApiError, assist } from "../api";
import { type ComposerOptions, useEntity } from "../state";
import { TxRow } from "./TxRow";
import { Sheet } from "./ui";

const EXAMPLES = {
  personal: ["chai 40 cash", "lent rahul 2000", "spent on food last month", "who owes me?", "net worth"],
  business: ["meta ads 25000", "aws 3,450 company card", "spent on ads this FY", "who do we owe?", "current account balance"],
};

/**
 * One box for both jobs: "chai 40" becomes a draft transaction, "spent on food
 * last month?" becomes an answer. Jev decides which; code computes the numbers.
 */
export function AskPalette({
  open,
  initialText,
  onClose,
  onRecord,
}: {
  open: boolean;
  initialText?: string;
  onClose: () => void;
  onRecord: (opts: ComposerOptions) => void;
}) {
  const { entity, canEdit, contactsById } = useEntity();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setText(initialText ?? "");
    setAnswer(null);
    setError(null);
  }, [open, initialText]);

  const run = async (value = text) => {
    const q = value.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const r = await assist(entity.id, q, canEdit ? "auto" : "ask");
      if (r.mode === "record" && r.parse) onRecord({ parse: r.parse, smartText: q });
      else if (r.ask) setAnswer(r.ask);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const viewAll = () => {
    if (!answer) return;
    const params = new URLSearchParams();
    if (answer.categoryId) params.set("category", answer.categoryId);
    if (answer.accountId) params.set("account", answer.accountId);
    if (answer.contactId) params.set("contact", answer.contactId);
    if (answer.period && answer.period.from.slice(0, 7) === answer.period.to.slice(0, 7)) params.set("m", monthOf(answer.period.from));
    onClose();
    navigate(`/e/${entity.id}/transactions?${params}`);
  };

  return (
    <Sheet open={open} onClose={onClose} label="Ask or add" className="palette" head={<span />}>
      <form
        className="smart"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        {busy ? <Loader2 className="spin spark" /> : <Sparkles className="spark" />}
        <input
          ref={input}
          data-autofocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={canEdit ? "Add “chai 40 cash” or ask “spent on food last month?”" : "Ask “spent on ads last month?”"}
          aria-label="Ask or add"
          enterKeyHint="go"
          autoComplete="off"
        />
        {text && (
          <button type="submit" className="icon-btn" aria-label="Go" disabled={busy}>
            <ArrowRight />
          </button>
        )}
      </form>

      {error && (
        <div className="answer">
          <p className="error-text" style={{ margin: 0 }}>
            {error}
          </p>
        </div>
      )}

      {answer && (
        <div className="answer">
          <div className="answer-text">{answer.answer}</div>
          {!!answer.balances?.length && (
            <div className="card list" style={{ marginTop: 14 }}>
              {answer.balances.map((b) => {
                const c = contactsById.get(b.contactId);
                return (
                  <button
                    key={b.contactId}
                    className="row"
                    onClick={() => {
                      onClose();
                      navigate(`/e/${entity.id}/contacts/${b.contactId}`);
                    }}
                  >
                    <div className="row-main">
                      <span className="row-title">{c?.name ?? "Someone"}</span>
                    </div>
                    <span className={`num row-amount ${b.balance > 0 ? "income" : "expense"}`}>
                      {b.balance > 0 ? "owes you " : "you owe "}
                      {formatMoney(Math.abs(b.balance), { currency: entity.currency })}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {answer.transactions.length > 0 && (
            <div className="card list" style={{ marginTop: 14, maxHeight: 320, overflowY: "auto" }}>
              {answer.transactions.map((t) => (
                <TxRow key={t.id} tx={t} showDate onClick={viewAll} />
              ))}
            </div>
          )}
          {(answer.categoryId || answer.accountId || answer.transactions.length > 0) && (
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 10, marginLeft: -10 }} onClick={viewAll}>
              Open in Transactions <ArrowRight />
            </button>
          )}
        </div>
      )}

      {!answer && !busy && !error && (
        <div className="examples">
          {(canEdit ? EXAMPLES[entity.kind] : EXAMPLES[entity.kind].filter((e) => /\b(spent|balance|worth|last|owe)\b/.test(e))).map((ex) => (
            <button
              key={ex}
              className="chip"
              onClick={() => {
                setText(ex);
                run(ex);
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
