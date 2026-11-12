-- 0006_kot_document.sql — the exact kitchen ticket as printed (new, modify and cancel slips), so a reprint
-- matches the original even after items were changed, moved or cancelled (P2-04). New table only. Append-only.

CREATE TABLE kot_document (
  kot_id TEXT PRIMARY KEY REFERENCES kot(id),
  ticket_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  command_id TEXT
);
CREATE TRIGGER kot_document_no_update BEFORE UPDATE ON kot_document
BEGIN SELECT RAISE(ABORT, 'kot_document is append-only'); END;
CREATE TRIGGER kot_document_no_delete BEFORE DELETE ON kot_document
BEGIN SELECT RAISE(ABORT, 'kot_document is append-only'); END;
