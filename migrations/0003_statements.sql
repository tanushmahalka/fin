-- Statement import, provenance and deduplication.
--
-- Two separate ideas:
--   who entered it    transactions.created_by (+ agent_name when an agent token was used)
--   where it came from transactions.origin (first source) and evidence rows (every sighting)
-- A transaction typed by hand and later seen on a bank statement is ONE
-- transaction with two pieces of evidence; statement evidence marks it reconciled.

CREATE TABLE statement_imports (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  status          TEXT NOT NULL CHECK (status IN ('preview', 'committed', 'undone')),
  period_from     TEXT NOT NULL,
  period_to       TEXT NOT NULL,
  opening_balance INTEGER NOT NULL, -- as printed on the statement (display terms)
  closing_balance INTEGER NOT NULL,
  file_sha256     TEXT,
  plan            TEXT NOT NULL,    -- JSON: every line and what will happen to it
  line_count      INTEGER NOT NULL,
  created_count   INTEGER NOT NULL DEFAULT 0,
  matched_count   INTEGER NOT NULL DEFAULT 0,
  review_count    INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL REFERENCES users(id),
  agent_name      TEXT,
  created_at      INTEGER NOT NULL,
  committed_at    INTEGER,
  undone_at       INTEGER
);
CREATE INDEX statement_imports_entity ON statement_imports(entity_id, created_at);

ALTER TABLE transactions ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
  CHECK (origin IN ('manual', 'smart', 'statement', 'sms', 'email', 'api'));
ALTER TABLE transactions ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN agent_name TEXT;
ALTER TABLE transactions ADD COLUMN import_id TEXT REFERENCES statement_imports(id);

-- Tokens used by agents are marked, so their writes say "added by Kaira (agent)".
ALTER TABLE tokens ADD COLUMN agent INTEGER NOT NULL DEFAULT 0;

-- Statement details let an import find its account by exact identifiers, never by guessing.
ALTER TABLE accounts ADD COLUMN institution TEXT;
ALTER TABLE accounts ADD COLUMN number_last4 TEXT;
ALTER TABLE accounts ADD COLUMN ifsc TEXT;

-- Every outside sighting of money moving in one account: a statement line,
-- later an SMS or an email. Linked to a transaction, waiting for a person
-- (pending), or a failed payment and its reversal (no transaction at all).
CREATE TABLE evidence (
  id             TEXT PRIMARY KEY,
  entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (source IN ('statement', 'sms', 'email')),
  status         TEXT NOT NULL CHECK (status IN ('linked', 'pending', 'reversal', 'dismissed')),
  transaction_id TEXT REFERENCES transactions(id),
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  import_id      TEXT REFERENCES statement_imports(id),
  line_no        INTEGER,
  date           TEXT NOT NULL,
  amount         INTEGER NOT NULL, -- signed effect on the account's ledger balance (debit +, credit −)
  balance        INTEGER,          -- running balance as printed
  description    TEXT NOT NULL,
  reference      TEXT,
  upi_id         TEXT,
  fingerprint    TEXT,             -- same line seen twice = same fingerprint
  match          TEXT CHECK (match IN ('created', 'reference', 'auto', 'jev', 'person')),
  candidates     TEXT,             -- JSON transaction ids, for pending lines
  created_at     INTEGER NOT NULL
);
CREATE INDEX evidence_transaction ON evidence(transaction_id);
CREATE INDEX evidence_entity_status ON evidence(entity_id, status);
CREATE UNIQUE INDEX evidence_fingerprint ON evidence(entity_id, fingerprint) WHERE fingerprint IS NOT NULL;
-- One statement line per transaction per account: a transfer can be confirmed
-- by both the bank and the card statement, but never twice by the same account.
CREATE UNIQUE INDEX evidence_one_statement_link ON evidence(transaction_id, account_id)
  WHERE source = 'statement' AND status = 'linked';

-- Payment identifiers learned from your own labels (UPI IDs, masked account numbers).
CREATE TABLE contact_identifiers (
  id         TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('upi', 'account')),
  value      TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX contact_identifiers_value ON contact_identifiers(entity_id, kind, value);
