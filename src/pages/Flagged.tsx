import { Flag } from "lucide-react";
import { TxRow } from "../components/TxRow";
import { Empty, Skeleton } from "../components/ui";
import { useFlagged } from "../api";
import { useEntity } from "../state";

// Transactions the agent wants you to look at, each with why. Read here, discuss in chat.
export function FlaggedPage() {
  const { entity } = useEntity();
  const q = useFlagged(entity.id);
  const list = q.data ?? [];
  return (
    <main className="page">
      <div className="page-head">
        <h1 className="h1">Flagged</h1>
      </div>
      <p className="muted" style={{ fontSize: 13.5, margin: "-6px 0 16px" }}>
        Transactions I couldn't identify or that look off. Tell me what they are and I'll fix the books.
      </p>
      {q.isLoading ? (
        <Skeleton />
      ) : q.isError ? (
        <div className="card">
          <Empty icon={<Flag />} title="Couldn't load flagged transactions">
            {(q.error as Error).message}
          </Empty>
        </div>
      ) : !list.length ? (
        <div className="card">
          <Empty icon={<Flag />} title="Nothing flagged">
            Everything looks identified.
          </Empty>
        </div>
      ) : (
        <div className="card list">
          {list.map((tx) => (
            <div key={tx.id} className="flag-item">
              <TxRow tx={tx} showDate />
              <p className="flag-why">{tx.flag}</p>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
