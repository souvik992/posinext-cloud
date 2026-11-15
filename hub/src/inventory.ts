import { exec, many, one, tx } from './db.ts';
import type { Db } from './db.ts';
import { HubError } from './hub.ts';
import type { DeviceRef } from './hub.ts';
import type { SalesSync } from './sync.ts';
import { accountStores, MAX_RANGE_DAYS } from './analytics.ts';
import type { Analytics } from './analytics.ts';

/**
 * Purchases and stock for the customer portal (GET /v1/account/inventory), view only: staff enter purchases and counts
 * in the POS at the outlet; the portal shows them across the account's outlets.
 *
 *  - Purchases are facts that never change, so they travel in the sales sync stream (POST /v1/pos/sync/batches):
 *      purchase.recorded { purchaseId, supplier, billNo, businessDate, totalPaise, lines: [{ name, unit, qtyMilli, amountPaise }] }
 *      purchase.voided   { purchaseId }
 *    inv_purchase holds one row per purchase and can be rebuilt from sync_event.
 *  - Stock on hand is a state, not a fact: the POS sends the whole list when it changed (PUT /v1/pos/inventory) and the
 *    latest one replaces the one before. Sending it twice or late does no harm; an older one than the hub holds is ignored.
 *      { at, items: [{ id, name, unit, onHandMilli, reorderMilli, unitCostPaise }], usage: [{ date, usedPaise, wastePaise }] }
 *    usage: what the day's sales used and what was wasted, valued at each material's last cost (the POS works it out).
 * Quantities are thousandths of the unit; amounts are paise.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inv_purchase (
  store_id TEXT NOT NULL, purchase_id TEXT NOT NULL, business_date TEXT NOT NULL, at INTEGER NOT NULL, supplier TEXT NOT NULL, bill_no TEXT,
  total INTEGER NOT NULL, voided INTEGER NOT NULL DEFAULT 0, lines_json TEXT NOT NULL, PRIMARY KEY (store_id, purchase_id)
);
CREATE INDEX IF NOT EXISTS inv_purchase_day ON inv_purchase(store_id, business_date);
CREATE TABLE IF NOT EXISTS inv_stock (
  store_id TEXT NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, on_hand_milli INTEGER NOT NULL, reorder_milli INTEGER NOT NULL,
  unit_cost INTEGER, PRIMARY KEY (store_id, item_id)
);
CREATE TABLE IF NOT EXISTS inv_stock_at (store_id TEXT PRIMARY KEY, at INTEGER NOT NULL, received_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inv_usage (store_id TEXT NOT NULL, business_date TEXT NOT NULL, used INTEGER NOT NULL, waste INTEGER NOT NULL, PRIMARY KEY (store_id, business_date));
`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000, IST_MS = 5.5 * 3_600_000, CACHE_MS = 30_000;
export const MAX_STOCK_ITEMS = 5000;
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

interface PLine { name: string; unit: string; qtyMilli: number; amount: number }
interface PurchaseRow { store_id: string; purchase_id: string; business_date: string; at: number; supplier: string; bill_no: string | null; total: number; lines_json: string }
interface StockRow { store_id: string; item_id: string; name: string; unit: string; on_hand_milli: number; reorder_milli: number; unit_cost: number | null }

/** What the stock is worth at its last cost (never negative: an item sold below zero is worth nothing, not less). */
const worth = (s: StockRow) => (s.unit_cost === null || s.on_hand_milli <= 0 ? 0 : Math.round((s.on_hand_milli * s.unit_cost) / 1000));
const isLow = (s: StockRow) => s.reorder_milli > 0 && s.on_hand_milli <= s.reorder_milli;

export class Inventory {
  private db: Db; private now: () => number; private analytics: Analytics;
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(db: Db, now: () => number, sync: SalesSync, analytics: Analytics) {
    this.db = db; this.now = now; this.analytics = analytics;
    db.exec(SCHEMA);
    const before = sync.onStored; // analytics listens too
    sync.onStored = (storeId, kind, payload, createdAt) => { before?.(storeId, kind, payload, createdAt); this.apply(storeId, kind, payload, createdAt); };
    if (!one(db, "SELECT 1 FROM setting WHERE key = 'inventory_built'")) this.rebuildPurchases();
  }

