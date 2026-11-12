-- 0009_captain_sections.sql — P3-04. A captain's section (the areas and tables they look after), and "Request bill"
-- from the floor. New tables only.
CREATE TABLE captain_section (
  user_id TEXT NOT NULL REFERENCES app_user(id),
  area_id TEXT REFERENCES area(id),
  table_id TEXT REFERENCES dining_table(id),
  CHECK ((area_id IS NULL) <> (table_id IS NULL))
);
CREATE UNIQUE INDEX ux_captain_section ON captain_section (user_id, coalesce(area_id, ''), coalesce(table_id, ''));
CREATE INDEX idx_captain_section_table ON captain_section (table_id);
CREATE INDEX idx_captain_section_area ON captain_section (area_id);

-- One open request per order; cleared when the bill is printed (the audit log keeps every request).
CREATE TABLE bill_request (
  order_id TEXT PRIMARY KEY REFERENCES "order"(id),
  requested_at TEXT NOT NULL,
  requested_by TEXT REFERENCES app_user(id)
);

-- Setting sections is a shift-start job for the manager: the staff.sections right for the default Owner and Manager.
INSERT INTO role_permission (role_id, permission, needs_pin) VALUES
  ('01JR0000000000000000000001', 'staff.sections', 0),
  ('01JR0000000000000000000002', 'staff.sections', 0);
