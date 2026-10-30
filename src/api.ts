import { QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SubSuggestion } from "../shared/subscriptions";
import type {
  Account,
  ActivityItem,
  ApiToken,
  AssistResult,
  Budget,
  Contact,
  EmiPlan,
  Subscription,
  ImportPlan,
  ReviewItem,
  Entity,
  Invite,
  LedgerRow,
  Me,
  Member,
  MonthTotal,
  Role,
  Summary,
  Transaction,
  TransactionInput,
} from "../shared/types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { message: string; code: string } } | null;
    throw new ApiError(res.status, data?.error?.message ?? res.statusText, data?.error?.code);
  }
  return res.json() as Promise<T>;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

// ---- Queries ----------------------------------------------------------------

export const useStatus = () =>
  useQuery({ queryKey: ["status"], queryFn: () => api<{ needsSetup: boolean; appName: string }>("/auth/status"), staleTime: 60_000 });

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me"), staleTime: 60_000 });

export const useAccounts = (entityId: string, asOf?: string) =>
  useQuery({
    queryKey: ["e", entityId, "accounts", asOf ?? null],
    queryFn: () => api<{ accounts: Account[] }>(`/entities/${entityId}/accounts${qs({ asOf })}`).then((r) => r.accounts),
    placeholderData: (prev) => prev,
  });

export const useFlagged = (entityId: string) =>
  useQuery({
    queryKey: ["e", entityId, "flagged"],
    queryFn: () => api<{ transactions: Transaction[] }>(`/entities/${entityId}/transactions?flagged=1&limit=500`).then((r) => r.transactions),
  });

export const useSubscriptions = (entityId: string) =>
  useQuery({
    queryKey: ["e", entityId, "subscriptions"],
    queryFn: () => api<{ subscriptions: Subscription[] }>(`/entities/${entityId}/subscriptions`).then((r) => r.subscriptions),
    placeholderData: (prev) => prev,
  });

export const useSubSuggestions = (entityId: string) =>
  useQuery({
    queryKey: ["e", entityId, "subscriptions", "suggestions"],
    queryFn: () => api<{ suggestions: SubSuggestion[] }>(`/entities/${entityId}/subscriptions/suggestions`).then((r) => r.suggestions),
  });

export const useEmis = (entityId: string, asOf?: string) =>
  useQuery({
    queryKey: ["e", entityId, "emis", asOf ?? null],
    queryFn: () => api<{ plans: EmiPlan[] }>(`/entities/${entityId}/emis${qs({ asOf })}`).then((r) => r.plans),
    placeholderData: (prev) => prev,
  });

export const useContacts = (entityId: string, asOf?: string) =>
  useQuery({
    queryKey: ["e", entityId, "contacts", asOf ?? null],
    queryFn: () => api<{ contacts: Contact[] }>(`/entities/${entityId}/contacts${qs({ asOf })}`).then((r) => r.contacts),
    placeholderData: (prev) => prev,
  });

export type StatementRow = Transaction & { owed: number; running: number };
export const useContactStatement = (entityId: string, contactId: string) =>
  useQuery({
    queryKey: ["e", entityId, "contact", contactId],
    queryFn: () => api<{ contact: Contact; rows: StatementRow[] }>(`/entities/${entityId}/contacts/${contactId}/statement`),
  });

export interface ImportSummary {
  id: string;
  accountId: string;
  status: "committed" | "undone";
  period: { from: string; to: string };
  lines: number;
  created: number;
  matched: number;
  review: number;
  createdAt: number;
  by: string;
}

export const useImports = (entityId: string) =>
  useQuery({
    queryKey: ["e", entityId, "imports"],
    queryFn: () => api<{ imports: ImportSummary[] }>(`/entities/${entityId}/imports`).then((r) => r.imports),
  });

export const useImportPlan = (entityId: string, importId: string | null) =>
  useQuery({
    queryKey: ["e", entityId, "import", importId],
    queryFn: () => api<{ plan: ImportPlan & { related: Record<string, Transaction> } }>(`/entities/${entityId}/imports/${importId}`).then((r) => r.plan),
    enabled: !!importId,
  });

export const useReview = (entityId: string) =>
  useQuery({
    queryKey: ["e", entityId, "review"],
    queryFn: () => api<{ lines: ReviewItem[]; transactions: Transaction[] }>(`/entities/${entityId}/review`),
  });

export interface ContactSuggestion {
  contactId: string | null;
  name: string;
  kind: "person" | "business";
  transactionIds: string[];
  examples: string[];
  probability: number;
}

export interface TxFilter {
  from?: string;
  to?: string;
  q?: string;
  accountId?: string;
  categoryId?: string;
  contactId?: string;
  limit?: number;
}

