-- 0007_device_pairing.sql — device pairing (P2-02, docs/07 "Device pairing"). New table; the built-in device row
-- from 0004 is renamed: it now stands for the master PC itself (requests from 127.0.0.1 need no device token).

CREATE TABLE pairing_request (
  id TEXT PRIMARY KEY,
  -- 6 digits shown on the new device and typed on an approving terminal.
  code TEXT NOT NULL,
  -- SHA-256 of the secret only the requesting device knows; it collects the token with it.
  secret_hash TEXT NOT NULL,
  device_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('terminal', 'captain', 'kds')),
  remote_addr TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'delivered', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  device_id TEXT REFERENCES device(id)
);
CREATE INDEX idx_pairing_code ON pairing_request (code) WHERE status = 'pending';

UPDATE device SET name = 'Master PC', paired_at = coalesce(paired_at, datetime('now')) WHERE id = '01JD0000000000000000000001';
