-- Credit limit for cards (and sanctioned limits for credit lines), in paise.
-- Borrowing capacity, not money held: shown as "credit available", never in net worth.
ALTER TABLE accounts ADD COLUMN credit_limit INTEGER CHECK (credit_limit IS NULL OR credit_limit >= 0);
