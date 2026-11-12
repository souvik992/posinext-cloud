-- P6-03 print agents (docs/06 "Print agents", ADR-0005): a small program on a PC on the printers' network prints the
-- tickets of the printers assigned to it, for a server that cannot reach them (in the cloud, or on another network).
-- New tables only; the printer and device tables are unchanged.
CREATE TABLE print_agent (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- sha256('agent:' || key); the key itself is shown once on the terminal that made it and never stored
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  version TEXT
);

-- Printers printed by an agent (absent: the server prints itself, as before).
CREATE TABLE printer_agent (
  printer_id TEXT PRIMARY KEY REFERENCES printer(id),
  agent_id TEXT NOT NULL REFERENCES print_agent(id)
);
