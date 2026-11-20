CREATE TABLE kiosk_sessions (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('SCANNED','SELECTING','UPLOADING','SETTINGS','REVIEW','PAYMENT')),
  file_count INTEGER CHECK(file_count BETWEEN 0 AND 8),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence BETWEEN 0 AND 1000000000),
  order_id TEXT UNIQUE REFERENCES orders(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX kiosk_sessions_latest ON kiosk_sessions(created_at DESC);
CREATE INDEX kiosk_sessions_owner ON kiosk_sessions(owner_hash, updated_at DESC);
CREATE INDEX kiosk_sessions_expiry ON kiosk_sessions(updated_at);
