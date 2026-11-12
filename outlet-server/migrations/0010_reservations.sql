-- 0010_reservations.sql — P4-04. Table bookings and the walk-in waitlist. New tables only; a booking holds its tables
-- (shown RESERVED) from `reservation.holdMin` before its time until `reservation.graceMin` after it.
CREATE TABLE reservation (
  id TEXT PRIMARY KEY,
  guest_name TEXT NOT NULL,
  phone TEXT,
  party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 99),
  starts_at TEXT NOT NULL,            -- UTC ISO
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 15 AND 480),
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('booked', 'seated', 'cancelled', 'no_show')),
  order_id TEXT REFERENCES "order"(id),
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES app_user(id),
  closed_at TEXT
);
CREATE INDEX idx_reservation_start ON reservation (starts_at);

CREATE TABLE reservation_table (
  reservation_id TEXT NOT NULL REFERENCES reservation(id),
  table_id TEXT NOT NULL REFERENCES dining_table(id),
  PRIMARY KEY (reservation_id, table_id)
);
CREATE INDEX idx_reservation_table ON reservation_table (table_id);

CREATE TABLE waitlist_entry (
  id TEXT PRIMARY KEY,
  guest_name TEXT NOT NULL,
  phone TEXT,
  party_size INTEGER NOT NULL CHECK (party_size BETWEEN 1 AND 99),
  quoted_min INTEGER,                 -- the wait the guest was told
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'seated', 'left', 'cancelled')),
  joined_at TEXT NOT NULL,
  created_by TEXT REFERENCES app_user(id),
  closed_at TEXT,
  table_id TEXT REFERENCES dining_table(id),
  order_id TEXT REFERENCES "order"(id)
);
CREATE INDEX idx_waitlist_status ON waitlist_entry (status, joined_at);

-- Booking and the waitlist are front-of-house work: the default Owner, Manager, Cashier and Captain roles.
INSERT INTO role_permission (role_id, permission, needs_pin) VALUES
  ('01JR0000000000000000000001', 'reservation.manage', 0),
  ('01JR0000000000000000000002', 'reservation.manage', 0),
  ('01JR0000000000000000000003', 'reservation.manage', 0),
  ('01JR0000000000000000000004', 'reservation.manage', 0);
