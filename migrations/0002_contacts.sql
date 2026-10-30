-- Contacts: the person or business on the other side of a transaction
-- (Blinkit, a friend, a client). A contact is a tag, not an account: money
-- never sits "at Blinkit". When money is genuinely owed, it sits in the
-- entity's single "Lent & borrowed" account, split by contact.

CREATE TABLE contacts (
  id                  TEXT PRIMARY KEY,
  entity_id           TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'business' CHECK (kind IN ('person', 'business')),
  aliases             TEXT, -- other names it appears under, comma-separated ("grofers, blinkit commerce")
  default_category_id TEXT REFERENCES accounts(id),
  archived_at         INTEGER,
  created_at          INTEGER NOT NULL
);
CREATE INDEX contacts_entity ON contacts(entity_id);
CREATE UNIQUE INDEX contacts_live_name ON contacts(entity_id, name COLLATE NOCASE) WHERE archived_at IS NULL;

-- On the posting, not the transaction: a split dinner names the restaurant on
-- one leg and the friend who owes you on another.
ALTER TABLE postings ADD COLUMN contact_id TEXT REFERENCES contacts(id);
CREATE INDEX postings_contact ON postings(entity_id, contact_id);

CREATE TRIGGER postings_contact_same_entity BEFORE INSERT ON postings
WHEN NEW.contact_id IS NOT NULL AND (SELECT entity_id FROM contacts WHERE id = NEW.contact_id) IS NOT NEW.entity_id
BEGIN
  SELECT RAISE(ABORT, 'contact belongs to another entity');
END;

CREATE TRIGGER postings_contact_same_entity_update BEFORE UPDATE OF contact_id ON postings
WHEN NEW.contact_id IS NOT NULL AND (SELECT entity_id FROM contacts WHERE id = NEW.contact_id) IS NOT NEW.entity_id
BEGIN
  SELECT RAISE(ABORT, 'contact belongs to another entity');
END;

-- Free-text payee is replaced by contacts.
ALTER TABLE transactions DROP COLUMN payee;

-- Each entity gets one receivable/payable account. Positive balance with a
-- contact = they owe you; negative = you owe them.
ALTER TABLE entities ADD COLUMN iou_account_id TEXT REFERENCES accounts(id);

INSERT INTO accounts (id, entity_id, type, subtype, name, icon, sort, system, created_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-7' || substr(hex(randomblob(2)), 2) || '-8' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
       e.id, 'asset', 'other', 'Lent & borrowed', '🤝', 0, 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
FROM entities e;

UPDATE entities SET iou_account_id = (
  SELECT a.id FROM accounts a WHERE a.entity_id = entities.id AND a.system = 1 AND a.name = 'Lent & borrowed'
);