  /** Purchases again from sync_event (the first start, or after a repair). Stock lists come again from each POS by themselves. */
  rebuildPurchases(): void {
    tx(this.db, () => {
      this.db.exec('DELETE FROM inv_purchase');
      const rows = this.db.prepare("SELECT store_id, kind, payload_json, created_at FROM sync_event WHERE kind LIKE 'purchase.%' ORDER BY received_at, store_id, stream_id, seq").iterate() as Iterable<{ store_id: string; kind: string; payload_json: string; created_at: string }>;
      for (const r of rows) { try { this.apply(r.store_id, r.kind, JSON.parse(r.payload_json), r.created_at); } catch { /* one unreadable record never stops the rest */ } }
      exec(this.db, "INSERT INTO setting (key, value_json, updated_at) VALUES ('inventory_built', '1', ?) ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at", this.now());
    });
    this.cache.clear();
  }

  /** One stored sync event (inside the transaction that stored it). */
  private apply(storeId: string, kind: string, payload: unknown, createdAt: string): void {
    if (kind !== 'purchase.recorded' && kind !== 'purchase.voided') return;
    const p = payload as Record<string, unknown> | null;
    const id = text(p?.purchaseId, 80);
    if (!p || typeof p !== 'object' || !id) return;
    if (kind === 'purchase.voided') { exec(this.db, 'UPDATE inv_purchase SET voided = 1 WHERE store_id = ? AND purchase_id = ?', storeId, id); return; }
    const parsed = Date.parse(createdAt), at = Number.isFinite(parsed) ? parsed : this.now();
    const lines: PLine[] = (Array.isArray(p.lines) ? p.lines.slice(0, 300) : []).map((l) => {
      const x = (l ?? {}) as Record<string, unknown>;
      return { name: text(x.name, 80), unit: text(x.unit, 8), qtyMilli: Math.max(0, int(x.qtyMilli)), amount: Math.max(0, int(x.amountPaise)) };
    }).filter((l) => l.name);
    const day = typeof p.businessDate === 'string' && DATE.test(p.businessDate) ? p.businessDate : istDate(at);
    // sent again (a new sync stream after a restore): the same purchase, kept once; a void already held stays
    exec(this.db, `INSERT INTO inv_purchase (store_id, purchase_id, business_date, at, supplier, bill_no, total, lines_json) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (store_id, purchase_id) DO UPDATE SET business_date = excluded.business_date, supplier = excluded.supplier, bill_no = excluded.bill_no, total = excluded.total, lines_json = excluded.lines_json`,
      storeId, id, day, at, text(p.supplier, 80) || 'Unknown supplier', text(p.billNo, 40) || null, Math.max(0, int(p.totalPaise)), JSON.stringify(lines));
  }