export const useTransactions = (entityId: string, filter: TxFilter, enabled = true) =>
  useQuery({
    queryKey: ["e", entityId, "transactions", filter],
    queryFn: () => api<{ transactions: Transaction[] }>(`/entities/${entityId}/transactions${qs({ ...filter })}`).then((r) => r.transactions),
    enabled,
    placeholderData: (prev) => prev,
  });

/** Every transaction newest first, a page at a time (keyset cursor), for endless scrolling. */
export const useInfiniteTransactions = (entityId: string, filter: TxFilter, enabled = true) =>
  useInfiniteQuery({
    queryKey: ["e", entityId, "transactions", "infinite", filter],
    queryFn: ({ pageParam }) =>
      api<{ transactions: Transaction[]; nextCursor: string | null }>(`/entities/${entityId}/transactions${qs({ ...filter, limit: filter.limit ?? 120, cursor: pageParam })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });

export const useInfiniteLedger = (entityId: string, accountId: string) =>
  useInfiniteQuery({
    queryKey: ["e", entityId, "ledger", accountId, "infinite"],
    queryFn: ({ pageParam }) => api<{ account: Account; rows: LedgerRow[]; nextOffset: number | null }>(`/entities/${entityId}/accounts/${accountId}/ledger${qs({ limit: 150, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  });

export const useSummary = (entityId: string, from: string, to: string) =>
  useQuery({
    queryKey: ["e", entityId, "summary", from, to],
    queryFn: () => api<Summary>(`/entities/${entityId}/summary${qs({ from, to })}`),
    placeholderData: (prev) => prev,
  });

export const useMonthly = (entityId: string, from: string, to: string) =>
  useQuery({
    queryKey: ["e", entityId, "monthly", from, to],
    queryFn: () => api<{ months: MonthTotal[] }>(`/entities/${entityId}/monthly${qs({ from, to })}`).then((r) => r.months),
    placeholderData: (prev) => prev,
  });

export const useBudgets = (entityId: string) =>
  useQuery({
    queryKey: ["e", entityId, "budgets"],
    queryFn: () => api<{ budgets: Budget[] }>(`/entities/${entityId}/budgets`).then((r) => r.budgets),
  });

export const useLedger = (entityId: string, accountId: string) =>
  useQuery({
    queryKey: ["e", entityId, "ledger", accountId],
    queryFn: () => api<{ account: Account; rows: LedgerRow[] }>(`/entities/${entityId}/accounts/${accountId}/ledger`),
  });

export const useMembers = (entityId: string) =>
  useQuery({
    queryKey: ["e", entityId, "members"],
    queryFn: () => api<{ members: Member[]; invites: Invite[] }>(`/entities/${entityId}/members`),
  });

export const useActivity = (entityId: string) =>
  useQuery({
    queryKey: ["e", entityId, "activity"],
    queryFn: () => api<{ items: ActivityItem[] }>(`/entities/${entityId}/activity?limit=200`).then((r) => r.items),
  });

export const useTokens = () =>
  useQuery({ queryKey: ["tokens"], queryFn: () => api<{ tokens: ApiToken[] }>("/me/tokens").then((r) => r.tokens) });

export const assist = (entityId: string, text: string, mode: "auto" | "record" | "ask", kind?: string, signal?: AbortSignal) =>
  fetch(`/api/entities/${entityId}/assist${qs({ text, mode, kind })}`, { credentials: "same-origin", signal }).then(async (res) => {
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { message: string } } | null;
      throw new ApiError(res.status, data?.error?.message ?? res.statusText);
    }
    return res.json() as Promise<AssistResult>;
  });

// ---- Mutations ----------------------------------------------------------------

/** Anything that moves money changes balances, reports and the activity feed. */
function useInvalidateEntity(entityId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["e", entityId] });
}

export function useSaveTransaction(entityId: string) {
  const invalidate = useInvalidateEntity(entityId);
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: TransactionInput }) =>
      id
        ? api<{ transaction: Transaction }>(`/entities/${entityId}/transactions/${id}`, { method: "PATCH", body: input })
        : api<{ transaction: Transaction }>(`/entities/${entityId}/transactions`, { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteTransaction(entityId: string) {
  const invalidate = useInvalidateEntity(entityId);
  return useMutation({
    mutationFn: (id: string) => api(`/entities/${entityId}/transactions/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useRestoreTransaction(entityId: string) {
  const invalidate = useInvalidateEntity(entityId);
  return useMutation({
    mutationFn: (id: string) => api(`/entities/${entityId}/transactions/${id}/restore`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useEntityMutation<TBody, TResult = unknown>(entityId: string, path: string | ((v: TBody) => string), method = "POST") {
  const invalidate = useInvalidateEntity(entityId);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) =>
      api<TResult>(`/entities/${entityId}${typeof path === "function" ? path(body) : path}`, {
        method,
        body: method === "DELETE" ? undefined : body,
      }),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

export function useCreateEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; kind: "personal" | "business"; currency: string; fyStartMonth: number; color: string }) =>
      api<{ entity: Entity }>("/entities", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export type { Role };
