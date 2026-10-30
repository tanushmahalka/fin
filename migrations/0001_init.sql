-- Finance schema v1.
-- Amounts are INTEGER minor units (paise). Dates are TEXT 'YYYY-MM-DD'.
-- Timestamps are INTEGER milliseconds since the epoch.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Browser sessions and CLI/API tokens. Only a SHA-256 of the secret is stored,
-- so a leaked database cannot be replayed as logins.
CREATE TABLE tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('session', 'cli')),
  name         TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER
);
CREATE INDEX tokens_user ON tokens(user_id);

-- An entity is anyone whose money is kept separately: a person, a company.
CREATE TABLE entities (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('personal', 'business')),
  currency           TEXT NOT NULL DEFAULT 'INR',
  fy_start_month     INTEGER NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  timezone           TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  color              TEXT NOT NULL DEFAULT '#5b5bd6',
  default_account_id TEXT,
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL
);

CREATE TABLE memberships (
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  email       TEXT NOT NULL COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX invites_entity ON invites(entity_id);

-- Chart of accounts. Money accounts (asset, liability), equity, and the
-- categories people see (income, expense) share one table, as in any
-- double-entry ledger, so every posting points at the same kind of thing.
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  subtype     TEXT CHECK (subtype IN ('cash', 'bank', 'card', 'wallet', 'investment', 'loan', 'other')),
  name        TEXT NOT NULL,
  icon        TEXT,
  hint        TEXT, -- plain-language description; helps smart add (Jev) pick the right one
  parent_id   TEXT REFERENCES accounts(id),
  sort        INTEGER NOT NULL DEFAULT 0,
  system      INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX accounts_entity ON accounts(entity_id, type);
CREATE UNIQUE INDEX accounts_live_name ON accounts(entity_id, type, name COLLATE NOCASE) WHERE archived_at IS NULL;

CREATE TABLE transactions (
  id         TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  date       TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  kind       TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer', 'opening', 'adjustment')),
  payee      TEXT,
  note       TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at INTEGER,
  deleted_at INTEGER -- soft delete: history is never destroyed
);
CREATE INDEX transactions_entity_date ON transactions(entity_id, date);

-- One row per leg. Each transaction's postings sum to zero (enforced in the
-- API, verified by GET /integrity). Debits are positive, credits negative.
CREATE TABLE postings (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  amount         INTEGER NOT NULL CHECK (amount <> 0)
);
CREATE INDEX postings_transaction ON postings(transaction_id);
CREATE INDEX postings_account ON postings(entity_id, account_id);

-- Defence in depth for multi-entity isolation: a posting can never connect a
-- transaction in one entity to an account in another.
CREATE TRIGGER postings_same_entity BEFORE INSERT ON postings
WHEN (SELECT entity_id FROM accounts WHERE id = NEW.account_id) IS NOT NEW.entity_id
  OR (SELECT entity_id FROM transactions WHERE id = NEW.transaction_id) IS NOT NEW.entity_id
BEGIN
  SELECT RAISE(ABORT, 'posting crosses entities');
END;

CREATE TABLE budgets (
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL CHECK (amount > 0),
  PRIMARY KEY (entity_id, account_id)
);

-- Who did what, when. Append-only: the database refuses edits and deletes.
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id),
  actor_id    TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  summary     TEXT NOT NULL,
  before      TEXT,
  after       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX audit_entity_time ON audit_log(entity_id, created_at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