  /** PUT /v1/pos/inventory: the outlet's whole stock list as it is now, and what recent days used. */
  putStock(dev: DeviceRef, body: unknown): { ok: true; items: number; kept: boolean } {
    const b = (body ?? {}) as { at?: unknown; items?: unknown; usage?: unknown };
    const bad = (m: string) => new HubError('VALIDATION', m);
    if (!Array.isArray(b.items) || b.items.length > MAX_STOCK_ITEMS) throw bad(`Send the stock list as items (at most ${MAX_STOCK_ITEMS}).`);
    const at = typeof b.at === 'number' && Number.isSafeInteger(b.at) && b.at > 0 ? Math.min(b.at, this.now() + 300_000) : this.now();
    const seen = new Set<string>();
    const items = b.items.map((raw, i) => {
      const x = (raw ?? {}) as Record<string, unknown>;
      const id = text(x.id, 80), name = text(x.name, 80);
      if (!id || !name || seen.has(id)) throw bad(`Stock item ${i + 1} needs its own id and a name.`);
      seen.add(id);
      const cost = typeof x.unitCostPaise === 'number' && Number.isSafeInteger(x.unitCostPaise) && x.unitCostPaise >= 0 ? x.unitCostPaise : null;
      return { id, name, unit: text(x.unit, 8) || 'pcs', onHand: int(x.onHandMilli), reorder: Math.max(0, int(x.reorderMilli)), cost };
    });
    const usage = (Array.isArray(b.usage) ? b.usage.slice(0, 62) : []).map((raw) => {
      const x = (raw ?? {}) as Record<string, unknown>;
      return { date: typeof x.date === 'string' && DATE.test(x.date) ? x.date : '', used: Math.max(0, int(x.usedPaise)), waste: Math.max(0, int(x.wastePaise)) };
    }).filter((u) => u.date);
    const held = one<{ at: number }>(this.db, 'SELECT at FROM inv_stock_at WHERE store_id = ?', dev.storeId);
    if (held && held.at > at) return { ok: true, items: items.length, kept: false }; // an older list arriving late
    tx(this.db, () => {
      exec(this.db, 'DELETE FROM inv_stock WHERE store_id = ?', dev.storeId);
      for (const i of items) exec(this.db, 'INSERT INTO inv_stock (store_id, item_id, name, unit, on_hand_milli, reorder_milli, unit_cost) VALUES (?,?,?,?,?,?,?)', dev.storeId, i.id, i.name, i.unit, i.onHand, i.reorder, i.cost);
      for (const u of usage) exec(this.db, 'INSERT INTO inv_usage (store_id, business_date, used, waste) VALUES (?,?,?,?) ON CONFLICT (store_id, business_date) DO UPDATE SET used = excluded.used, waste = excluded.waste', dev.storeId, u.date, u.used, u.waste);
      exec(this.db, 'INSERT INTO inv_stock_at (store_id, at, received_at) VALUES (?,?,?) ON CONFLICT (store_id) DO UPDATE SET at = excluded.at, received_at = excluded.received_at', dev.storeId, at, this.now());
    });
    return { ok: true, items: items.length, kept: true };
  }

