import { Plus, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { Contact, ContactKind } from "../../shared/types";
import { useEntity } from "../state";
import { useDismiss } from "./ui";

/** An existing contact, or a new one that's created when the transaction saves. */
export type ContactValue = { id: string } | { name: string; kind: ContactKind } | null;

export function ContactChip({ contact, size = 22 }: { contact: Pick<Contact, "name" | "kind">; size?: number }) {
  const initials = contact.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span className={`contact-mark ${contact.kind}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {initials}
    </span>
  );
}

function matches(c: Contact, q: string) {
  const hay = `${c.name},${c.aliases ?? ""}`.toLowerCase();
  return hay.split(/[,\s]+/).some((w) => w.startsWith(q)) || hay.includes(q);
}

/** Type to find a contact, or create one. Most-used contacts show first. */
export function ContactPicker({
  value,
  onChange,
  placeholder = "Add who it was with",
  defaultKind = "business",
  disabled,
  only,
}: {
  value: ContactValue;
  onChange: (v: ContactValue) => void;
  placeholder?: string;
  defaultKind?: ContactKind;
  disabled?: boolean;
  /** Limit to people (for splits and IOUs). */
  only?: ContactKind;
}) {
  const { contacts, contactsById } = useEntity();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  const q = query.trim().toLowerCase();
  const list = useMemo(() => {
    const pool = only ? contacts.filter((c) => c.kind === only) : contacts;
    return (q ? pool.filter((c) => matches(c, q)) : pool).slice(0, 6);
  }, [contacts, q, only]);
  const exact = list.some((c) => c.name.toLowerCase() === q);
  const options: ({ kind: "existing"; contact: Contact } | { kind: "new"; name: string })[] = [
    ...list.map((contact) => ({ kind: "existing" as const, contact })),
    ...(q && !exact ? [{ kind: "new" as const, name: query.trim().replace(/\b[a-z]/g, (ch) => ch.toUpperCase()) }] : []),
  ];

  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    onChange(o.kind === "existing" ? { id: o.contact.id } : { name: o.name, kind: defaultKind });
    setQuery("");
    setOpen(false);
  };

  if (value) {
    const known = "id" in value ? contactsById.get(value.id) : undefined;
    const shown = known ?? ("name" in value ? { name: value.name, kind: value.kind } : null);
    if (shown)
      return (
        <div className="chips">
          <span className="chip" aria-pressed="true" style={{ paddingRight: 4 }}>
            <ContactChip contact={shown} size={20} />
            {shown.name}
            {!known && <span className="chip-sub">new</span>}
            {!disabled && (
              <button type="button" className="chip-x" aria-label={`Remove ${shown.name}`} onClick={() => onChange(null)}>
                <X size={14} />
              </button>
            )}
          </span>
        </div>
      );
  }

  return (
    <div className="menu-anchor" ref={ref}>
      <input
        className="input"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && open && options.length) {
            e.preventDefault();
            e.stopPropagation();
            choose(active);
          } else if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && options.length > 0 && (
        <div className="menu" role="listbox" style={{ width: "100%", top: "calc(100% + 4px)" }}>
          {options.map((o, i) => (
            <button
              key={o.kind === "existing" ? o.contact.id : "new"}
              type="button"
              role="option"
              aria-selected={i === active}
              className="menu-item"
              style={i === active ? { background: "var(--surface-2)" } : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              {o.kind === "existing" ? (
                <>
                  <ContactChip contact={o.contact} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{o.contact.name}</span>
                  {o.contact.balance !== 0 && (
                    <span className={`num ${o.contact.balance > 0 ? "income" : "expense"}`} style={{ fontSize: 12 }}>
                      {o.contact.balance > 0 ? "owes you" : "you owe"}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <Plus /> Add “{o.name}”
                </>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
