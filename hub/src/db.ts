import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/** The hub's database (node:sqlite, WAL, synchronous FULL). One file; all writes in short transactions. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  menu_json TEXT, menu_version INTEGER NOT NULL DEFAULT 0,
  accepting INTEGER NOT NULL DEFAULT 0, accepting_reason TEXT,
  order_counter INTEGER NOT NULL DEFAULT 1000, last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES store(id), name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS pairing_code (
  code_hash TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES store(id), expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES store(id), number TEXT NOT NULL, state TEXT NOT NULL,
  data_json TEXT NOT NULL, access_hash TEXT NOT NULL, accept_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (store_id, number)
);
CREATE INDEX IF NOT EXISTS orders_waiting ON orders(state, accept_by);
CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, order_id TEXT, type TEXT NOT NULL, data_json TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS event_store ON event(store_id, seq);
CREATE TABLE IF NOT EXISTS idem (
  scope TEXT NOT NULL, key TEXT NOT NULL, status INTEGER NOT NULL, response_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (scope, key)
);
CREATE TABLE IF NOT EXISTS otp (
  mobile TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_token (token_hash TEXT PRIMARY KEY, mobile TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS image (store_id TEXT NOT NULL REFERENCES store(id), name TEXT NOT NULL, type TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (store_id, name));
CREATE INDEX IF NOT EXISTS event_order ON event(order_id);
CREATE TABLE IF NOT EXISTS order_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL REFERENCES store(id), at INTEGER NOT NULL, channel TEXT, fulfilment TEXT, payment TEXT,
  customer_name TEXT, mobile_masked TEXT, total INTEGER, code TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_attempt_at ON order_attempt(store_id, at);
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- Swiggy / Zomato through UrbanPiper (src/urbanpiper.ts). up_account: the hub's one UrbanPiper account; api_key and
-- webhook_token are secrets (never sent to the admin page). up_link: a store at UrbanPiper; items_json: availability
-- last sent; menu_sig: menu last sent.
CREATE TABLE IF NOT EXISTS up_account (
  id INTEGER PRIMARY KEY CHECK (id = 1), base_url TEXT NOT NULL, username TEXT NOT NULL, api_key TEXT NOT NULL, biz_id TEXT NOT NULL,
  webhook_token TEXT NOT NULL, updated_at INTEGER NOT NULL
);
-- pack_mode/pack_value: packaging charge on the platforms: none, per_item (paise per item), percent (basis points of the item price).
CREATE TABLE IF NOT EXISTS up_link (
  store_id TEXT PRIMARY KEY REFERENCES store(id), location_ref TEXT NOT NULL UNIQUE, city TEXT NOT NULL, address TEXT NOT NULL, phone TEXT NOT NULL,
  platforms_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, items_json TEXT, menu_sig TEXT, store_on INTEGER,
  pack_mode TEXT NOT NULL DEFAULT 'none', pack_value INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- up_order: the platform's order (UrbanPiper id) for each hub order; can_reject: Swiggy lets the store reject it directly
CREATE TABLE IF NOT EXISTS up_order (up_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, order_id TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, can_reject INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS up_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT, kind TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, body_json TEXT NOT NULL,
  label TEXT NOT NULL, order_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, done_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS up_outbox_due ON up_outbox(done_at, next_at);
CREATE TABLE IF NOT EXISTS up_log (id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT, at INTEGER NOT NULL, dir TEXT NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS up_log_store ON up_log(store_id, id);
-- DinePOS sales sync and licence renewals (src/sync.ts). sync_stream: one per outlet database; ack_seq: the highest seq held.
CREATE TABLE IF NOT EXISTS sync_stream (
  store_id TEXT NOT NULL REFERENCES store(id), stream_id TEXT NOT NULL, first_seq INTEGER NOT NULL, ack_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL, last_at INTEGER NOT NULL, PRIMARY KEY (store_id, stream_id)
);
CREATE TABLE IF NOT EXISTS sync_event (
  store_id TEXT NOT NULL, stream_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
  business_date TEXT, created_at TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (store_id, stream_id, seq)
);
CREATE INDEX IF NOT EXISTS sync_event_day ON sync_event(store_id, business_date);
-- website builder sign-ins (src/site.ts): one row per signed-in browser, 30 days; a new editor password ends them all
CREATE TABLE IF NOT EXISTS site_session (token_hash TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES store(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS store_licence (store_id TEXT PRIMARY KEY REFERENCES store(id), licence_key TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- brand websites (src/brands.ts, P6-05): one website for several outlets, each order going to the nearest outlet that can
-- take it. A brand's slug never equals a store's (both are served at /order/<slug>). main_store_id: the outlet whose
-- published website design the brand website shows. brand_store: a store is in at most one brand.
CREATE TABLE IF NOT EXISTS brand (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, main_store_id TEXT REFERENCES store(id), created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS brand_store (store_id TEXT PRIMARY KEY REFERENCES store(id), brand_id TEXT NOT NULL REFERENCES brand(id), added_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS brand_store_brand ON brand_store(brand_id);
-- customer accounts (src/accounts.ts, P7-01, ADR-0006). account: a business that buys DinePOS; status new → trial →
-- active / past_due / suspended / closed. account_user: a person who signs in to the portal (email unique, lower-case;
-- password_hash is scrypt; verified_at set once the emailed code is entered). account_session: portal sign-ins, only
-- the token's SHA-256 kept. email_code: the latest code per person and purpose (verify, reset): hash, 10 min, 5 tries;
-- sends/window_start limit codes to 5 an hour. account_store: the outlets (stores) an account owns.
CREATE TABLE IF NOT EXISTS account (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, gstin TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS account_user (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id), email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','billing')), verified_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_user_account ON account_user(account_id);
CREATE TABLE IF NOT EXISTS account_session (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES account_user(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL, user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS account_session_user ON account_session(user_id);
CREATE TABLE IF NOT EXISTS email_code (
  user_id TEXT NOT NULL REFERENCES account_user(id), purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')), code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sends INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL,
  PRIMARY KEY (user_id, purpose)
);
CREATE TABLE IF NOT EXISTS account_store (store_id TEXT PRIMARY KEY REFERENCES store(id), account_id TEXT NOT NULL REFERENCES account(id), added_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS account_store_account ON account_store(account_id);
-- licence keys signed by this cloud (src/licences.ts, P7-02): append-only. Only revoked_at / revoked_reason may be set,
-- once; a row is never deleted.
CREATE TABLE IF NOT EXISTS licence_grant (
  id TEXT PRIMARY KEY, account_id TEXT REFERENCES account(id), store_id TEXT NOT NULL REFERENCES store(id), hardware_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('trial','paid','demo','manual')), licensee TEXT NOT NULL, seats_json TEXT NOT NULL, features_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, key_text TEXT NOT NULL, revoked_at INTEGER, revoked_reason TEXT, created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS licence_grant_store ON licence_grant(store_id, issued_at);
CREATE INDEX IF NOT EXISTS licence_grant_account ON licence_grant(account_id);
CREATE TRIGGER IF NOT EXISTS licence_grant_no_delete BEFORE DELETE ON licence_grant BEGIN SELECT RAISE(ABORT, 'licence_grant is append-only'); END;
-- licence_grant_only_revoke: made in openHubDb (it names product, a column added after the first release)
`;

export type Db = DatabaseSync;

export function openHubDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // the first UrbanPiper build (never released) kept the account on each store: replace those tables
  const oldLink = (db.prepare('PRAGMA table_info(up_link)').all() as Array<{ name: string }>).some((c) => c.name === 'api_key');
  if (oldLink) db.exec('DROP TABLE up_link; DROP TABLE IF EXISTS up_outbox;');
  db.exec(SCHEMA);
  // columns added after the first release (CREATE TABLE IF NOT EXISTS does not add them to an existing database)
  const storeCols = new Set((db.prepare('PRAGMA table_info(store)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!storeCols.has('paused_reason')) db.exec('ALTER TABLE store ADD COLUMN paused_reason TEXT'); // set: paused by the hub admin
  // the store's website design (src/site.ts): website_json is the published copy, site_draft_json what the builder saved
  if (!storeCols.has('website_json')) db.exec('ALTER TABLE store ADD COLUMN website_json TEXT');
  for (const [col, type] of [['site_draft_json', 'TEXT'], ['site_published_at', 'INTEGER'], ['site_draft_at', 'INTEGER'], ['site_password_hash', 'TEXT']]) {
    if (!storeCols.has(col!)) db.exec(`ALTER TABLE store ADD COLUMN ${col} ${type}`);
  }
  // P8-06 (ADR-0007): the products an account chose (QSR, Fine Dine or both); accounts made before chose Fine Dine
  const accountCols = new Set((db.prepare('PRAGMA table_info(account)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!accountCols.has('products_json')) db.exec(`ALTER TABLE account ADD COLUMN products_json TEXT NOT NULL DEFAULT '["fine_dine"]'`);
  // P8-02 (ADR-0007): which product a key is for (keys made before are DinePOS)
  const grantCols = new Set((db.prepare('PRAGMA table_info(licence_grant)').all() as Array<{ name: string }>).map((c) => c.name));
  if (!grantCols.has('product')) db.exec("ALTER TABLE licence_grant ADD COLUMN product TEXT NOT NULL DEFAULT 'fine_dine'");
  // append-only: only a revoke may be recorded, once
  db.exec(`DROP TRIGGER IF EXISTS licence_grant_only_revoke;
CREATE TRIGGER licence_grant_only_revoke BEFORE UPDATE ON licence_grant
  WHEN OLD.revoked_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.store_id IS NOT OLD.store_id
    OR NEW.hardware_id IS NOT OLD.hardware_id OR NEW.kind IS NOT OLD.kind OR NEW.licensee IS NOT OLD.licensee OR NEW.seats_json IS NOT OLD.seats_json
    OR NEW.features_json IS NOT OLD.features_json OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
    OR NEW.key_text IS NOT OLD.key_text OR NEW.created_by IS NOT OLD.created_by OR NEW.product IS NOT OLD.product
  BEGIN SELECT RAISE(ABORT, 'licence_grant is append-only: only a revoke may be recorded'); END;`);
  return db;
}

type P = string | number | bigint | null | Uint8Array;
export const one = <T>(db: Db, sql: string, ...p: P[]) => db.prepare(sql).get(...p) as T | undefined;
export const many = <T>(db: Db, sql: string, ...p: P[]) => db.prepare(sql).all(...p) as T[];
export const exec = (db: Db, sql: string, ...p: P[]) => db.prepare(sql).run(...p);
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn(); // already inside one (a caller's tx): its COMMIT or ROLLBACK covers this too
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
