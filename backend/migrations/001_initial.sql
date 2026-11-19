CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role = 'ADMIN')
);
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  school_name TEXT NOT NULL,
  price_per_page INTEGER NOT NULL CHECK(price_per_page > 0),
  max_copies INTEGER NOT NULL CHECK(max_copies BETWEEN 1 AND 100),
  max_file_mb INTEGER NOT NULL CHECK(max_file_mb BETWEEN 1 AND 50),
  max_pages INTEGER NOT NULL CHECK(max_pages BETWEEN 1 AND 500),
  retention_hours INTEGER NOT NULL CHECK(retention_hours BETWEEN 1 AND 8760)
);
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  file_name TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK(page_count > 0),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purged_at INTEGER
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  customer_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT,
  request_hash TEXT,
  printable_pages INTEGER NOT NULL CHECK(printable_pages > 0),
  copies INTEGER NOT NULL CHECK(copies > 0),
  orientation TEXT NOT NULL CHECK(orientation IN ('portrait','landscape')),
  page_ranges TEXT NOT NULL,
  scaling TEXT NOT NULL CHECK(scaling IN ('fit','actual','custom')),
  scale_percent INTEGER,
  paper_size TEXT NOT NULL CHECK(paper_size = 'A4'),
  printing_mode TEXT NOT NULL CHECK(printing_mode = 'Black & White'),
  price_per_page INTEGER NOT NULL CHECK(price_per_page > 0),
  total INTEGER NOT NULL CHECK(total = printable_pages * copies * price_per_page),
  payment_status TEXT NOT NULL CHECK(payment_status IN ('PENDING','TEST_PAID','FAILED')),
  print_status TEXT NOT NULL CHECK(print_status IN ('PENDING_PAYMENT','PAYMENT_FAILED','QUEUED','PROCESSING','SUBMITTED_TO_PRINTER','COMPLETED','COMPLETION_UNCONFIRMED','FAILED','RETRY_PENDING','CANCELLED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(document_id, idempotency_key)
);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  provider TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK(amount > 0),
  status TEXT NOT NULL CHECK(status IN ('PENDING','TEST_PAID','FAILED')),
  receipt_number TEXT UNIQUE,
  event_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE print_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','PROCESSING','SUBMITTED_TO_PRINTER','COMPLETED','COMPLETION_UNCONFIRMED','FAILED','RETRY_PENDING','CANCELLED')),
  error TEXT,
  retry_safe INTEGER NOT NULL DEFAULT 0 CHECK(retry_safe IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE print_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES print_jobs(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  status TEXT NOT NULL,
  queue TEXT,
  authorized_at INTEGER,
  cups_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, attempt_number)
);
CREATE TABLE printers (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  queue TEXT,
  reported_queue TEXT,
  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  reasons TEXT NOT NULL DEFAULT '[]',
  active_jobs INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER
);
INSERT INTO printers(id) VALUES (1);
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id),
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX documents_retention ON documents(deleted_at, created_at);
CREATE INDEX documents_pending_purge ON documents(id) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX orders_created ON orders(created_at DESC);
CREATE INDEX orders_document ON orders(document_id);
CREATE INDEX payments_expiry ON payments(status, created_at);
CREATE INDEX print_jobs_status ON print_jobs(status, created_at);
CREATE INDEX audit_order ON audit_logs(order_id, id DESC);
CREATE INDEX sessions_expiry ON admin_sessions(expires_at);
