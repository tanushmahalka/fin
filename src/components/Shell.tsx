import {
  ArrowLeftRight,
  BarChart3,
  CalendarClock,
  Check,
  ChevronsUpDown,
  CircleUser,
  Flag,
  LogOut,
  Plus,
  Repeat,
  Settings,
  Sparkles,
  Target,
  Users,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useNavigate, useParams } from "react-router";
import { isMoneyAccount } from "../../shared/ledger";
import type { Entity } from "../../shared/types";
import { api, queryClient, useAccounts, useContacts, useFlagged, useMe } from "../api";
import { ActionsContext, type ComposerOptions, EntityContext, type EntityState, remember } from "../state";
import { AskPalette } from "./AskPalette";
import { Composer } from "./Composer";
import { Mark } from "./Mark";
import { useDismiss } from "./ui";

const NAV = [
  { to: "transactions", label: "Transactions", short: "Trans.", icon: ArrowLeftRight },
  { to: "stats", label: "Stats", short: "Stats", icon: BarChart3 },
  { to: "accounts", label: "Balance sheet", short: "Accounts", icon: Wallet },
  { to: "emis", label: "EMIs", short: "EMIs", icon: CalendarClock },
  { to: "subscriptions", label: "Subscriptions", short: "Subs", icon: Repeat },
  { to: "contacts", label: "Contacts", short: "Contacts", icon: Users },
  { to: "budget", label: "Budget", short: "Budget", icon: Target },
  { to: "flagged", label: "Flagged", short: "Flagged", icon: Flag },
  { to: "settings", label: "Settings", short: "More", icon: Settings },
];

export function EntitySwitcher({ entities, current }: { entities: Entity[]; current: Entity }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const navigate = useNavigate();
  return (
    <div className="menu-anchor switcher" ref={ref}>
      <button className="entity-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="dot" />
        <span className="name">{current.name}</span>
        <ChevronsUpDown />
      </button>
      {open && (
        <div className="menu" role="menu">
          {entities.map((e) => (
            <button
              key={e.id}
              role="menuitem"
              className="menu-item"
              onClick={() => {
                close();
                navigate(`/e/${e.id}/transactions`);
              }}
            >
              <span className="dot" style={{ ["--entity" as string]: e.color }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
              {e.id === current.id ? <Check /> : <span className="pill">{e.role}</span>}
            </button>
          ))}
          <div className="menu-sep" />
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              close();
              navigate("/new");
            }}
          >
            <Plus /> New entity
          </button>
        </div>
      )}
    </div>
  );
}

export async function signOut() {
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  queryClient.clear();
  window.location.assign("/login");
}

