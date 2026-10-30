import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

/** Calls onMore when scrolled into view: the bottom of an endless list. */
export function LoadMore({ onMore, hasMore, loading }: { onMore: () => void; hasMore: boolean; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => entries[0].isIntersecting && !loading && onMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, onMore]);
  if (!hasMore) return <p className="faint" style={{ textAlign: "center", fontSize: 12.5, margin: "22px 0" }}>That's everything.</p>;
  return (
    <div ref={ref} style={{ display: "grid", placeItems: "center", padding: 22 }} aria-busy={loading}>
      <Loader2 className="spin faint" size={18} />
    </div>
  );
}
