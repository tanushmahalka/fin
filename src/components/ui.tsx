import { X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { formatMoney } from "../../shared/money";

// ---- Sheet ------------------------------------------------------------------

/**
 * Bottom sheet on phones, centred dialog on larger screens. Closes on Escape
 * and backdrop click, traps focus, and restores focus to the opener.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  head,
  wide,
  className = "",
  label,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  head?: ReactNode;
  wide?: boolean;
  className?: string;
  label?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const t = setTimeout(() => {
        setMounted(false);
        setClosing(false);
        (opener.current as HTMLElement | null)?.focus?.();
      }, 190);
      return () => clearTimeout(t);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!mounted || closing) return;
    const el = panel.current;
    const target = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el;
    target?.focus({ preventScroll: true });
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted, closing]);

  if (!mounted) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
    if (e.key === "Tab" && panel.current) {
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div className="overlay" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKeyDown}>
      <div
        ref={panel}
        className={`sheet ${wide ? "wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        tabIndex={-1}
      >
        <div className="grabber" />
        {head ?? (
          <div className="sheet-head">
            <h2 className="h2">{title}</h2>
            <div className="spacer" />
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X />
            </button>
          </div>
        )}
        {children}
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---- Segmented control --------------------------------------------------------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  block,
  label,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  block?: boolean;
  label: string;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = (index + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
    onChange(options[next].value);
  };
  return (
    <div className={`segmented ${block ? "block" : ""}`} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      <span
        className="thumb"
        style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${index * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- Toasts -----------------------------------------------------------------

interface ToastItem {
  id: number;
  message: string;
  tone?: "error";
  action?: { label: string; onClick: () => void };
}
const ToastContext = createContext<(t: Omit<ToastItem, "id">) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.action ? 6000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone ?? ""}`}>
            <span>{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.onClick();
                  setItems((xs) => xs.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---- Small pieces -------------------------------------------------------------

export function Money({
  value,
  currency,
  tone,
  sign = "auto",
  compact,
  className = "",
}: {
  value: number;
  currency: string;
  tone?: "income" | "expense" | "neutral" | "auto";
  sign?: "auto" | "always" | "never";
  compact?: boolean;
  className?: string;
}) {
  const cls = tone === "auto" ? (value > 0 ? "income" : value < 0 ? "expense" : "") : (tone ?? "");
  return <span className={`num ${cls} ${className}`}>{formatMoney(value, { currency, sign, compact })}</span>;
}

export function Tile({ icon, color }: { icon: ReactNode; color?: string }) {
  return (
    <span className="tile" style={color ? { background: `color-mix(in srgb, ${color} 14%, transparent)` } : undefined}>
      {icon || "•"}
    </span>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="tile">{icon}</span>
      <h3 className="h3" style={{ color: "var(--text)" }}>
        {title}
      </h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return <span className="avatar">{initials || "?"}</span>;
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="row">
          <span className="skeleton" style={{ width: 36, height: 36, borderRadius: 11 }} />
          <div className="row-main" style={{ gap: 6 }}>
            <span className="skeleton" style={{ width: `${40 + ((i * 17) % 30)}%`, height: 12 }} />
            <span className="skeleton" style={{ width: "22%", height: 10 }} />
          </div>
          <span className="skeleton" style={{ width: 64, height: 12 }} />
        </div>
      ))}
    </div>
  );
}

/** Closes a popover on outside click or Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
