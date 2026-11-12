-- P5-01 signed add-ons (docs/adr/0004-signed-addons.md).
-- addon_state: what the loader found last start, and the highest version that ever ran (an older one is refused).
CREATE TABLE addon_state (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  highest_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('on', 'off')),
  error TEXT,
  updated_at TEXT NOT NULL
);

-- addon_migration: each add-on's own database steps, applied once, in order, with a checksum (own <id>_ tables only).
CREATE TABLE addon_migration (
  addon_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (addon_id, seq)
);