export function EntityShell() {
  const { entityId = "" } = useParams();
  const me = useMe();
  const accountsQ = useAccounts(entityId);
  const contactsQ = useContacts(entityId);
  const flaggedQ = useFlagged(entityId);
  const flagged = flaggedQ.data?.length ?? 0;
  const [composer, setComposer] = useState<{ open: boolean; opts: ComposerOptions }>({ open: false, opts: {} });
  const [askOpen, setAskOpen] = useState<{ open: boolean; text?: string }>({ open: false });

  const entity = me.data?.entities.find((e) => e.id === entityId);

  useEffect(() => {
    if (entity) remember.set("entity", entity.id);
  }, [entity]);

  useEffect(() => {
    if (!entity) return;
    document.documentElement.style.setProperty("--entity", entity.color);
    document.title = `${entity.name} · ${me.data?.appName ?? "Finance"}`;
  }, [entity, me.data?.appName]);

  const state = useMemo<EntityState | null>(() => {
    if (!entity) return null;
    const accounts = accountsQ.data ?? [];
    const live = accounts.filter((a) => !a.archived && !a.system);
    const byFreq = (a: { recentUse: number; sort: number }, b: { recentUse: number; sort: number }) =>
      b.recentUse - a.recentUse || a.sort - b.sort;
    const allContacts = contactsQ.data ?? [];
    return {
      entity,
      accounts,
      byId: new Map(accounts.map((a) => [a.id, a])),
      money: live.filter((a) => isMoneyAccount(a) && !a.parentId),
      expenseCats: live.filter((a) => a.type === "expense").sort(byFreq),
      incomeCats: live.filter((a) => a.type === "income").sort(byFreq),
      contacts: allContacts.filter((c) => !c.archived).sort((a, b) => b.transactions - a.transactions || a.name.localeCompare(b.name)),
      contactsById: new Map(allContacts.map((c) => [c.id, c])),
      canEdit: entity.role !== "viewer",
      isOwner: entity.role === "owner",
    };
  }, [entity, accountsQ.data, contactsQ.data]);

  const actions = useMemo(
    () => ({
      compose: (opts: ComposerOptions = {}) => setComposer({ open: true, opts }),
      ask: (text?: string) => setAskOpen({ open: true, text }),
    }),
    [],
  );

  // Keyboard: N expense, I income, T transfer, / or ⌘K ask.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        actions.ask();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "/") {
        e.preventDefault();
        actions.ask();
      } else if (state?.canEdit && (k === "n" || k === "i" || k === "t")) {
        e.preventDefault();
        actions.compose({ kind: k === "n" ? "expense" : k === "i" ? "income" : "transfer" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, state?.canEdit]);

  if (me.isLoading) return null;
  if (me.data && !entity) return <Navigate to="/" replace />;
  if (!state || !me.data) return null;

  return (
    <EntityContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>
        <div className="shell">
          <aside className="sidebar">
            <EntitySwitcher entities={me.data.entities} current={state.entity} />
            {state.canEdit && (
              <button className="btn btn-primary" style={{ margin: "10px 2px 0" }} onClick={() => actions.compose()}>
                <Plus /> Add <kbd style={{ marginLeft: "auto", background: "rgb(255 255 255 / .14)", boxShadow: "none", color: "inherit" }}>N</kbd>
              </button>
            )}
            <button className="nav-item" style={{ marginTop: 6 }} onClick={() => actions.ask()}>
              <Sparkles /> Ask or add <kbd>/</kbd>
            </button>
            <nav className="sidebar-section" aria-label="Main">
              {NAV.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} className="nav-item">
                  <Icon /> {label}
                  {to === "flagged" && flagged > 0 && <span className="count">{flagged}</span>}
                </NavLink>
              ))}
            </nav>
            <div className="sidebar-foot">
              <Link to="profile" className="nav-item">
                <CircleUser /> {me.data.user.name}
              </Link>
              <button className="nav-item" onClick={signOut}>
                <LogOut /> Sign out
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 10px 2px", color: "var(--text-3)", fontSize: 12 }}>
                <Mark size={16} /> {me.data.appName}
              </div>
            </div>
          </aside>

          <div className="main">
            <header className="topbar">
              <EntitySwitcher entities={me.data.entities} current={state.entity} />
              <button className="icon-btn" onClick={() => actions.ask()} aria-label="Ask or add">
                <Sparkles />
              </button>
              <Link to="profile" className="icon-btn" aria-label="Profile">
                <CircleUser />
              </Link>
            </header>
            <Outlet />
          </div>

          <nav className="tabbar" aria-label="Main">
            {NAV.filter((n) => n.to !== "budget" && n.to !== "flagged" && n.to !== "emis" && n.to !== "subscriptions").map(({ to, short, icon: Icon }) => (
              <NavLink key={to} to={to} className="tab">
                <Icon />
                {short}
              </NavLink>
            ))}
          </nav>
          {state.canEdit && (
            <button className="fab" onClick={() => actions.compose()} aria-label="Add transaction">
              <Plus />
            </button>
          )}
        </div>
        <Composer open={composer.open} options={composer.opts} onClose={() => setComposer((c) => ({ ...c, open: false }))} />
        <AskPalette
          open={askOpen.open}
          initialText={askOpen.text}
          onClose={() => setAskOpen({ open: false })}
          onRecord={(opts) => {
            setAskOpen({ open: false });
            setComposer({ open: true, opts });
          }}
        />
      </ActionsContext.Provider>
    </EntityContext.Provider>
  );
}
