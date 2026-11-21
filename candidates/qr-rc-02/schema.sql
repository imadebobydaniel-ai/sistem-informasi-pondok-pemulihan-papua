-- Use a fresh isolated database; the earlier prototype schema is not compatible.
CREATE TABLE IF NOT EXISTS cards (
  uid TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  auth_time INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cards_expiry ON cards(expires_at);
CREATE TABLE IF NOT EXISTS qr_budget (
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL,
  PRIMARY KEY(scope, subject, expires_at)
);
CREATE INDEX IF NOT EXISTS idx_qr_budget_expiry ON qr_budget(expires_at);