  /** GET /v1/account/inventory?from=&to=&brand=&store= for one account (the same dates and filters as analytics). */
  query(accountId: string, q: URLSearchParams) {
    const to = q.get('to') || istDate(this.now()), from = q.get('from') || addDays(to, -29);
    if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to) throw new HubError('VALIDATION', 'Choose a start date and an end date (the start first).');
    const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
    if (days > MAX_RANGE_DAYS) throw new HubError('VALIDATION', `Choose at most ${MAX_RANGE_DAYS} days.`);
    const brand = q.get('brand') || null, store = q.get('store') || null;
    const key = JSON.stringify([accountId, from, to, brand, store]);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS && this.now() >= hit.at) return hit.value;

    const all = accountStores(this.db, accountId);
    if (brand && !all.some((s) => s.brand === brand)) throw new HubError('NOT_FOUND', 'That brand is not in your account.', 404);
    if (store && !all.some((s) => s.slug === store)) throw new HubError('NOT_FOUND', 'That outlet is not in your account.', 404);
    const chosen = all.filter((s) => (!brand || s.brand === brand) && (!store || s.slug === store));
    const ids = chosen.map((s) => s.id), marks = ids.map(() => '?').join(',') || "''";
    const of = new Map(chosen.map((s) => [s.id, s]));
    const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));

    // ---- stock now
    const stockRows = many<StockRow>(this.db, `SELECT * FROM inv_stock WHERE store_id IN (${marks}) ORDER BY name COLLATE NOCASE`, ...ids);
    const sentAt = new Map(many<{ store_id: string; at: number }>(this.db, `SELECT store_id, at FROM inv_stock_at WHERE store_id IN (${marks})`, ...ids).map((r) => [r.store_id, r.at]));
    const item = (s: StockRow) => ({ store: of.get(s.store_id)!.slug, storeName: of.get(s.store_id)!.name, name: s.name, unit: s.unit, onHandMilli: s.on_hand_milli, reorderMilli: s.reorder_milli, unitCost: s.unit_cost, value: worth(s), low: isLow(s) });
    const low = stockRows.filter(isLow).sort((a, b) => a.on_hand_milli / a.reorder_milli - b.on_hand_milli / b.reorder_milli);
    const outlets = chosen.map((s) => {
      const mine = stockRows.filter((r) => r.store_id === s.id);
      return { slug: s.slug, name: s.name, brandName: s.brandName, items: mine.length, low: mine.filter(isLow).length, value: mine.reduce((t, r) => t + worth(r), 0), updatedAt: sentAt.get(s.id) ?? null };
    }).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

    // ---- purchases in these dates
    const bought = (f: string, t: string) => many<PurchaseRow>(this.db, `SELECT * FROM inv_purchase WHERE store_id IN (${marks}) AND business_date BETWEEN ? AND ? AND voided = 0 ORDER BY business_date DESC, at DESC`, ...ids, f, t);
    const rows = bought(from, to);
    const total = rows.reduce((t, r) => t + r.total, 0);
    const previousTotal = bought(prevFrom, prevTo).reduce((t, r) => t + r.total, 0);
    const suppliers = new Map<string, { supplier: string; total: number; count: number }>();
    const materials = new Map<string, { name: string; unit: string; qtyMilli: number; amount: number }>();
    const byDay = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const sk = r.supplier.toLowerCase(), s = suppliers.get(sk) ?? { supplier: r.supplier, total: 0, count: 0 };
      suppliers.set(sk, s); s.total += r.total; s.count++;
      const d = byDay.get(r.business_date) ?? { total: 0, count: 0 };
      byDay.set(r.business_date, d); d.total += r.total; d.count++;
      for (const l of JSON.parse(r.lines_json) as PLine[]) {
        const mk = `${l.name.toLowerCase()}|${l.unit}`, m = materials.get(mk) ?? { name: l.name, unit: l.unit, qtyMilli: 0, amount: 0 };
        materials.set(mk, m); m.qtyMilli += l.qtyMilli; m.amount += l.amount;
      }
    }
    const usage = one<{ used: number; waste: number; days: number }>(this.db, `SELECT COALESCE(sum(used),0) AS used, COALESCE(sum(waste),0) AS waste, count(DISTINCT business_date) AS days FROM inv_usage WHERE store_id IN (${marks}) AND business_date BETWEEN ? AND ?`, ...ids, from, to)!;
    const sales = ids.length ? this.analytics.salesTotal(ids, from, to) : 0;

    const value = {
      range: { from, to, days }, previous: { from: prevFrom, to: prevTo },
      filters: { brands: [...new Map(all.filter((s) => s.brand).map((s) => [s.brand!, { slug: s.brand!, name: s.brandName ?? s.brand! }])).values()], stores: all.map((s) => ({ slug: s.slug, name: s.name, brand: s.brand })) },
      stock: {
        value: outlets.reduce((t, o) => t + o.value, 0), items: stockRows.length, low: low.length, out: stockRows.filter((s) => s.on_hand_milli <= 0).length,
        updatedAt: outlets.reduce<number | null>((m, o) => (o.updatedAt !== null && (m === null || o.updatedAt < m) ? o.updatedAt : m), null), // the oldest list among the outlets shown
        outlets, lowItems: low.slice(0, 100).map(item),
        // the full list for one outlet only (a chain's combined list would be thousands of rows)
        list: chosen.length === 1 ? stockRows.slice(0, 2000).map(item) : null,
      },
      purchases: {
        total, count: rows.length, previousTotal,
        daily: Array.from({ length: days }, (_, i) => { const date = addDays(from, i); return { date, total: byDay.get(date)?.total ?? 0, count: byDay.get(date)?.count ?? 0 }; }),
        suppliers: [...suppliers.values()].sort((a, b) => b.total - a.total).slice(0, 10),
        materials: [...materials.values()].sort((a, b) => b.amount - a.amount).slice(0, 10),
        recent: rows.slice(0, 50).map((r) => ({ store: of.get(r.store_id)!.slug, storeName: of.get(r.store_id)!.name, date: r.business_date, supplier: r.supplier, billNo: r.bill_no, total: r.total, lines: (JSON.parse(r.lines_json) as PLine[]).length })),
      },
      // what sales used (and what was wasted) at last cost, against sales in the same dates
      cost: { used: usage.used, waste: usage.waste, sales, recorded: usage.days > 0 },
      generatedAt: this.now(),
    };
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, { at: this.now(), value });
    return value;
  }
}
