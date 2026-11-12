-- 0008_reports_right.sql — the reports.view right (P4-03) for the default Owner and Manager roles. Data only.
INSERT INTO role_permission (role_id, permission, needs_pin) VALUES
  ('01JR0000000000000000000001', 'reports.view', 0),
  ('01JR0000000000000000000002', 'reports.view', 0);
