import { exec, many, one, tx } from './db.ts';
import type { Db } from './db.ts';
import { HubError } from './hub.ts';
import type { SalesSync } from './sync.ts';

/**
 * Sales analytics for the customer portal (GET /v1/account/analytics): an account's outlets, grouped by brand, each
 * with its POS terminals.
 *
 * How it is kept fast and safe:
 *  - sync_event (src/sync.ts) stays the record of what each outlet sent. Nothing here changes it.
 *  - sale_bill: one row per bill, updated in the same transaction that stores its sync events (SalesSync.onStored).
 *  - sale_slice / sale_item / sale_tender: small totals per outlet and business day. The portal reads only these, so a
 *    dashboard costs the same for 100 bills a day or 5,000. A day whose bills changed is marked in sale_dirty and
 *    added up again on the next read (a few milliseconds per outlet day).
 *  - Everything here can be rebuilt from sync_event (rebuildAll); the first start after this was added does that.
 *  - Answers are kept for 30 seconds per account and filter, so a page left open or refreshed costs nothing.
 *
 * What a POS sends (sync events, POST /v1/pos/sync/batches). The first five fields are the original contract; the
 * rest were added for analytics and are all optional, so older POS builds keep working (their bills count in sales,
 * orders, days, hours and payments; items, order types and terminals show as "not recorded"):
 *   bill.printed  { billId, billNo, totalPaise, businessDate, orderType: dine_in|takeaway|delivery,
 *                   channel: pos|website|app|swiggy|zomato, terminal, covers, taxPaise, discountPaise,
 *                   lines: [{ name, category, qty, amountPaise }] }
 *   bill.settled  { billId, tenders: [{ mode, amountPaise }], changePaise }
 *   bill.voided   { billId }
 *   bill.refunded { billId (the credit note), refundPaise, businessDate, terminal, tenders }
 * Sales are bill totals (what the guest paid, taxes included). Times are India time.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sale_bill (
  store_id TEXT NOT NULL, bill_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'sale', business_date TEXT NOT NULL, at INTEGER NOT NULL,
  total INTEGER NOT NULL DEFAULT 0, voided INTEGER NOT NULL DEFAULT 0, terminal TEXT, order_type TEXT, channel TEXT,
  tax INTEGER, discount INTEGER, covers INTEGER, lines_json TEXT, tenders_json TEXT, change INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, bill_id)
);
CREATE INDEX IF NOT EXISTS sale_bill_day ON sale_bill(store_id, business_date);
CREATE TABLE IF NOT EXISTS sale_slice (
  store_id TEXT NOT NULL, business_date TEXT NOT NULL, hour INTEGER NOT NULL, terminal TEXT NOT NULL, order_type TEXT NOT NULL, channel TEXT NOT NULL,
  bills INTEGER NOT NULL, sales INTEGER NOT NULL, tax INTEGER NOT NULL, discount INTEGER NOT NULL, covers INTEGER NOT NULL,
  voids INTEGER NOT NULL, void_amount INTEGER NOT NULL, refunds INTEGER NOT NULL, refund_amount INTEGER NOT NULL,
  PRIMARY KEY (store_id, business_date, hour, terminal, order_type, channel)
);
CREATE TABLE IF NOT EXISTS sale_item (
  store_id TEXT NOT NULL, business_date TEXT NOT NULL, terminal TEXT NOT NULL, item TEXT NOT NULL, category TEXT NOT NULL,
  qty_milli INTEGER NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (store_id, business_date, terminal, item, category)
);
CREATE TABLE IF NOT EXISTS sale_tender (
  store_id TEXT NOT NULL, business_date TEXT NOT NULL, terminal TEXT NOT NULL, mode TEXT NOT NULL, amount INTEGER NOT NULL,
  PRIMARY KEY (store_id, business_date, terminal, mode)
);
CREATE TABLE IF NOT EXISTS sale_dirty (store_id TEXT NOT NULL, business_date TEXT NOT NULL, PRIMARY KEY (store_id, business_date));
`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IST_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 366;
const CACHE_MS = 30_000;
const ORDER_TYPES = new Set(['dine_in', 'takeaway', 'delivery']);
const CHANNELS = new Set(['pos', 'website', 'app', 'swiggy', 'zomato']);

const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);
const intOrNull = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS) + 1;

interface Line { name: string; category: string; qtyMilli: number; amount: number }
interface Tender { mode: string; amount: number }

function readLines(v: unknown): Line[] | null {
  if (!Array.isArray(v)) return null;
  const out: Line[] = [];
  for (const raw of v.slice(0, 300)) {
    const l = raw as Record<string, unknown> | null;
    const name = text(l?.name, 80);
    if (!l || !name) continue;
    const qtyMilli = typeof l.qtyMilli === 'number' ? int(l.qtyMilli) : Math.round((typeof l.qty === 'number' && Number.isFinite(l.qty) ? l.qty : 0) * 1000);
    if (qtyMilli <= 0 || qtyMilli > 1e9) continue;
    out.push({ name, category: text(l.category, 60), qtyMilli, amount: int(l.amountPaise) });
  }
  return out;
}

function readTenders(v: unknown): Tender[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 20).map((t) => ({ mode: text((t as Tender | null)?.mode, 20).toLowerCase() || 'other', amount: int((t as { amountPaise?: unknown } | null)?.amountPaise) })).filter((t) => t.amount > 0);
}

interface BillRow {
  bill_id: string; kind: string; at: number; total: number; voided: number; terminal: string | null; order_type: string | null; channel: string | null;
  tax: number | null; discount: number | null; covers: number | null; lines_json: string | null; tenders_json: string | null; change: number;
}
interface ScopeStore { id: string; slug: string; name: string; product: string | null; brand: string | null; brandName: string | null; lastSyncAt: number | null }
interface Totals { sales: number; orders: number; avgTicket: number; tax: number; discount: number; covers: number; voids: number; voidAmount: number; refunds: number; refundAmount: number }

export class Analytics {
  private db: Db; private now: () => number;
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(db: Db, now: () => number, sync: SalesSync) {
    this.db = db; this.now = now;
    db.exec(SCHEMA);
    sync.onStored = (storeId, kind, payload, createdAt) => this.apply(storeId, kind, payload, createdAt);
    if (!one(db, "SELECT 1 FROM setting WHERE key = 'analytics_built'")) this.rebuildAll();
  }

  /** Builds every table here again from sync_event (the first start, or after a repair). */
  rebuildAll(): void {
    tx(this.db, () => {
      this.db.exec('DELETE FROM sale_bill; DELETE FROM sale_slice; DELETE FROM sale_item; DELETE FROM sale_tender; DELETE FROM sale_dirty;');
      const rows = this.db.prepare("SELECT store_id, kind, payload_json, created_at FROM sync_event WHERE kind LIKE 'bill.%' ORDER BY received_at, store_id, stream_id, seq").iterate() as Iterable<{ store_id: string; kind: string; payload_json: string; created_at: string }>;
      for (const r of rows) {
        try { this.apply(r.store_id, r.kind, JSON.parse(r.payload_json), r.created_at); } catch { /* one unreadable record never stops the rest */ }
      }
      exec(this.db, "INSERT INTO setting (key, value_json, updated_at) VALUES ('analytics_built', '1', ?) ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at", this.now());
    });
    this.cache.clear();
  }

  /** One stored sync event (called inside the transaction that stored it). Other kinds are ignored. */
  apply(storeId: string, kind: string, payload: unknown, createdAt: string): void {
    if (kind !== 'bill.printed' && kind !== 'bill.settled' && kind !== 'bill.voided' && kind !== 'bill.refunded') return;
    const p = payload as Record<string, unknown> | null;
    const billId = text(p?.billId, 80);
    if (!p || typeof p !== 'object' || !billId) return;
    const parsed = Date.parse(createdAt);
    const at = Number.isFinite(parsed) ? parsed : this.now();
    const had = one<{ business_date: string }>(this.db, 'SELECT business_date FROM sale_bill WHERE store_id = ? AND bill_id = ?', storeId, billId);
    const day = typeof p.businessDate === 'string' && DATE.test(p.businessDate) ? p.businessDate : had?.business_date ?? istDate(at);
    const total = int(kind === 'bill.refunded' ? p.refundPaise : p.totalPaise);
    if (!had) exec(this.db, 'INSERT INTO sale_bill (store_id, bill_id, kind, business_date, at, total) VALUES (?,?,?,?,?,?)', storeId, billId, kind === 'bill.refunded' ? 'refund' : 'sale', day, at, total);

    if (kind === 'bill.printed' || kind === 'bill.refunded') {
      const type = text(p.orderType, 20), channel = text(p.channel, 20).toLowerCase();
      const lines = readLines(p.lines);
      // a bill printed again after changes: its latest figures (what it does not say stays as it was)
      exec(this.db, `UPDATE sale_bill SET business_date = ?, total = ?, terminal = COALESCE(?, terminal), order_type = COALESCE(?, order_type), channel = COALESCE(?, channel),
          tax = COALESCE(?, tax), discount = COALESCE(?, discount), covers = COALESCE(?, covers), lines_json = COALESCE(?, lines_json) WHERE store_id = ? AND bill_id = ?`,
        day, total, text(p.terminal, 60) || null, ORDER_TYPES.has(type) ? type : null, CHANNELS.has(channel) ? channel : null,
        intOrNull(p.taxPaise), intOrNull(p.discountPaise), intOrNull(p.covers), lines ? JSON.stringify(lines) : null, storeId, billId);
    }
    if (kind === 'bill.settled' || (kind === 'bill.refunded' && Array.isArray(p.tenders))) {
      exec(this.db, 'UPDATE sale_bill SET tenders_json = ?, change = ? WHERE store_id = ? AND bill_id = ?', JSON.stringify(readTenders(p.tenders)), Math.max(0, int(p.changePaise)), storeId, billId);
      // a split bill: its first part keeps the bill's id with a smaller amount, and parts are settled, not printed again
      if (kind === 'bill.settled' && total > 0) exec(this.db, 'UPDATE sale_bill SET total = ? WHERE store_id = ? AND bill_id = ?', total, storeId, billId);
    }
    if (kind === 'bill.voided') exec(this.db, 'UPDATE sale_bill SET voided = 1 WHERE store_id = ? AND bill_id = ?', storeId, billId);

    const dirty = 'INSERT OR IGNORE INTO sale_dirty (store_id, business_date) VALUES (?,?)';
    exec(this.db, dirty, storeId, day);
    if (had && had.business_date !== day) exec(this.db, dirty, storeId, had.business_date);
  }

  /** Adds one outlet day up again from its bills. */
  private rebuildDay(storeId: string, day: string): void {
    const bills = many<BillRow>(this.db, 'SELECT * FROM sale_bill WHERE store_id = ? AND business_date = ?', storeId, day);
    const slices = new Map<string, number[]>(), items = new Map<string, number[]>(), tenders = new Map<string, number>();
    for (const b of bills) {
      const terminal = b.terminal ?? '', refund = b.kind === 'refund';
      const hour = new Date(b.at + IST_MS).getUTCHours();
      const key = JSON.stringify([hour, terminal, b.order_type ?? '', b.channel ?? '']);
      const s = slices.get(key) ?? [0, 0, 0, 0, 0, 0, 0, 0, 0]; // bills, sales, tax, discount, covers, voids, void amount, refunds, refund amount
      slices.set(key, s);
      if (refund) { s[1]! -= b.total; s[7]!++; s[8]! += b.total; }
      else if (b.voided) { s[5]!++; s[6]! += b.total; }
      else { s[0]!++; s[1]! += b.total; s[2]! += b.tax ?? 0; s[3]! += b.discount ?? 0; s[4]! += b.covers ?? 0; }
      if (b.voided) continue;
      const sign = refund ? -1 : 1;
      if (!refund && b.lines_json) for (const l of JSON.parse(b.lines_json) as Line[]) {
        const k = JSON.stringify([terminal, l.name, l.category]);
        const i = items.get(k) ?? [0, 0];
        items.set(k, i); i[0]! += l.qtyMilli; i[1]! += l.amount;
      }
      if (b.tenders_json) {
        let change = b.change; // change is given back in cash
        for (const t of JSON.parse(b.tenders_json) as Tender[]) {
          const back = t.mode === 'cash' ? Math.min(change, t.amount) : 0;
          change -= back;
          const k = JSON.stringify([terminal, t.mode]);
          tenders.set(k, (tenders.get(k) ?? 0) + sign * (t.amount - back));
        }
      }
    }
    tx(this.db, () => {
      for (const t of ['sale_slice', 'sale_item', 'sale_tender', 'sale_dirty']) exec(this.db, `DELETE FROM ${t} WHERE store_id = ? AND business_date = ?`, storeId, day);
      for (const [k, s] of slices) {
        const [hour, terminal, type, channel] = JSON.parse(k) as [number, string, string, string];
        exec(this.db, 'INSERT INTO sale_slice VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', storeId, day, hour, terminal, type, channel, ...(s as [number, number, number, number, number, number, number, number, number]));
      }
      for (const [k, i] of items) {
        const [terminal, item, category] = JSON.parse(k) as [string, string, string];
        exec(this.db, 'INSERT INTO sale_item VALUES (?,?,?,?,?,?,?)', storeId, day, terminal, item, category, i[0]!, i[1]!);
      }
      for (const [k, amount] of tenders) {
        const [terminal, mode] = JSON.parse(k) as [string, string];
        if (amount !== 0) exec(this.db, 'INSERT INTO sale_tender VALUES (?,?,?,?,?)', storeId, day, terminal, mode, amount);
      }
    });
  }

  /** The account's outlets with their brand (a store is in one brand at most) and when each last sent sales. */
  private scope(accountId: string): ScopeStore[] {
    return many<ScopeStore>(this.db, `SELECT s.id, s.slug, s.name, s.pos_type AS product, b.slug AS brand, b.name AS brandName,
        (SELECT max(last_at) FROM sync_stream WHERE store_id = s.id) AS lastSyncAt
      FROM account_store x JOIN store s ON s.id = x.store_id LEFT JOIN brand_store bs ON bs.store_id = s.id LEFT JOIN brand b ON b.id = bs.brand_id
      WHERE x.account_id = ? ORDER BY s.name, s.slug`, accountId);
  }

  /**
   * GET /v1/account/analytics?from=&to=&brand=&store=&terminal= for one account. Dates are business dates (India);
   * the default is the last 30 days. brand and store are addresses (slugs) of the account's own; terminal is a name.
   */
  query(accountId: string, q: URLSearchParams) {
    const today = istDate(this.now());
    const to = q.get('to') || today, from = q.get('from') || addDays(to, -29);
    if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to) throw new HubError('VALIDATION', 'Choose a start date and an end date (the start first).');
    const days = daysBetween(from, to);
    if (days > MAX_RANGE_DAYS) throw new HubError('VALIDATION', `Choose at most ${MAX_RANGE_DAYS} days.`);
    const brand = q.get('brand') || null, store = q.get('store') || null, terminal = q.get('terminal') || null;

    const key = JSON.stringify([accountId, from, to, brand, store, terminal]);
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS && this.now() >= hit.at) return hit.value;

    const all = this.scope(accountId);
    if (brand && !all.some((s) => s.brand === brand)) throw new HubError('NOT_FOUND', 'That brand is not in your account.', 404);
    if (store && !all.some((s) => s.slug === store)) throw new HubError('NOT_FOUND', 'That outlet is not in your account.', 404);
    const chosen = all.filter((s) => (!brand || s.brand === brand) && (!store || s.slug === store));
    const ids = chosen.map((s) => s.id);
    const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));

    const value = ids.length === 0 ? this.empty(all, from, to, days, prevFrom, prevTo) : this.compute(all, chosen, ids, { from, to, days, prevFrom, prevTo, terminal });
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  private filters(all: ScopeStore[]) {
    const brands = new Map<string, string>();
    for (const s of all) if (s.brand) brands.set(s.brand, s.brandName ?? s.brand);
    return {
      brands: [...brands].map(([slug, name]) => ({ slug, name })).sort((a, b) => a.name.localeCompare(b.name)),
      stores: all.map((s) => ({ slug: s.slug, name: s.name, product: s.product, brand: s.brand, lastSyncAt: s.lastSyncAt })),
    };
  }

  private empty(all: ScopeStore[], from: string, to: string, days: number, prevFrom: string, prevTo: string) {
    const zero: Totals = { sales: 0, orders: 0, avgTicket: 0, tax: 0, discount: 0, covers: 0, voids: 0, voidAmount: 0, refunds: 0, refundAmount: 0 };
    return { range: { from, to, days }, previous: { from: prevFrom, to: prevTo }, filters: { ...this.filters(all), terminals: [] as Array<{ store: string; name: string }> }, totals: zero, previousTotals: zero,
      daily: [], hours: [], topItems: [], categories: [], itemTotals: { qtyMilli: 0, amount: 0 }, orderTypes: [], channels: [], payments: [], outlets: [], terminals: [],
      recorded: { items: false, orderTypes: false, terminals: false }, lastSyncAt: null as number | null, generatedAt: this.now() };
  }

  private compute(all: ScopeStore[], chosen: ScopeStore[], ids: string[], r: { from: string; to: string; days: number; prevFrom: string; prevTo: string; terminal: string | null }) {
    // days whose bills changed since they were last added up (both periods)
    const marks = ids.map(() => '?').join(',');
    for (const d of many<{ store_id: string; business_date: string }>(this.db, `SELECT store_id, business_date FROM sale_dirty WHERE store_id IN (${marks}) AND business_date BETWEEN ? AND ?`, ...ids, r.prevFrom, r.to)) this.rebuildDay(d.store_id, d.business_date);

    const term = r.terminal === null ? '' : ' AND terminal = ?';
    const args = (from: string, to: string) => [...ids, from, to, ...(r.terminal === null ? [] : [r.terminal])];
    const where = `store_id IN (${marks}) AND business_date BETWEEN ? AND ?${term}`;
    const SUMS = 'COALESCE(sum(bills),0) AS orders, COALESCE(sum(sales),0) AS sales, COALESCE(sum(tax),0) AS tax, COALESCE(sum(discount),0) AS discount, COALESCE(sum(covers),0) AS covers, COALESCE(sum(voids),0) AS voids, COALESCE(sum(void_amount),0) AS voidAmount, COALESCE(sum(refunds),0) AS refunds, COALESCE(sum(refund_amount),0) AS refundAmount';
    const totals = (from: string, to: string): Totals => {
      const t = one<Omit<Totals, 'avgTicket'>>(this.db, `SELECT ${SUMS} FROM sale_slice WHERE ${where}`, ...args(from, to))!;
      return { ...t, avgTicket: t.orders > 0 ? Math.round(t.sales / t.orders) : 0 };
    };
    const cur = args(r.from, r.to);

    const byDay = new Map(many<{ date: string; sales: number; orders: number }>(this.db, `SELECT business_date AS date, sum(sales) AS sales, sum(bills) AS orders FROM sale_slice WHERE ${where} GROUP BY business_date`, ...cur).map((d) => [d.date, d]));
    const daily = Array.from({ length: r.days }, (_, i) => { const date = addDays(r.from, i); return byDay.get(date) ?? { date, sales: 0, orders: 0 }; });

    const hours = many<{ dow: number; hour: number; orders: number; sales: number }>(this.db, `SELECT CAST(strftime('%w', business_date) AS INTEGER) AS dow, hour, sum(bills) AS orders, sum(sales) AS sales FROM sale_slice WHERE ${where} GROUP BY 1, 2 HAVING sum(bills) > 0`, ...cur);
    const split = (col: string) => many<{ key: string; orders: number; sales: number }>(this.db, `SELECT ${col} AS key, sum(bills) AS orders, sum(sales) AS sales FROM sale_slice WHERE ${where} GROUP BY 1 HAVING sum(bills) > 0 ORDER BY 3 DESC`, ...cur);
    const orderTypes = split('order_type').map(({ key, ...v }) => ({ type: key, ...v }));
    const channels = split('channel').map(({ key, ...v }) => ({ channel: key, ...v }));

    const topItems = many<{ name: string; category: string; qtyMilli: number; amount: number }>(this.db, `SELECT item AS name, max(category) AS category, sum(qty_milli) AS qtyMilli, sum(amount) AS amount FROM sale_item WHERE ${where} GROUP BY item ORDER BY 3 DESC, 4 DESC LIMIT 10`, ...cur);
    const categories = many<{ name: string; qtyMilli: number; amount: number }>(this.db, `SELECT category AS name, sum(qty_milli) AS qtyMilli, sum(amount) AS amount FROM sale_item WHERE ${where} AND category <> '' GROUP BY category ORDER BY 3 DESC LIMIT 8`, ...cur);
    const itemTotals = one<{ qtyMilli: number; amount: number }>(this.db, `SELECT COALESCE(sum(qty_milli),0) AS qtyMilli, COALESCE(sum(amount),0) AS amount FROM sale_item WHERE ${where}`, ...cur)!;
    const payments = many<{ mode: string; amount: number }>(this.db, `SELECT mode, sum(amount) AS amount FROM sale_tender WHERE ${where} GROUP BY mode HAVING sum(amount) <> 0 ORDER BY 2 DESC`, ...cur);

    const perStore = (from: string, to: string) => new Map(many<{ store_id: string; sales: number; orders: number }>(this.db, `SELECT store_id, sum(sales) AS sales, sum(bills) AS orders FROM sale_slice WHERE ${where} GROUP BY store_id`, ...args(from, to)).map((x) => [x.store_id, x]));
    const now = perStore(r.from, r.to), before = perStore(r.prevFrom, r.prevTo);
    const outlets = chosen.map((s) => {
      const n = now.get(s.id), b = before.get(s.id);
      return { slug: s.slug, name: s.name, product: s.product, brand: s.brand, brandName: s.brandName, lastSyncAt: s.lastSyncAt,
        sales: n?.sales ?? 0, orders: n?.orders ?? 0, avgTicket: n && n.orders > 0 ? Math.round(n.sales / n.orders) : 0, previousSales: b?.sales ?? 0 };
    }).sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));

    const slugOf = new Map(chosen.map((s) => [s.id, s]));
    const terminals = many<{ store_id: string; name: string; sales: number; orders: number }>(this.db, `SELECT store_id, terminal AS name, sum(sales) AS sales, sum(bills) AS orders FROM sale_slice WHERE ${where} AND terminal <> '' GROUP BY store_id, terminal ORDER BY 3 DESC`, ...cur)
      .map((t) => ({ store: slugOf.get(t.store_id)!.slug, storeName: slugOf.get(t.store_id)!.name, name: t.name, sales: t.sales, orders: t.orders, avgTicket: t.orders > 0 ? Math.round(t.sales / t.orders) : 0 }));
    // every terminal that ever billed in these outlets (for the terminal filter), not only those in this period
    const known = many<{ store_id: string; name: string }>(this.db, `SELECT DISTINCT store_id, terminal AS name FROM sale_slice WHERE store_id IN (${marks}) AND terminal <> '' ORDER BY 2`, ...ids)
      .map((t) => ({ store: slugOf.get(t.store_id)!.slug, name: t.name }));

    const lastSyncAt = chosen.reduce<number | null>((m, s) => (s.lastSyncAt !== null && (m === null || s.lastSyncAt > m) ? s.lastSyncAt : m), null);
    return {
      range: { from: r.from, to: r.to, days: r.days }, previous: { from: r.prevFrom, to: r.prevTo },
      filters: { ...this.filters(all), terminals: known },
      totals: totals(r.from, r.to), previousTotals: totals(r.prevFrom, r.prevTo),
      daily, hours, topItems, categories, itemTotals, orderTypes, channels, payments, outlets, terminals,
      // what the POS builds in these outlets record: older builds send bill totals only
      recorded: { items: itemTotals.qtyMilli > 0, orderTypes: orderTypes.some((t) => t.type !== ''), terminals: terminals.length > 0 },
      lastSyncAt, generatedAt: this.now(),
    };
  }
}
