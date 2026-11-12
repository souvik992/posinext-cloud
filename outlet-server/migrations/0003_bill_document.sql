-- 0003_bill_document.sql — the exact bill as printed, for reprints and audits, and money immutability.
-- A bill row holds the totals; bill_document holds what was printed (outlet details, lines, rates, tax groups,
-- round-off settings) so a reprint matches the original even after menu or outlet settings change.
-- Each print of a bill number (first print, re-issue after items were added) is a new revision. Append-only.

CREATE TABLE bill_document (
  bill_id TEXT NOT NULL REFERENCES bill(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  bill_no_text TEXT NOT NULL,
  doc_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  command_id TEXT,
  PRIMARY KEY (bill_id, revision)
);
CREATE TRIGGER bill_document_no_update BEFORE UPDATE ON bill_document
BEGIN SELECT RAISE(ABORT, 'bill_document is append-only'); END;
CREATE TRIGGER bill_document_no_delete BEFORE DELETE ON bill_document
BEGIN SELECT RAISE(ABORT, 'bill_document is append-only'); END;

-- Bills are never deleted; a settled bill changes only by being voided (docs/02 invariant 4).
CREATE TRIGGER bill_no_delete BEFORE DELETE ON bill
BEGIN SELECT RAISE(ABORT, 'bills are never deleted; void instead'); END;
CREATE TRIGGER bill_settled_frozen BEFORE UPDATE ON bill
WHEN OLD.state IN ('settled', 'void') AND NOT (OLD.state = 'settled' AND NEW.state = 'void')
BEGIN SELECT RAISE(ABORT, 'a settled bill cannot be changed; void it instead'); END;
CREATE TRIGGER bill_number_fixed BEFORE UPDATE OF fy, bill_no, split_no ON bill
WHEN OLD.bill_no IS NOT NULL AND (NEW.fy IS NOT OLD.fy OR NEW.bill_no IS NOT OLD.bill_no OR NEW.split_no IS NOT OLD.split_no)
BEGIN SELECT RAISE(ABORT, 'a bill number never changes once assigned'); END;

-- Payments are facts: corrections are new rows (reversals), never edits.
CREATE TRIGGER payment_no_update BEFORE UPDATE ON payment
BEGIN SELECT RAISE(ABORT, 'payment rows are append-only'); END;
CREATE TRIGGER payment_no_delete BEFORE DELETE ON payment
BEGIN SELECT RAISE(ABORT, 'payment rows are append-only'); END;

CREATE INDEX idx_payment_bill ON payment(bill_id);
CREATE INDEX idx_bill_fy_no ON bill(fy, bill_no);
