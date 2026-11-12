-- 0012_online_orders.sql — P4-06. Online orders through the order hub (pos-backend/hub, contract v1).
-- Approved by the product owner (2026-11-03): a new payment mode 'online' for orders paid on the website/app.

-- 1. payment.mode gains 'online'. SQLite cannot change a CHECK, so the table is rebuilt with every row kept as it was;
--    its append-only triggers and index are created again. (DROP TABLE does not fire the DELETE trigger.)
CREATE TABLE payment_v2 (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bill(id),
  mode TEXT NOT NULL CHECK (mode IN ('cash','card','upi','due','complimentary','other','online')),
  amount_paise INTEGER NOT NULL, ref TEXT, received_by TEXT, received_at TEXT NOT NULL
);
INSERT INTO payment_v2 (id, bill_id, mode, amount_paise, ref, received_by, received_at)
  SELECT id, bill_id, mode, amount_paise, ref, received_by, received_at FROM payment;
DROP TABLE payment;
ALTER TABLE payment_v2 RENAME TO payment;
CREATE INDEX idx_payment_bill ON payment(bill_id);
CREATE TRIGGER payment_no_update BEFORE UPDATE ON payment
BEGIN SELECT RAISE(ABORT, 'payment rows are append-only'); END;
CREATE TRIGGER payment_no_delete BEFORE DELETE ON payment
BEGIN SELECT RAISE(ABORT, 'payment rows are append-only'); END;

-- 2. The link to the hub (one row). The device key is a secret: it never leaves the server (not in /v1/config).
CREATE TABLE online_link (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hub_url TEXT, device_key TEXT, store_slug TEXT, store_name TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,       -- the last hub event stored (resume point)
  menu_hash TEXT, menu_version INTEGER NOT NULL DEFAULT 0,
  paired_at TEXT, paired_by TEXT REFERENCES app_user(id)
);
INSERT INTO online_link (id) VALUES (1);

-- 3. Orders from the hub, stored before they are confirmed (received). `order_json` is the hub's order as it came.
CREATE TABLE online_order (
  id TEXT PRIMARY KEY,                       -- the hub's order id
  number TEXT NOT NULL,                      -- "W-1042"
  state TEXT NOT NULL,                       -- contract OrderState
  order_json TEXT NOT NULL,
  received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  local_order_id TEXT REFERENCES "order"(id),
  bill_id TEXT REFERENCES bill(id),
  pos_total_paise INTEGER,                   -- the DinePOS bill total (may differ from the customer's: flagged)
  prep_minutes INTEGER,
  alert TEXT,                                -- what staff must know (cancelled after billing, price differs, ...)
  accepted_by TEXT REFERENCES app_user(id)
);
CREATE INDEX idx_online_order_state ON online_order (state, received_at);

-- 4. Actions for the hub, stored first and sent after (retried with the same idempotency key until answered).
CREATE TABLE online_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('received', 'accept', 'reject', 'state')),
  body_json TEXT NOT NULL,
  idem_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  done_at TEXT,
  result TEXT
);
CREATE INDEX idx_online_outbox_pending ON online_outbox (done_at, id);

-- Online orders are front-of-house work: Owner, Manager and Cashier by default.
INSERT INTO role_permission (role_id, permission, needs_pin) VALUES
  ('01JR0000000000000000000001', 'online.orders', 0),
  ('01JR0000000000000000000002', 'online.orders', 0),
  ('01JR0000000000000000000003', 'online.orders', 0);
