import { createContext, useContext } from "react";
import type { Account, Contact, DraftTransaction, EntryKind, Entity, ParseResult, Transaction } from "../shared/types";

export interface EntityState {
  entity: Entity;
  accounts: Account[];
  byId: Map<string, Account>;
  /** Live money accounts (assets and liabilities). */
  money: Account[];
  expenseCats: Account[];
  incomeCats: Account[];
  /** Live contacts, most used first. */
  contacts: Contact[];
  contactsById: Map<string, Contact>;
  canEdit: boolean;
  isOwner: boolean;
}

export const EntityContext = createContext<EntityState | null>(null);

export function useEntity(): EntityState {
  const ctx = useContext(EntityContext);
  if (!ctx) throw new Error("useEntity outside an entity");
  return ctx;
}

export interface ComposerOptions {
  kind?: EntryKind;
  tx?: Transaction;
  contactId?: string;
  /** Creating a transaction for a statement line waiting in review. */
  evidenceId?: string;
  draft?: Partial<DraftTransaction>;
  /** A smart-add result to apply (from the Ask palette), with the text that produced it. */
  parse?: ParseResult;
  smartText?: string;
}

export interface Actions {
  compose: (opts?: ComposerOptions) => void;
  ask: (text?: string) => void;
}

export const ActionsContext = createContext<Actions>({ compose: () => {}, ask: () => {} });
export const useActions = () => useContext(ActionsContext);

// Small per-device memory: which entity was open, which account was last used.
export const remember = {
  get: (key: string) => {
    try {
      return localStorage.getItem(`fin:${key}`);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      localStorage.setItem(`fin:${key}`, value);
    } catch {
      /* private mode */
    }
  },
};
