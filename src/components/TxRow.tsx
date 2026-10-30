import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CircleCheck, Scale } from "lucide-react";
import { relativeDay } from "../../shared/dates";
import { formatMoney } from "../../shared/money";
import type { Transaction } from "../../shared/types";
import { useEntity } from "../state";
import { Tile } from "./ui";

/** One transaction line: icon, what, where from and with whom, amount. */
export function TxRow({
  tx,
  onClick,
  showDate,
  delta,
  running,
  hideContact,
}: {
  tx: Transaction;
  onClick?: () => void;
  showDate?: boolean;
  /** Ledger view: the effect on one account and the balance after it. */
  delta?: number;
  running?: number;
  /** On a contact's own page their name is implied. */
  hideContact?: boolean;
}) {
  const { byId, contactsById, entity } = useEntity();
  const name = (id: string | null) => (id ? (byId.get(id)?.name ?? "—") : "—");
  const who = (id: string | null | undefined) => (id ? (contactsById.get(id)?.name ?? "someone") : null);
  const fmt = (n: number, sign: "auto" | "always" = "auto") => formatMoney(n, { currency: entity.currency, sign });

  let icon: React.ReactNode;
  let title: string;
  let sub: (string | null | false | undefined)[];
  let amount: React.ReactNode;
  const contact = who(tx.contactId);

  if (tx.kind === "gave" || tx.kind === "got") {
    const gave = tx.kind === "gave";
    icon = gave ? <ArrowUpRight /> : <ArrowDownLeft />;
    title = hideContact ? (gave ? "You gave" : "You got") : gave ? `You gave ${contact}` : `You got from ${contact}`;
    sub = [tx.note, name(tx.accountId)];
    amount = <span className="neutral">{fmt(gave ? -tx.amount : tx.amount, "always")}</span>;
  } else if (tx.kind === "transfer") {
    icon = <ArrowLeftRight />;
    title = tx.note || "Transfer";
    sub = [`${name(tx.accountId)} → ${name(tx.toAccountId)}`];
    amount = <span className="neutral">{fmt(tx.amount)}</span>;
  } else if (tx.kind === "opening" || tx.kind === "adjustment") {
    icon = <Scale />;
    title = tx.kind === "opening" ? "Opening balance" : "Balance adjustment";
    sub = [name(tx.accountId)];
    amount = <span className="neutral">{fmt(tx.amount, "always")}</span>;
  } else {
    const cat = tx.categoryId ? byId.get(tx.categoryId) : undefined;
    icon = cat?.icon ?? "•";
    title = tx.note || (!hideContact && contact) || cat?.name || "Uncategorised";
    const contactShown = hideContact || !contact || title.toLowerCase().includes(contact.toLowerCase());
    sub = [
      !contactShown && contact,
      title !== cat?.name && cat?.name,
      tx.paidBy ? `paid by ${who(tx.paidBy)}` : name(tx.accountId),
      tx.share && `${who(tx.share.contactId)} owes ${fmt(tx.share.amount)}`,
    ];
    amount =
      tx.kind === "income" ? <span className="income">{fmt(tx.amount, "always")}</span> : <span className="expense">{fmt(-tx.amount)}</span>;
  }
  const line = [showDate ? relativeDay(tx.date) : null, ...sub].filter(Boolean).join(" · ");

  const content = (
    <>
      <Tile icon={icon} />
      <div className="row-main">
        <span className="row-title">
          {title}
          {tx.reconciled && <CircleCheck className="tick" aria-label="Confirmed by statement" />}
          {tx.flag && <span className="review-dot" title={tx.flag} />}
        </span>
        <span className="row-sub">{line}</span>
      </div>
      <div className="row-amount num">
        {delta !== undefined ? <span className={delta >= 0 ? "income" : "expense"}>{fmt(delta, "always")}</span> : amount}
        {running !== undefined && <small>{fmt(running)}</small>}
      </div>
    </>
  );
  return onClick ? (
    <button className="row" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="row">{content}</div>
  );
}
