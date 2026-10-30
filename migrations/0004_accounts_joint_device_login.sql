-- Additive only. (A table rebuild to change the subtype CHECK was tried and
-- rejected: with foreign keys enforced inside D1's migration transaction,
-- DROP TABLE runs an implicit DELETE whose ON DELETE CASCADE would wipe
-- budgets. New kinds are expressed as a balance-sheet group instead.)

-- Balance-sheet heading for the account, e.g. "Fixed deposits", "Property".
-- Defaults to the subtype's heading when empty.
ALTER TABLE accounts ADD COLUMN group_label TEXT;

-- Joint ownership: who else holds the account, and the user's share of it.
-- The ledger keeps the full balance (that's what the bank reports); net worth
-- counts only own_share percent of it.
ALTER TABLE accounts ADD COLUMN joint_with TEXT;
ALTER TABLE accounts ADD COLUMN own_share INTEGER NOT NULL DEFAULT 100 CHECK (own_share BETWEEN 0 AND 100);

-- Device login: `fin login` gets a token by browser approval, so an agent
-- never handles the user's password.
CREATE TABLE device_logins (
  id          TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the secret the CLI polls with
  user_code   TEXT NOT NULL UNIQUE, -- short code the person checks in the browser
  name        TEXT NOT NULL,
  agent       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'issued')),
  user_id     TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
