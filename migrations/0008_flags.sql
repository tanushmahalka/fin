-- A flag is the agent asking the owner to look: why this transaction needs a human
-- (unidentified, suspicious, ambiguous). NULL = nothing to look at. Unlike
-- needs_review (the agent's own work queue), flags are meant to stay few.
ALTER TABLE transactions ADD COLUMN flag TEXT;
CREATE INDEX transactions_flagged ON transactions(entity_id) WHERE flag IS NOT NULL;
