-- 0001_init.sql — initial schema. Never edit after release; add 0002_*.sql instead.
-- Money: integer paise. Rates: basis points. IDs: ULID text. Times: ISO-8601 with offset.
-- Pragmas (WAL, synchronous=FULL, foreign_keys, busy_timeout) are set in db/connection.ts.

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);

CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ---------- people & devices ----------
CREATE TABLE role (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, discount_limit_bp INTEGER NOT NULL DEFAULT 0);
CREATE TABLE role_permission (
  role_id TEXT NOT NULL REFERENCES role(id), permission TEXT NOT NULL,
  needs_pin INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (role_id, permission)
);
CREATE TABLE app_user (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role_id TEXT NOT NULL REFERENCES role(id),
  pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT
);
CREATE TABLE device (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('terminal','captain','kds')),
  token_hash TEXT UNIQUE, paired_at TEXT, revoked_at TEXT, last_seen_at TEXT
);
CREATE TABLE user_session (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_user(id),
  device_id TEXT NOT NULL REFERENCES device(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);

-- ---------- floor ----------
CREATE TABLE tax_profile (id TEXT PRIMARY KEY, name TEXT NOT NULL, pricing_mode TEXT NOT NULL DEFAULT 'exclusive');
CREATE TABLE price_list (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE area (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  price_list_id TEXT REFERENCES price_list(id), tax_profile_id TEXT REFERENCES tax_profile(id)
);
CREATE TABLE dining_table (
  id TEXT PRIMARY KEY, area_id TEXT NOT NULL REFERENCES area(id), label TEXT NOT NULL,
  seats INTEGER, layout_x INTEGER, layout_y INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reserved','blocked')),
  open_order_id TEXT UNIQUE,
  UNIQUE (area_id, label)
);

-- ---------- menu ----------
CREATE TABLE station (id TEXT PRIMARY KEY, name TEXT NOT NULL, has_kds INTEGER NOT NULL DEFAULT 0);
CREATE TABLE printer (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('tcp','usb','fake')),
  host TEXT, port INTEGER DEFAULT 9100, windows_name TEXT,
  width_mm INTEGER NOT NULL DEFAULT 80, bitmap_text INTEGER NOT NULL DEFAULT 0,
  copies INTEGER NOT NULL DEFAULT 1, cutter INTEGER NOT NULL DEFAULT 1,
  backup_printer_id TEXT REFERENCES printer(id), role TEXT NOT NULL DEFAULT 'kot' CHECK (role IN ('kot','bill','both'))
);
CREATE TABLE station_printer (station_id TEXT REFERENCES station(id), printer_id TEXT REFERENCES printer(id), PRIMARY KEY (station_id, printer_id));
CREATE TABLE category (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, station_id TEXT REFERENCES station(id), sort INTEGER DEFAULT 0);
CREATE TABLE menu_item (
  id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES category(id), name TEXT NOT NULL,
  short_code TEXT UNIQUE, veg INTEGER NOT NULL DEFAULT 1, base_price_paise INTEGER NOT NULL,
  tax_rate_bp INTEGER NOT NULL DEFAULT 500, hsn_sac TEXT, station_id TEXT REFERENCES station(id),
  available INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0
);
CREATE TABLE variant (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES menu_item(id), name TEXT NOT NULL, price_paise INTEGER NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE addon_group (id TEXT PRIMARY KEY, name TEXT NOT NULL, min_select INTEGER DEFAULT 0, max_select INTEGER DEFAULT 1);
CREATE TABLE addon (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES addon_group(id), name TEXT NOT NULL, price_paise INTEGER NOT NULL DEFAULT 0);
CREATE TABLE item_addon_group (item_id TEXT REFERENCES menu_item(id), group_id TEXT REFERENCES addon_group(id), PRIMARY KEY (item_id, group_id));
CREATE TABLE price_list_entry (price_list_id TEXT REFERENCES price_list(id), item_id TEXT REFERENCES menu_item(id), variant_id TEXT, price_paise INTEGER NOT NULL, PRIMARY KEY (price_list_id, item_id, variant_id));
CREATE TABLE area_station_override (area_id TEXT REFERENCES area(id), category_id TEXT REFERENCES category(id), station_id TEXT REFERENCES station(id), PRIMARY KEY (area_id, category_id));

-- ---------- orders ----------
CREATE TABLE "order" (
  id TEXT PRIMARY KEY, business_date TEXT NOT NULL,
  table_id TEXT REFERENCES dining_table(id),
  type TEXT NOT NULL CHECK (type IN ('dine_in','takeaway','delivery','online')),
  covers INTEGER, captain_id TEXT REFERENCES app_user(id), customer_name TEXT, customer_phone TEXT,
  state TEXT NOT NULL CHECK (state IN ('open','billed','settled','void','merged')),
  merged_into TEXT REFERENCES "order"(id),
  version INTEGER NOT NULL DEFAULT 1,
  opened_at TEXT NOT NULL, opened_by TEXT, last_kot_at TEXT, bill_printed_at TEXT, closed_at TEXT
);
CREATE INDEX idx_order_open ON "order"(state) WHERE state IN ('open','billed');
CREATE INDEX idx_order_date ON "order"(business_date);

CREATE TABLE kot (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES "order"(id),
  station_id TEXT NOT NULL REFERENCES station(id), business_date TEXT NOT NULL, kot_no INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('new','modify','cancel','move_notice')),
  fired_at TEXT NOT NULL, fired_by TEXT, ready_at TEXT, served_at TEXT, reprint_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (business_date, kot_no, station_id)
);
CREATE INDEX idx_kot_order ON kot(order_id);

CREATE TABLE order_item (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES "order"(id),
  item_id TEXT NOT NULL, variant_id TEXT, name_snapshot TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0), unit_price_paise INTEGER NOT NULL, tax_rate_bp INTEGER NOT NULL,
  note TEXT, course INTEGER NOT NULL DEFAULT 1, station_id TEXT, kot_id TEXT REFERENCES kot(id),
  status TEXT NOT NULL CHECK (status IN ('held','fired','cancelled')),
  added_by TEXT, added_at TEXT NOT NULL, original_order_id TEXT
);
CREATE INDEX idx_oi_order ON order_item(order_id);

