-- 0005_stock.sql — inventory of raw materials, purchases and recipes (docs/02-domain-model.md "Stock").
-- New tables only, plus the stock.manage right for the default Owner and Manager roles.
--
-- Quantities are INTEGER thousandths of the material's unit (1.5 kg = 1500). Costs are INTEGER paise per whole
-- unit. stock_movement is an append-only ledger; stock_item.on_hand_milli is a cache of its sum, kept in the same
-- transaction. Purchases are immutable: a mistake is voided (reversal movements) and entered again.

CREATE TABLE stock_item (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('kg', 'g', 'l', 'ml', 'pcs')),
  on_hand_milli INTEGER NOT NULL DEFAULT 0,
  reorder_level_milli INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level_milli >= 0),
  last_unit_cost_paise INTEGER CHECK (last_unit_cost_paise IS NULL OR last_unit_cost_paise >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_stock_item_name ON stock_item (name COLLATE NOCASE) WHERE active = 1;
CREATE TRIGGER stock_item_unit_fixed BEFORE UPDATE OF unit ON stock_item WHEN OLD.unit <> NEW.unit
  BEGIN SELECT RAISE(ABORT, 'the unit of a stock item cannot change'); END;

CREATE TABLE stock_movement (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  stock_item_id TEXT NOT NULL REFERENCES stock_item(id),
  delta_milli INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opening', 'purchase', 'purchase_void', 'sale', 'wastage', 'count', 'adjust')),
  ref_type TEXT CHECK (ref_type IS NULL OR ref_type IN ('kot', 'purchase')),
  ref_id TEXT,
  reason TEXT,
  unit_cost_paise INTEGER,
  business_date TEXT NOT NULL,
  user_id TEXT,
  command_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_stock_movement_item ON stock_movement (stock_item_id, seq);
CREATE INDEX idx_stock_movement_date ON stock_movement (business_date, stock_item_id);
CREATE INDEX idx_stock_movement_ref ON stock_movement (ref_type, ref_id);
CREATE TRIGGER stock_movement_no_update BEFORE UPDATE ON stock_movement
  BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END;
CREATE TRIGGER stock_movement_no_delete BEFORE DELETE ON stock_movement
  BEGIN SELECT RAISE(ABORT, 'stock movements are append-only'); END;

CREATE TABLE purchase (
  id TEXT PRIMARY KEY,
  supplier_name TEXT NOT NULL,
  supplier_gstin TEXT,
  invoice_no TEXT,
  invoice_date TEXT,
  note TEXT,
  total_paise INTEGER NOT NULL CHECK (total_paise >= 0),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  business_date TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  voided_by TEXT,
  voided_at TEXT,
  void_reason TEXT
);
CREATE INDEX idx_purchase_created ON purchase (created_at);
-- Only the void fields may change, once.
CREATE TRIGGER purchase_immutable BEFORE UPDATE OF id, supplier_name, supplier_gstin, invoice_no, invoice_date, note, total_paise, business_date, created_by, created_at ON purchase
  BEGIN SELECT RAISE(ABORT, 'purchases are immutable; void and enter again'); END;
CREATE TRIGGER purchase_no_unvoid BEFORE UPDATE OF status ON purchase WHEN OLD.status = 'void'
  BEGIN SELECT RAISE(ABORT, 'a voided purchase cannot be reinstated'); END;
CREATE TRIGGER purchase_no_delete BEFORE DELETE ON purchase
  BEGIN SELECT RAISE(ABORT, 'purchases cannot be deleted'); END;

CREATE TABLE purchase_line (
  purchase_id TEXT NOT NULL REFERENCES purchase(id),
  line_no INTEGER NOT NULL,
  stock_item_id TEXT NOT NULL REFERENCES stock_item(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_cost_paise INTEGER NOT NULL CHECK (unit_cost_paise >= 0),
  amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
  PRIMARY KEY (purchase_id, line_no)
);
CREATE INDEX idx_purchase_line_item ON purchase_line (stock_item_id);
CREATE TRIGGER purchase_line_no_update BEFORE UPDATE ON purchase_line
  BEGIN SELECT RAISE(ABORT, 'purchase lines are immutable'); END;
CREATE TRIGGER purchase_line_no_delete BEFORE DELETE ON purchase_line
  BEGIN SELECT RAISE(ABORT, 'purchase lines cannot be deleted'); END;

-- How much of each material ONE unit of an item, variant or add-on uses. A variant's recipe replaces its item's.
CREATE TABLE recipe_line (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('item', 'variant', 'addon')),
  owner_id TEXT NOT NULL,
  stock_item_id TEXT NOT NULL REFERENCES stock_item(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  PRIMARY KEY (owner_kind, owner_id, stock_item_id)
);
CREATE INDEX idx_recipe_line_stock ON recipe_line (stock_item_id);

INSERT INTO role_permission (role_id, permission, needs_pin) VALUES
  ('01JR0000000000000000000001', 'stock.manage', 0),
  ('01JR0000000000000000000002', 'stock.manage', 0);
