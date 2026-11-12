-- 0011_licence.sql — P2-09. The installed licence key (one row) and the latest time the server has seen, so turning the
-- PC clock back does not extend a licence. New table only; the key itself is verified by the server on every check.
CREATE TABLE licence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  licence_key TEXT,
  installed_at TEXT,
  installed_by TEXT REFERENCES app_user(id),
  last_seen_at TEXT
);
INSERT INTO licence (id) VALUES (1);
