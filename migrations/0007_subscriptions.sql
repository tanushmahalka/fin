-- Subscriptions: a recurring charge you've signed up for (Netflix, Google Workspace, broadband).
--
-- A subscription isn't money held or owed, so it never touches the ledger. Its
-- charges stay ordinary expenses; this row says what to expect and links them:
-- a charge belongs here when it's to this contact (or its note contains
-- match_text) and within ±25% of the expected amount.
CREATE TABLE subscriptions (
  id             TEXT PRIMARY KEY,
  entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  contact_id     TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  match_text     TEXT,
  amount         INTEGER NOT NULL CHECK (amount > 0),
  cadence        TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  account_id     TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  -- Who it's really for when you pay on someone's behalf (a company you run).
  for_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  note           TEXT,
  cancelled_at   INTEGER,
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     INTEGER NOT NULL
);
CREATE INDEX subscriptions_entity ON subscriptions(entity_id);
