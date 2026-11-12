-- 0002_migration_checksums.sql — lets the runner detect a migration file edited after it was applied.
-- SHA-256 of each migration's SQL with line endings normalised to LF (so a CRLF checkout matches).
-- Rows are written by db/migrate.ts in the same transaction as the migration they describe.

CREATE TABLE schema_migration_checksum (
  version INTEGER PRIMARY KEY REFERENCES schema_migrations(version),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64)
);
CREATE TRIGGER schema_migration_checksum_no_update BEFORE UPDATE ON schema_migration_checksum
BEGIN SELECT RAISE(ABORT, 'schema_migration_checksum is append-only'); END;
CREATE TRIGGER schema_migration_checksum_no_delete BEFORE DELETE ON schema_migration_checksum
BEGIN SELECT RAISE(ABORT, 'schema_migration_checksum is append-only'); END;
