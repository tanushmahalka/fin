import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { addMonths, monthLabel, MONTH_RE, monthOf, today } from "../../shared/dates";

/** The month in view lives in the URL (?m=2026-10), so back/forward and links work. */
export function useMonthParam(): [string, (m: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("m");
  const month = raw && MONTH_RE.test(raw) ? raw : monthOf(today());
  const set = (m: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (m === monthOf(today())) next.delete("m");
        else next.set("m", m);
        return next;
      },
      { replace: true },
    );
  return [month, set];
}

export function MonthNav({ month, onChange, label }: { month: string; onChange: (m: string) => void; label?: string }) {
  // ← / → step through months when focus isn't in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, [role=dialog], [role=radiogroup]")) return;
      if (e.key === "ArrowLeft") onChange(addMonths(month, -1));
      if (e.key === "ArrowRight") onChange(addMonths(month, 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [month, onChange]);

  const isCurrent = month === monthOf(today());
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <button className="icon-btn" onClick={() => onChange(addMonths(month, -1))} aria-label="Previous month">
        <ChevronLeft />
      </button>
      <button
        className="h1"
        style={{ padding: "0 4px", minWidth: 0, whiteSpace: "nowrap" }}
        onClick={() => onChange(monthOf(today()))}
        title={isCurrent ? undefined : "Back to this month"}
      >
        {label ?? monthLabel(month)}
      </button>
      <button className="icon-btn" onClick={() => onChange(addMonths(month, 1))} aria-label="Next month">
        <ChevronRight />
      </button>
    </div>
  );
}