CREATE TABLE order_item_addon (
  order_item_id TEXT NOT NULL REFERENCES order_item(id), addon_id TEXT NOT NULL,
  name_snapshot TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, price_paise INTEGER NOT NULL,
  PRIMARY KEY (order_item_id, addon_id)
);

CREATE TABLE bill (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES "order"(id),
  fy TEXT NOT NULL, bill_no INTEGER, split_no INTEGER NOT NULL DEFAULT 0, split_of INTEGER NOT NULL DEFAULT 1,
  subtotal_paise INTEGER NOT NULL, discount_paise INTEGER NOT NULL DEFAULT 0, discount_reason TEXT,
  service_charge_paise INTEGER NOT NULL DEFAULT 0, cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0, igst_paise INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0, total_paise INTEGER NOT NULL,
  customer_gstin TEXT, printed_at TEXT, print_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('printed','superseded','settled','void')),
  UNIQUE (fy, bill_no, split_no)
);
CREATE INDEX idx_bill_order ON bill(order_id);

CREATE TABLE payment (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bill(id),
  mode TEXT NOT NULL CHECK (mode IN ('cash','card','upi','due','complimentary','other')),
  amount_paise INTEGER NOT NULL, ref TEXT, received_by TEXT, received_at TEXT NOT NULL
);

CREATE TABLE cash_movement (
  id TEXT PRIMARY KEY, business_date TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pay_in','pay_out','opening','closing')),
  amount_paise INTEGER NOT NULL, reason TEXT, user_id TEXT, at TEXT NOT NULL
);

CREATE TABLE business_day (date TEXT PRIMARY KEY, opened_at TEXT NOT NULL, closed_at TEXT, closed_by TEXT, z_report_json TEXT);

CREATE TABLE counter (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

-- ---------- infrastructure ----------
CREATE TABLE audit_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  device_id TEXT, user_id TEXT, approved_by TEXT, command_id TEXT,
  entity TEXT NOT NULL, entity_id TEXT, action TEXT NOT NULL,
  before_json TEXT, after_json TEXT, reason TEXT, leakage_flag INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_entity ON audit_event(entity, entity_id);
CREATE INDEX idx_audit_leak ON audit_event(leakage_flag, ts) WHERE leakage_flag = 1;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_event BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_event BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END;

CREATE TABLE processed_command (command_id TEXT PRIMARY KEY, type TEXT NOT NULL, result_json TEXT NOT NULL, at TEXT NOT NULL);

CREATE TABLE event_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, event TEXT NOT NULL, payload_json TEXT NOT NULL, at TEXT NOT NULL);

CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT);

CREATE TABLE print_job (
  id TEXT PRIMARY KEY, printer_id TEXT NOT NULL REFERENCES printer(id),
  doc_kind TEXT NOT NULL CHECK (doc_kind IN ('kot','bill','zreport','drawer','test')), ref_id TEXT,
  bytes BLOB NOT NULL, preview_text TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','retry','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, done_at TEXT
);
CREATE INDEX idx_print_pending ON print_job(printer_id, state) WHERE state IN ('queued','retry');
