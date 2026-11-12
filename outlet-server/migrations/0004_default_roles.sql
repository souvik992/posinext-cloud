-- 0004_default_roles.sql — default roles, their rights and discount limits (docs/07 "Rights"), and the device row
-- sessions use until device pairing exists (P2-02). Data only: no table changes. Roles are editable afterwards
-- (UpsertRole); these rows are only the starting point.
--
-- role_permission.needs_pin = 1: the user may do it only with a manager's PIN (someone whose role has the right
-- without needs_pin). A right with no row is not allowed for that role.

INSERT INTO role (id, name, discount_limit_bp) VALUES
  ('01JR0000000000000000000001', 'Owner', 10000),
  ('01JR0000000000000000000002', 'Manager', 2000),
  ('01JR0000000000000000000003', 'Cashier', 1000),
  ('01JR0000000000000000000004', 'Captain', 0),
  ('01JR0000000000000000000005', 'Kitchen', 0);

-- Owner: everything, no PIN.
INSERT INTO role_permission (role_id, permission, needs_pin)
SELECT '01JR0000000000000000000001', value, 0 FROM json_each('["order.create","order.edit","kot.fire","kot.modify","kot.cancel","table.move","table.merge","item.transfer","bill.print","bill.split","bill.settle","bill.void","reprint","kds.bump","menu.stock","drawer.open","cash.move","dayend","admin","users.manage"]');

-- Manager: everything except managing staff and roles, no PIN.
INSERT INTO role_permission (role_id, permission, needs_pin)
SELECT '01JR0000000000000000000002', value, 0 FROM json_each('["order.create","order.edit","kot.fire","kot.modify","kot.cancel","table.move","table.merge","item.transfer","bill.print","bill.split","bill.settle","bill.void","reprint","kds.bump","menu.stock","drawer.open","cash.move","dayend","admin"]');

-- Cashier: day-to-day billing; corrections, reprints, voids and cash need a manager PIN.
INSERT INTO role_permission (role_id, permission, needs_pin)
SELECT '01JR0000000000000000000003', value, 0 FROM json_each('["order.create","order.edit","kot.fire","table.move","table.merge","item.transfer","bill.print","bill.split","bill.settle","menu.stock"]');
INSERT INTO role_permission (role_id, permission, needs_pin)
SELECT '01JR0000000000000000000003', value, 1 FROM json_each('["kot.modify","kot.cancel","reprint","bill.void","drawer.open","cash.move"]');

-- Captain: takes and fires orders; changes to fired items need a manager PIN.
INSERT INTO role_permission (role_id, permission, needs_pin)
SELECT '01JR0000000000000000000004', value, 0 FROM json_each('["order.create","order.edit","kot.fire","table.move"]');
INSERT INTO role_permission (role_id, permission, needs_pin)
SELECT '01JR0000000000000000000004', value, 1 FROM json_each('["kot.modify","kot.cancel"]');

-- Kitchen: bumps tickets, marks items out of stock.
INSERT INTO role_permission (role_id, permission, needs_pin)
SELECT '01JR0000000000000000000005', value, 0 FROM json_each('["kds.bump","menu.stock"]');

-- Every session belongs to a device. Until device pairing (P2-02), terminals sign in as this one.
INSERT INTO device (id, name, kind) VALUES ('01JD0000000000000000000001', 'Unpaired terminal', 'terminal');
