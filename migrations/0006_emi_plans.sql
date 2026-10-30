-- EMI plans: a purchase or loan repaid in fixed monthly instalments.
--
-- A plan is a view over the ledger, not a balance-sheet line. Where its unpaid
-- principal sits depends on how the lender reports it:
--   * Most cards (ICICI, HDFC, YES, DBS) credit the purchase back and bill one
--     instalment a month. The rest lives in a sub-account whose parent_id is the
--     card; the balance sheet folds it into the card's line.
--   * SBI Card keeps it inside the card's Total Outstanding. balance_account_id
--     is NULL and what's left is worked out from the schedule.
--   * A loan repaid by EMI points at its own loan account.
CREATE TABLE emi_plans (
  id                 TEXT PRIMARY KEY,
  entity_id          TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  -- The card or bank account the instalments are billed to or paid from.
  account_id         TEXT NOT NULL REFERENCES accounts(id),
  -- The account whose balance is the unpaid principal. NULL = inside account_id.
  balance_account_id TEXT REFERENCES accounts(id),
  title              TEXT NOT NULL,            -- what it paid for, in your words
  merchant           TEXT,
  contact_id         TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  purchase_tx_id     TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  evidence           TEXT,                     -- receipt, order or booking reference
  principal          INTEGER CHECK (principal IS NULL OR principal > 0),
  instalment         INTEGER NOT NULL CHECK (instalment > 0),
  months             INTEGER CHECK (months IS NULL OR months > 0),
  first_due          TEXT CHECK (first_due IS NULL OR first_due GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  closed_at          INTEGER,
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL
);
CREATE INDEX emi_plans_entity ON emi_plans(entity_id);
