import { EventEmitter } from 'node:events';
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { exec, hash, many, one, openHubDb, tx } from './db.ts';
import { BackupStore } from './backups.ts';
import { SalesSync } from './sync.ts';
import type { Db } from './db.ts';
import { canTransition, label, needsRefund } from '../../contract/src/order.ts';
import type { OrderFacts, OrderState } from '../../contract/src/order.ts';
import { REJECT_REASONS } from '../../contract/src/types.ts';
import type { CustomerEvent, ExternalOrder, Order, PosEvent, RejectReason, Rider } from '../../contract/src/types.ts';
import { checkPlaceOrder, MOBILE_RE, normaliseMobile } from '../../contract/src/validate.ts';
import { checkServiceability, isOpen, quote } from '../../contract/src/serviceability.ts';
import { priceOrder } from '../../contract/src/menu.ts';
import type { PublishedMenu } from '../../contract/src/menu.ts';
import { checkSettings, SETTING_DEFAULTS } from './settings.ts';
import type { HubSettings } from './settings.ts';
import { checkSite, readSite } from './site.ts';
import { osrmRoadKm } from './routing.ts';
import { Accounts } from './accounts.ts';
import { Licences, loadSigningKey } from './licences.ts';
import type { KeyObject } from 'node:crypto';
import { logMailer } from './mailer.ts';
import type { Mailer } from './mailer.ts';

/**
 * The online order hub: stores and their paired POS devices, published menus, customer orders, and the numbered event
 * log each POS reads over its event stream. Every order change follows contract/src/order.ts; anything else is refused.
 * Prices are always recomputed here from the published menu (contract/src/menu.ts); the POS bill stays the legal record.
 * Swiggy and Zomato orders come in through src/urbanpiper.ts, which listens to the bus ('moved', 'menu', 'status').
 */

export class HubError extends Error {
  code: string; status: number; details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) { super(message); this.code = code; this.status = status; this.details = details; }
}

export interface HubOptions {
  dbPath: string;
  now?: () => number;
  /** Return OTP codes in the API response (development and the demo page only). */
  devOtp?: boolean;
  sendSms?: (mobile: string, text: string) => Promise<void>;
  /** Road distance in km from a routing service, or null to use the store's road factor. Set: used instead of the routingUrl setting (tests). */
  roadKm?: (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => Promise<number | null>;
  /** Online payment (phase 3) is off until a payment gateway is set up. */
  onlinePayments?: boolean;
  /** Defaults for settings never saved from the admin page (e.g. HUB_ROUTING_URL). */
  settingDefaults?: Partial<HubSettings>;
  log?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
  /** Online backups from the POS (default: a "backups" folder next to the hub database). */
  backupDir?: string;
  /** Backups kept per store (default 30) and the largest accepted upload in bytes (default 1 GB). */
  backupKeep?: number;
  backupMaxBytes?: number;
  /** P7-01: email for customer accounts (default: the log; sign-up stays closed unless allowLogMailer). */
  mailer?: Mailer;
  /** Accept the log mailer for sign-up (development, HUB_DEV_MAIL=1). */
  allowLogMailer?: boolean;
  /** Sign-up without the emailed code (HUB_SKIP_EMAIL_VERIFY=1; see AccountsOptions.skipEmailVerify). */
  skipEmailVerify?: boolean;
  /** P7-02: the cloud's licence signing key (Ed25519 private: a KeyObject, PEM text or a file path). Not set: no keys signed here. */
  licenceSigningKey?: KeyObject | string;
}
export interface DeviceRef { deviceId: string; storeId: string; slug: string }

export interface StoreRow { id: string; slug: string; name: string; menu_json: string | null; menu_version: number; accepting: number; accepting_reason: string | null; order_counter: number; last_seen_at: number | null; created_at: number; paused_reason: string | null;
  website_json: string | null; site_draft_json: string | null; site_published_at: number | null; site_draft_at: number | null; site_password_hash: string | null }
interface OrderRow { id: string; store_id: string; number: string; state: OrderState; data_json: string; access_hash: string; accept_by: number | null }

const SLUG = /^[a-z0-9][a-z0-9-]{2,40}$/;
/** Never a store address: outlets are at <store>.<cloud>, and these names are the cloud's own (portal.posinext.com, …). */
export const RESERVED_SLUGS = new Set(['portal', 'www', 'app', 'api', 'admin', 'mail', 'status', 'help', 'support', 'docs', 'blog', 'demo', 'cloud']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A website builder sign-in lasts 30 days. */
const SITE_SESSION_MS = 30 * 86_400_000;
/** Orders the store still has to act on (sent, being made, on the way). */
const OPEN_STATES = "'SENT_TO_STORE','RECEIVED','ACCEPTED','PREPARING','READY','OUT_FOR_DELIVERY'";
/** Admin page filters: which order states each one shows (failed and all also show failed order attempts). */
const ADMIN_FILTER: Record<string, string | null> = {
  open: `'PLACED','PAYMENT_PENDING',${OPEN_STATES}`, delivered: "'DELIVERED','PICKED_UP'", cancelled: "'REJECTED','CANCELLED'", failed: "'AUTO_REJECTED','PAYMENT_FAILED'", all: null,
};
const REJECT_LABEL: Record<string, string> = { ITEM_UNAVAILABLE: 'Item not available', TOO_BUSY: 'Too busy', CLOSING: 'Closing', OUT_OF_DELIVERY_AREA: 'Outside the delivery area', OTHER: 'Other' };
const ATTEMPT_DAYS = 30;
const mask = (mobile: string) => mobile.slice(0, 2) + '******' + mobile.slice(-2);

export type AdminStatus = 'placed' | 'accepted' | 'preparing' | 'in_transit' | 'delivered' | 'cancelled_store' | 'cancelled_customer' | 'failed';

/** One status for people (admin page): the order state, who cancelled it, and why it failed. */
function adminStatus(o: Order, f: { byCustomer: boolean; wasReceived: boolean }): { status: AdminStatus; statusDetail: string | null } {
  switch (o.state) {
    case 'PLACED': return { status: 'placed', statusDetail: 'Being placed' };
    case 'PAYMENT_PENDING': return { status: 'placed', statusDetail: 'Waiting for online payment' };
    case 'SENT_TO_STORE': return { status: 'placed', statusDetail: 'Not yet seen by the store' };
    case 'RECEIVED': return { status: 'placed', statusDetail: 'Seen by the store, waiting for it to accept' };
    case 'ACCEPTED': return { status: 'accepted', statusDetail: o.prepMinutes ? `Ready in about ${o.prepMinutes} min` : null };
    case 'PREPARING': return { status: 'preparing', statusDetail: null };
    case 'READY': return { status: 'preparing', statusDetail: o.fulfilment === 'PICKUP' ? 'Ready for pickup' : 'Ready, waiting for the rider' };
    case 'OUT_FOR_DELIVERY': return { status: 'in_transit', statusDetail: o.rider ? `Rider: ${o.rider.name}${o.rider.phone ? ` (${o.rider.phone})` : ''}` : null };
    case 'DELIVERED': return { status: 'delivered', statusDetail: null };
    case 'PICKED_UP': return { status: 'delivered', statusDetail: 'Picked up by the customer' };
    case 'REJECTED': return { status: 'cancelled_store', statusDetail: [o.rejectReason ? REJECT_LABEL[o.rejectReason] ?? o.rejectReason : null, o.reasonText].filter(Boolean).join(': ') || null };
    case 'CANCELLED': return { status: f.byCustomer ? 'cancelled_customer' : 'cancelled_store', statusDetail: o.reasonText };
    case 'AUTO_REJECTED': return { status: 'failed', statusDetail: f.wasReceived ? 'The store did not accept in time. Rejected automatically.' : 'The order did not reach the store: its POS was offline or had no internet. Rejected automatically.' };
    case 'PAYMENT_FAILED': return { status: 'failed', statusDetail: 'Online payment was not completed in time.' };
  }
}

const OTP_TTL = 5 * 60_000, OTP_TOKEN_TTL = 30 * 86_400_000, PAYMENT_TTL = 15 * 60_000;

export class Hub {
  db: Db;
  now: () => number;
  bus = new EventEmitter();
  backups: BackupStore;
  /** DinePOS outlets: sales sync up, licence renewals down */
  sync: SalesSync;
  /** P7-01: customer accounts (the portal) */
  accounts: Accounts;
  /** P7-02: licence keys signed by this cloud */
  licences: Licences;
  /** P8-08: email to customers (account codes, support replies). */
  mailer: Mailer;
  private opts: HubOptions;
  /** open POS event streams per store, and when the last one closed */
  private streams = new Map<string, number>();
  private closedAt = new Map<string, number>();
  private cachedSettings: HubSettings | null = null;
  private routing: { url: string; fn: NonNullable<HubOptions['roadKm']> } | null = null;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.db = openHubDb(opts.dbPath);
    this.now = opts.now ?? Date.now;
    this.bus.setMaxListeners(0);
    this.backups = new BackupStore({ dir: opts.backupDir ?? join(dirname(opts.dbPath), 'backups'), keep: opts.backupKeep, maxBytes: opts.backupMaxBytes, now: this.now });
    this.sync = new SalesSync(this.db, this.now);
    const log = opts.log ?? { info: () => undefined, warn: () => undefined };
    const signing = opts.licenceSigningKey === undefined ? null : typeof opts.licenceSigningKey === 'string' ? loadSigningKey(opts.licenceSigningKey) : opts.licenceSigningKey;
    this.licences = new Licences(this.db, this.now, this.sync, signing);
    this.mailer = opts.mailer ?? logMailer(log);
    this.accounts = new Accounts(this.db, this.now, { mailer: this.mailer, allowLogMailer: opts.allowLogMailer, skipEmailVerify: opts.skipEmailVerify, log });
  }
  close() { this.db.close(); }

  // ---------------------------------------------------------------- stores, pairing, devices

  createStore(slug: string, name: string) {
    if (!SLUG.test(slug)) throw new HubError('VALIDATION', 'The store address must be 3-41 lowercase letters, digits or dashes.');
    if (RESERVED_SLUGS.has(slug)) throw new HubError('SLUG_TAKEN', 'That address is kept for PosiNext Cloud itself. Choose another.', 409);
    if (!name.trim() || name.length > 80) throw new HubError('VALIDATION', 'Enter the store name.');
    if (one(this.db, 'SELECT 1 FROM store WHERE slug = ? UNION ALL SELECT 1 FROM brand WHERE slug = ?', slug, slug)) throw new HubError('SLUG_TAKEN', 'That address is already used by a store or a brand.', 409);
    const id = randomUUID();
    exec(this.db, 'INSERT INTO store (id, slug, name, created_at) VALUES (?,?,?,?)', id, slug, name.trim(), this.now());
    return { storeId: id, slug, name: name.trim(), pairingCode: this.newPairingCode(id) };
  }

  /** A one-time code (valid pairingCodeMinutes, 30 by default) the store types into its POS to connect it. */
  newPairingCode(storeId: string): string { return this.issuePairingCode(storeId).pairingCode; }
  private issuePairingCode(storeId: string) {
    if (!one(this.db, 'SELECT 1 FROM store WHERE id = ?', storeId)) throw new HubError('NOT_FOUND', 'No such store.', 404);
    const raw = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    const expiresAt = this.now() + this.settings().pairingCodeMinutes * 60_000;
    exec(this.db, 'INSERT INTO pairing_code (code_hash, store_id, expires_at) VALUES (?,?,?)', hash(raw), storeId, expiresAt);
    return { pairingCode: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  pairingCodeForSlug(slug: string): string { return this.newPairingCode(this.store({ slug }).id); }
  pairingCodeWithExpiry(slug: string) { return this.issuePairingCode(this.store({ slug }).id); }

  pair(code: string, deviceName: string) {
    const raw = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return tx(this.db, () => {
      const p = one<{ store_id: string; expires_at: number; used_at: number | null }>(this.db, 'SELECT store_id, expires_at, used_at FROM pairing_code WHERE code_hash = ?', hash(raw));
      if (!p || p.used_at !== null || p.expires_at < this.now()) throw new HubError('BAD_PAIRING_CODE', 'This pairing code is wrong, already used or expired. Ask for a new one.', 400);
      exec(this.db, 'UPDATE pairing_code SET used_at = ? WHERE code_hash = ?', this.now(), hash(raw));
      const key = `tpk_${randomBytes(32).toString('base64url')}`;
      const deviceId = randomUUID();
      exec(this.db, 'INSERT INTO device (id, store_id, name, key_hash, created_at) VALUES (?,?,?,?,?)', deviceId, p.store_id, String(deviceName ?? 'POS').slice(0, 60) || 'POS', hash(key), this.now());
      const s = one<StoreRow>(this.db, 'SELECT * FROM store WHERE id = ?', p.store_id)!;
      return { storeId: s.id, slug: s.slug, name: s.name, deviceKey: key };
    });
  }

  device(key: string | undefined): DeviceRef {
    const d = key ? one<{ id: string; store_id: string; slug: string }>(this.db, 'SELECT d.id, d.store_id, s.slug FROM device d JOIN store s ON s.id = d.store_id WHERE d.key_hash = ? AND d.revoked_at IS NULL', hash(key)) : undefined;
    if (!d) throw new HubError('UNAUTHENTICATED', 'This POS is not connected to the hub. Pair it again.', 401);
    return { deviceId: d.id, storeId: d.store_id, slug: d.slug };
  }

  revokeDevice(deviceId: string) {
    if (!one(this.db, 'SELECT 1 FROM device WHERE id = ?', deviceId)) throw new HubError('NOT_FOUND', 'No such device.', 404);
    exec(this.db, 'UPDATE device SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', this.now(), deviceId);
  }

  // ---------------------------------------------------------------- admin: settings, pause, overview

  settings(): HubSettings {
    if (!this.cachedSettings) {
      const saved = Object.fromEntries(many<{ key: string; value_json: string }>(this.db, 'SELECT key, value_json FROM setting').map((r) => [r.key, JSON.parse(r.value_json)]));
      const merged: Record<string, unknown> = { ...SETTING_DEFAULTS, ...this.opts.settingDefaults, ...saved };
      this.cachedSettings = Object.fromEntries(Object.keys(SETTING_DEFAULTS).map((k) => [k, merged[k]])) as unknown as HubSettings;
    }
    return { ...this.cachedSettings };
  }

  saveSettings(input: unknown): HubSettings {
    const c = checkSettings(input);
    if (!c.ok) throw new HubError('VALIDATION', Object.values(c.errors)[0]!, 400, { fields: c.errors });
    tx(this.db, () => {
      for (const [k, v] of Object.entries(c.value)) exec(this.db, 'INSERT INTO setting (key, value_json, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at', k, JSON.stringify(v), this.now());
    });
    this.cachedSettings = null;
    this.opts.log?.info('hub settings changed', c.value);
    return this.settings();
  }

  /** Stops (or restarts) a store's online orders from the hub, whatever its POS says. */
  pauseStore(slug: string, paused: boolean, reason?: unknown) {
    const s = this.store({ slug });
    const text = typeof reason === 'string' && reason.trim() ? reason.trim() : 'This store is not taking online orders right now.';
    if (text.length > 200) throw new HubError('VALIDATION', 'Keep the message for customers under 200 characters.');
    exec(this.db, 'UPDATE store SET paused_reason = ? WHERE id = ?', paused ? text : null, s.id);
    this.bus.emit('status', s.id);
    return { slug, pausedReason: paused ? text : null };
  }

  // ---------------------------------------------------------------- website builder (src/site.ts, the website's /admin page)

  /** A new website-editor password for one store, shown once. It signs out every builder of that store. */
  newSitePassword(slug: string): { slug: string; password: string } {
    const s = this.store({ slug });
    const raw = Array.from({ length: 12 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    tx(this.db, () => {
      exec(this.db, 'UPDATE store SET site_password_hash = ? WHERE id = ?', hash(`site:${s.id}:${raw}`), s.id);
      exec(this.db, 'DELETE FROM site_session WHERE store_id = ?', s.id);
    });
    this.opts.log?.info('website editor password set', { slug });
    return { slug, password: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}` };
  }

  siteLogin(slug: string, password: unknown) {
    const s = this.store({ slug });
    const raw = String(password ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const got = Buffer.from(hash(`site:${s.id}:${raw}`)), want = Buffer.from(s.site_password_hash ?? '');
    if (!s.site_password_hash || got.length !== want.length || !timingSafeEqual(got, want)) throw new HubError('BAD_PASSWORD', 'That password is not right. Ask the hub admin for the website editor password.', 401);
    const token = `tsw_${randomBytes(32).toString('base64url')}`, expiresAt = this.now() + SITE_SESSION_MS;
    exec(this.db, 'DELETE FROM site_session WHERE expires_at < ?', this.now());
    exec(this.db, 'INSERT INTO site_session (token_hash, store_id, expires_at, created_at) VALUES (?,?,?,?)', hash(token), s.id, expiresAt, this.now());
    return { token, expiresAt, store: { slug: s.slug, name: s.name } };
  }

  siteLogout(slug: string, token: string | undefined) {
    const s = this.siteStore(slug, token);
    exec(this.db, 'DELETE FROM site_session WHERE token_hash = ? AND store_id = ?', hash(token!), s.id);
    return { ok: true };
  }

  /** The store a builder sign-in belongs to; a token of another store, an ended or an expired one is refused. */
  private siteStore(slug: string, token: string | undefined): StoreRow {
    const s = this.store({ slug });
    const row = token ? one<{ expires_at: number }>(this.db, 'SELECT expires_at FROM site_session WHERE token_hash = ? AND store_id = ?', hash(token), s.id) : undefined;
    if (!row || row.expires_at < this.now()) throw new HubError('UNAUTHENTICATED', 'Sign in to the website builder again.', 401);
    return s;
  }

  private siteState(s: StoreRow) {
    const published = readSite(s.website_json);
    const draft = s.site_draft_json ? readSite(s.site_draft_json) : published;
    return { store: { slug: s.slug, name: s.name }, draft, published, draftSavedAt: s.site_draft_at, publishedAt: s.site_published_at, unpublished: JSON.stringify(draft) !== JSON.stringify(published) };
  }

  siteForEditor(slug: string, token: string | undefined) { return this.siteState(this.siteStore(slug, token)); }

  saveSiteDraft(slug: string, token: string | undefined, input: unknown) {
    const s = this.siteStore(slug, token);
    const c = checkSite(input);
    if (!c.ok) throw new HubError('VALIDATION', Object.values(c.errors)[0]!, 400, { fields: c.errors });
    exec(this.db, 'UPDATE store SET site_draft_json = ?, site_draft_at = ? WHERE id = ?', JSON.stringify(c.value), this.now(), s.id);
    return this.siteState(this.store({ id: s.id }));
  }

  /** The draft goes live: customers see it on their next page load. */
  publishSite(slug: string, token: string | undefined) {
    const s = this.siteStore(slug, token);
    const draft = s.site_draft_json ? readSite(s.site_draft_json) : readSite(s.website_json);
    exec(this.db, 'UPDATE store SET website_json = ?, site_draft_json = NULL, site_published_at = ? WHERE id = ?', JSON.stringify(draft), this.now(), s.id);
    this.opts.log?.info('website published', { slug });
    return this.siteState(this.store({ id: s.id }));
  }

  /** Throws the draft away: the builder shows the published website again. */
  discardSiteDraft(slug: string, token: string | undefined) {
    const s = this.siteStore(slug, token);
    exec(this.db, 'UPDATE store SET site_draft_json = NULL, site_draft_at = NULL WHERE id = ?', s.id);
    return this.siteState(this.store({ id: s.id }));
  }

  /** A photo for the website (logo, hero, gallery), kept with the store's menu photos; the design refers to it as hub:<name>. */
  putSiteImage(slug: string, token: string | undefined, name: string, dataBase64: unknown) {
    const s = this.siteStore(slug, token);
    this.saveImage(s.id, name, dataBase64);
    return { ok: true, ref: `hub:${name}` };
  }

  private storeSummary(s: StoreRow) {
    const dayAgo = this.now() - 86_400_000;
    const m = this.menu(s);
    const count = (sql: string, ...p: Array<string | number>) => one<{ n: number }>(this.db, sql, ...p)?.n ?? 0;
    return {
      slug: s.slug, name: s.name, createdAt: s.created_at, menuVersion: s.menu_version, menuItems: m?.items.length ?? 0,
      connected: this.connected(s.id), accepting: Boolean(s.accepting), acceptingReason: s.accepting_reason, lastSeenAt: s.last_seen_at,
      pausedReason: s.paused_reason, open: this.availability(s, m),
      openOrders: count(`SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND state IN (${OPEN_STATES})`, s.id),
      ordersLastDay: count('SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND created_at >= ?', s.id, dayAgo),
      devices: many<{ id: string; name: string; created_at: number; revoked_at: number | null }>(this.db, 'SELECT id, name, created_at, revoked_at FROM device WHERE store_id = ? ORDER BY created_at', s.id)
        .map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, revokedAt: d.revoked_at })),
    };
  }

  adminOverview() {
    const stores = many<StoreRow>(this.db, 'SELECT * FROM store ORDER BY slug').map((s) => this.storeSummary(s));
    return {
      hub: { devOtp: Boolean(this.opts.devOtp), onlinePayments: Boolean(this.opts.onlinePayments), smsProvider: Boolean(this.opts.sendSms), routingOverridden: Boolean(this.opts.roadKm), now: this.now() },
      settings: this.settings(), stores,
    };
  }

  /** One store with the settings its POS published (read-only here: the POS is where they are changed). */
  adminStore(slug: string) {
    const s = this.store({ slug });
    const m = this.menu(s);
    const perCategory = new Map<string | null, number>();
    for (const i of m?.items ?? []) perCategory.set(i.categoryId, (perCategory.get(i.categoryId) ?? 0) + 1);
    return {
      ...this.storeSummary(s),
      website: { editorPassword: Boolean(s.site_password_hash), publishedAt: s.site_published_at },
      published: m ? {
        options: m.options, serviceability: m.serviceability, feeTax: m.feeTax, roundToRupee: m.roundToRupee,
        menu: { items: m.items.length, unavailable: m.items.filter((i) => !i.available).length, categories: [...[...m.categories].sort((a, b) => a.sort - b.sort).map((c) => ({ name: c.name, items: perCategory.get(c.id) ?? 0 })), ...(perCategory.has(null) ? [{ name: 'No category', items: perCategory.get(null)! }] : [])] },
      } : null,
    };
  }

  /** Latest orders and failed order attempts, of one store or all, for the admin page (customer mobile masked). */
  adminOrders(o: { slug?: string; status?: string; limit?: number } = {}) {
    const filter = (o.status && o.status in ADMIN_FILTER) ? o.status : 'all';
    const limit = Math.min(Math.max(1, Math.trunc(o.limit ?? 100) || 100), 500);
    const storeId = o.slug ? this.store({ slug: o.slug }).id : null;
    const where: string[] = [], p: Array<string | number> = [];
    if (storeId) { where.push('o.store_id = ?'); p.push(storeId); }
    if (ADMIN_FILTER[filter]) where.push(`o.state IN (${ADMIN_FILTER[filter]})`);
    const orders = many<{ data_json: string; updated_at: number; slug: string; name: string; by_customer: number; was_received: number }>(this.db,
      `SELECT o.data_json, o.updated_at, s.slug, s.name,
         EXISTS (SELECT 1 FROM event e WHERE e.order_id = o.id AND e.type = 'order.cancelled') AS by_customer,
         EXISTS (SELECT 1 FROM event e WHERE e.order_id = o.id AND e.type = 'order.updated' AND json_extract(e.data_json, '$.state') = 'RECEIVED') AS was_received
       FROM orders o JOIN store s ON s.id = o.store_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC LIMIT ?`, ...p, limit)
      .map((r) => {
        const x = JSON.parse(r.data_json) as Order;
        return { kind: 'order' as const, id: x.id, number: x.number, store: { slug: r.slug, name: r.name }, state: x.state, label: label(x.state),
          ...adminStatus(x, { byCustomer: Boolean(r.by_customer), wasReceived: Boolean(r.was_received) }), errorCode: null,
          channel: x.channel, fulfilment: x.fulfilment, payment: x.payment, paid: x.paid,
          customerName: x.customer.name, mobile: mask(x.customer.mobile), verified: x.customer.verified,
          lines: x.lines.map((l) => ({ name: l.name, qtyMilli: l.qtyMilli, modifiers: l.modifiers.map((m) => m.name), note: l.note, lineTotal: l.lineTotal })),
          address: x.address, distanceKm: x.distanceKm, note: x.note, itemsTotal: x.itemsTotal, deliveryFee: x.deliveryFee, packagingFee: x.packagingFee, total: x.total,
          posBillNo: x.posBillNo, prepMinutes: x.prepMinutes, rider: x.rider, rejectReason: x.rejectReason, reasonText: x.reasonText, placedAt: x.placedAt, updatedAt: r.updated_at };
      });
    const attempts = filter === 'all' || filter === 'failed'
      ? many<{ id: number; at: number; channel: string | null; fulfilment: string | null; payment: string | null; customer_name: string | null; mobile_masked: string | null; total: number | null; code: string; message: string; slug: string; name: string }>(this.db,
        `SELECT a.*, s.slug, s.name FROM order_attempt a JOIN store s ON s.id = a.store_id ${storeId ? 'WHERE a.store_id = ?' : ''} ORDER BY a.at DESC, a.id DESC LIMIT ?`, ...(storeId ? [storeId] : []), limit)
        .map((a) => ({ kind: 'attempt' as const, id: `attempt-${a.id}`, number: null, store: { slug: a.slug, name: a.name }, state: null, label: 'Not placed',
          status: 'failed' as AdminStatus, statusDetail: a.code === 'INTERNAL' ? `Technical error on the hub: ${a.message}` : a.message, errorCode: a.code,
          channel: a.channel, fulfilment: a.fulfilment, payment: a.payment, paid: false, customerName: a.customer_name, mobile: a.mobile_masked, verified: false,
          lines: [], address: null, distanceKm: null, note: null, itemsTotal: null, deliveryFee: null, packagingFee: null, total: a.total,
          posBillNo: null, prepMinutes: null, rider: null, rejectReason: null, reasonText: null, placedAt: a.at, updatedAt: a.at }))
      : [];
    // newest first; at the same moment an attempt counts as later than an order (it came after the hub's last success)
    const all = [...orders, ...attempts].sort((a, b) => b.placedAt - a.placedAt || (a.kind === b.kind ? 0 : a.kind === 'attempt' ? -1 : 1));
    return { orders: all.slice(0, limit) };
  }

  /** Keeps a customer's order attempt that failed before an order existed (offline store, changed price, technical error). Never throws. */
  private recordFailedAttempt(slug: string, body: unknown, e: unknown) {
    try {
      const s = one<{ id: string }>(this.db, 'SELECT id FROM store WHERE slug = ?', slug);
      if (!s) return; // no such store: nothing to show
      const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      const cust = (b.customer && typeof b.customer === 'object' ? b.customer : {}) as Record<string, unknown>;
      const pick = (v: unknown, allowed: string[]) => (typeof v === 'string' && allowed.includes(v) ? v : null);
      const mobile = typeof cust.mobile === 'string' ? normaliseMobile(cust.mobile) : '';
      const he = e instanceof HubError ? e : null;
      exec(this.db, 'INSERT INTO order_attempt (store_id, at, channel, fulfilment, payment, customer_name, mobile_masked, total, code, message) VALUES (?,?,?,?,?,?,?,?,?,?)',
        s.id, this.now(), pick(b.channel ?? 'website', ['app', 'website']), pick(b.fulfilment, ['PICKUP', 'DELIVERY']), pick(b.payment, ['COD', 'ONLINE']),
        typeof cust.name === 'string' ? cust.name.slice(0, 60) : null, MOBILE_RE.test(mobile) ? mask(mobile) : null,
        Number.isSafeInteger(b.expectedTotal) ? b.expectedTotal as number : null, he?.code ?? 'INTERNAL', String(he?.message ?? (e as Error)?.message ?? e).slice(0, 300));
    } catch (err) { this.opts.log?.warn('could not record a failed order attempt', String(err)); }
  }

  /** The road-distance service in use (options, or the routingUrl setting), or undefined: straight line x road factor. */
  roadKm(): HubOptions['roadKm'] {
    if (this.opts.roadKm) return this.opts.roadKm;
    const url = this.settings().routingUrl;
    if (!url) return undefined;
    if (this.routing?.url !== url) this.routing = { url, fn: osrmRoadKm(url) };
    return this.routing.fn;
  }

  store(by: { id?: string; slug?: string }): StoreRow {
    const s = by.id ? one<StoreRow>(this.db, 'SELECT * FROM store WHERE id = ?', by.id) : one<StoreRow>(this.db, 'SELECT * FROM store WHERE slug = ?', by.slug ?? '');
    if (!s) throw new HubError('NOT_FOUND', 'No such store.', 404);
    return s;
  }
  menu(s: StoreRow): PublishedMenu | null { return s.menu_json ? JSON.parse(s.menu_json) as PublishedMenu : null; }
  /** The menu as one channel sells it (menu sync): items listed for that channel only. */
  forChannel(m: PublishedMenu, channel: 'app' | 'website' | 'swiggy' | 'zomato'): PublishedMenu {
    return { ...m, items: m.items.filter((i) => !i.channels || i.channels.includes(channel)).map((i) => ({ ...i, price: i.prices?.[channel] ?? i.price })) };
  }

  // ---------------------------------------------------------------- what a POS publishes

  publishMenu(dev: DeviceRef, m: PublishedMenu) {
    if (!m || typeof m !== 'object' || !Number.isSafeInteger(m.version) || m.version < 1) throw new HubError('VALIDATION', 'The menu needs a version number.');
    if (!Array.isArray(m.items) || !Array.isArray(m.categories) || !Array.isArray(m.modifierGroups) || !m.options || typeof m.roundToRupee !== 'boolean') throw new HubError('VALIDATION', 'The menu is incomplete.');
    for (const i of m.items) if (typeof i.id !== 'string' || typeof i.name !== 'string' || !Number.isSafeInteger(i.price) || i.price < 0 || !Number.isInteger(i.rateBp)) throw new HubError('VALIDATION', 'A menu item is not valid.');
    const svc = checkServiceability(m.serviceability);
    if (!svc.ok) throw new HubError('VALIDATION', 'The serviceability settings are not valid.', 400, { fields: svc.errors });
    const cur = this.store({ id: dev.storeId });
    // a lower version is an older publish arriving late only right after the newer one; later it is a POS whose count is
    // behind (a restored backup, a POS paired again): its menu is the newest, so it is kept, or the shop's changes never arrive
    const at = (cur as StoreRow & { menu_at?: number | null }).menu_at ?? 0;
    if (m.version < cur.menu_version && this.now() - at < 60_000) return { version: cur.menu_version, stale: true };
    exec(this.db, 'UPDATE store SET menu_json = ?, menu_version = ?, name = ?, menu_at = ? WHERE id = ?', JSON.stringify({ ...m, serviceability: svc.value }), m.version, String(m.storeName || cur.name).slice(0, 80), this.now(), dev.storeId);
    const keep = new Set(m.items.map((i) => i.image).filter((x): x is string => typeof x === 'string'));
    for (const r of many<{ name: string }>(this.db, 'SELECT name FROM image WHERE store_id = ?', dev.storeId)) if (!keep.has(r.name)) exec(this.db, 'DELETE FROM image WHERE store_id = ? AND name = ?', dev.storeId, r.name);
    this.bus.emit('menu', dev.storeId);
    return { version: m.version, stale: false };
  }

  // ---------------------------------------------------------------- menu photos

  /** Photos this store already has here (the POS sends only the missing ones). */
  imageNames(dev: DeviceRef): string[] {
    return many<{ name: string }>(this.db, 'SELECT name FROM image WHERE store_id = ?', dev.storeId).map((r) => r.name);
  }

  /** A menu photo from the POS. Its name is the SHA-256 of its bytes, so a wrong or damaged file is refused. */
  putImage(dev: DeviceRef, name: string, dataBase64: unknown) { return this.saveImage(dev.storeId, name, dataBase64); }
  private saveImage(storeId: string, name: string, dataBase64: unknown) {
    const m = /^([0-9a-f]{64})\.(jpg|png|webp)$/.exec(name);
    if (!m) throw new HubError('VALIDATION', 'Unknown photo name.');
    if (typeof dataBase64 !== 'string' || dataBase64.length > 2_000_000) throw new HubError('TOO_LARGE', 'The photo is too large.', 413);
    const bytes = Buffer.from(dataBase64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== m[1]) throw new HubError('VALIDATION', 'The photo does not match its name.');
    const kind = bytes.length < 12 ? null : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg' : bytes.readUInt32BE(0) === 0x89504e47 ? 'png' : bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : null;
    if (kind !== m[2]) throw new HubError('VALIDATION', 'This is not a JPG, PNG or WebP photo.');
    if ((one<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM image WHERE store_id = ?', storeId)?.n ?? 0) >= 3000) throw new HubError('TOO_MANY', 'Too many photos for one store.', 409);
    exec(this.db, 'INSERT OR IGNORE INTO image(store_id, name, type, bytes, created_at) VALUES (?,?,?,?,?)', storeId, name, { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[kind], bytes, this.now());
    return { ok: true };
  }

  /** A store's photo for the ordering page. */
  image(slug: string, name: string): { type: string; bytes: Uint8Array } {
    const s = this.store({ slug });
    const r = one<{ type: string; bytes: Uint8Array }>(this.db, 'SELECT type, bytes FROM image WHERE store_id = ? AND name = ?', s.id, name);
    if (!r) throw new HubError('NOT_FOUND', 'Photo not found.', 404);
    return r;
  }

  setStatus(dev: DeviceRef, s: { accepting: boolean; reason?: string | null }) {
    exec(this.db, 'UPDATE store SET accepting = ?, accepting_reason = ?, last_seen_at = ? WHERE id = ?', s.accepting ? 1 : 0, s.accepting ? null : String(s.reason ?? 'Not taking orders right now.').slice(0, 200), this.now(), dev.storeId);
    this.bus.emit('status', dev.storeId);
    return { ok: true };
  }

  // ---------------------------------------------------------------- live streams (store online status)

  streamOpened(storeId: string) {
    this.streams.set(storeId, (this.streams.get(storeId) ?? 0) + 1);
    try { exec(this.db, 'UPDATE store SET last_seen_at = ? WHERE id = ?', this.now(), storeId); } catch { /* hub shutting down: last-seen is not essential */ }
  }
  streamClosed(storeId: string) {
    const n = (this.streams.get(storeId) ?? 1) - 1;
    if (n <= 0) { this.streams.delete(storeId); this.closedAt.set(storeId, this.now()); } else this.streams.set(storeId, n);
  }
  connected(storeId: string): boolean {
    if ((this.streams.get(storeId) ?? 0) > 0) return true;
    const closed = this.closedAt.get(storeId);
    return closed !== undefined && this.now() - closed < this.settings().offlineAfterSec * 1000;
  }

  /** Can this store take an order now (and why not)? */
  availability(s: StoreRow, m: PublishedMenu | null, o: { channel?: 'app' | 'website'; fulfilment?: 'PICKUP' | 'DELIVERY'; payment?: 'ONLINE' | 'COD' } = {}): { open: boolean; reason: string | null } {
    if (!m) return { open: false, reason: 'This store is not taking online orders yet.' };
    if (s.paused_reason) return { open: false, reason: s.paused_reason };
    if (!this.connected(s.id)) return { open: false, reason: 'The store is offline right now. Please try again later.' };
    if (!s.accepting) return { open: false, reason: s.accepting_reason ?? 'The store is not taking orders right now.' };
    if (!isOpen(m.serviceability.hours, this.now())) return { open: false, reason: 'The store is closed now. See the opening hours.' };
    if (o.channel && !m.options.channels[o.channel]) return { open: false, reason: 'Online orders are not available here right now.' };
    if (o.fulfilment === 'PICKUP' && !m.options.fulfilment.pickup) return { open: false, reason: 'This store does not offer pickup right now.' };
    if (o.fulfilment === 'DELIVERY' && (!m.options.fulfilment.delivery || !m.serviceability.location || m.serviceability.zones.length === 0)) return { open: false, reason: 'This store does not deliver right now.' };
    if (o.payment === 'COD' && !m.options.payments.cod) return { open: false, reason: 'Cash on delivery is not available. Choose online payment.' };
    if (o.payment === 'ONLINE' && (!m.options.payments.online || !this.opts.onlinePayments)) return { open: false, reason: 'Online payment is not available yet. Choose cash on delivery.' };
    return { open: true, reason: null };
  }

  /** The store page for customer apps. */
  storePublic(slug: string, channel: 'app' | 'website' = 'website') {
    const s = this.store({ slug });
    const full = this.menu(s);
    const m = full ? this.forChannel(full, channel) : null;
    const a = this.availability(s, m);
    const site = readSite(s.website_json); // the published website design
    if (!m) return { slug: s.slug, name: s.name, open: false, reason: a.reason, menu: null, site };
    const sv = m.serviceability;
    return {
      slug: s.slug, name: s.name, open: a.open, reason: a.reason, site,
      menu: { version: m.version, categories: m.categories, items: m.items.filter((i) => i.available).map(({ rateBp: _r, cessBp: _c, priceIncludesTax: _p, channels: _ch, prices: _pr, ...i }) => i), modifierGroups: m.modifierGroups },
      fulfilment: m.options.fulfilment, payments: { cod: m.options.payments.cod, online: m.options.payments.online && Boolean(this.opts.onlinePayments) },
      delivery: { location: sv.location ? { lat: sv.location.lat, lng: sv.location.lng } : null, zones: sv.zones, packagingFee: sv.packagingFee },
      pickup: sv.pickup, hours: sv.hours, acceptMode: m.options.acceptMode,
    };
  }

  /** Prices a cart with fees (for the app before ordering, and when placing). */
  async quote(slug: string, body: { fulfilment: 'PICKUP' | 'DELIVERY'; location?: { lat: number; lng: number } | null; lines: Array<{ itemId: string; qtyMilli: number; modifierIds?: string[]; note?: string | null }>; channel?: 'app' | 'website' }) {
    const s = this.store({ slug });
    const m = this.menu(s);
    if (!m) throw new HubError('STORE_CLOSED', 'This store is not taking online orders yet.', 409);
    return this.priceWithFees(this.forChannel(m, body.channel === 'app' ? 'app' : 'website'), body);
  }

  private async priceWithFees(m: PublishedMenu, body: { fulfilment: 'PICKUP' | 'DELIVERY'; location?: { lat: number; lng: number } | null; lines: Array<{ itemId: string; qtyMilli: number; modifierIds?: string[]; note?: string | null }> }) {
    const items = priceOrder(m, body.lines);
    if (!items.ok) throw new HubError(items.reason, items.message, 409, { itemId: items.itemId });
    let measured: number | null = null;
    const roadKm = this.roadKm();
    if (body.fulfilment === 'DELIVERY' && body.location && m.serviceability.location && roadKm) {
      measured = await roadKm(m.serviceability.location, body.location).catch(() => null);
    }
    const q = quote(m.serviceability, { fulfilment: body.fulfilment, to: body.location ?? undefined, itemsTotal: items.itemsTotal, measuredRoadKm: measured });
    if (!q.ok) {
      if (q.reason === 'BELOW_MINIMUM') throw new HubError('BELOW_MINIMUM', `Add items worth Rs ${(q.shortBy! / 100).toFixed(2)} more (minimum order Rs ${(q.minOrder! / 100).toFixed(2)}).`, 409, q);
      if (q.reason === 'OUT_OF_AREA') throw new HubError('OUT_OF_AREA', `Sorry, this address is outside the delivery area (up to ${q.maxKm} km).`, 409, q);
      throw new HubError('NO_DELIVERY', 'This store does not deliver right now.', 409, q);
    }
    const priced = priceOrder(m, body.lines, { delivery: q.deliveryFee, packaging: q.packagingFee });
    if (!priced.ok) throw new HubError(priced.reason, priced.message, 409);
    return { ...priced, distanceKm: q.distanceKm, etaMinutes: q.etaMinutes, minOrder: q.minOrder, menuVersion: m.version };
  }

  // ---------------------------------------------------------------- customer: OTP

  async otpSend(mobileIn: string) {
    const mobile = normaliseMobile(String(mobileIn ?? ''));
    if (!MOBILE_RE.test(mobile)) throw new HubError('VALIDATION', 'Enter a 10-digit mobile number.');
    const now = this.now();
    const row = one<{ sends: number; window_start: number }>(this.db, 'SELECT sends, window_start FROM otp WHERE mobile = ?', mobile);
    const inWindow = row && now - row.window_start < 10 * 60_000;
    if (inWindow && row.sends >= 3) throw new HubError('OTP_LIMIT', 'Too many codes asked for. Try again in 10 minutes.', 429);
    const code = String(randomInt(100000, 1000000));
    exec(this.db, `INSERT INTO otp (mobile, code_hash, expires_at, attempts, sends, window_start) VALUES (?,?,?,0,1,?)
      ON CONFLICT(mobile) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
        sends = CASE WHEN ? THEN otp.sends + 1 ELSE 1 END, window_start = CASE WHEN ? THEN otp.window_start ELSE excluded.window_start END`,
      mobile, hash(mobile + code), now + OTP_TTL, now, inWindow ? 1 : 0, inWindow ? 1 : 0);
    await (this.opts.sendSms ?? (async (m, t) => this.opts.log?.info('OTP (no SMS provider set up)', { mobile: m.slice(0, 2) + '******' + m.slice(-2), text: t.replace(/\d{6}/, '******') })))(mobile, `${code} is your code to confirm your order. It expires in 5 minutes.`);
    return { sent: true, ...(this.opts.devOtp ? { devCode: code } : {}) };
  }

  otpVerify(mobileIn: string, code: string) {
    const mobile = normaliseMobile(String(mobileIn ?? ''));
    const row = one<{ code_hash: string; expires_at: number; attempts: number }>(this.db, 'SELECT code_hash, expires_at, attempts FROM otp WHERE mobile = ?', mobile);
    if (!row || row.expires_at < this.now()) throw new HubError('OTP_EXPIRED', 'The code has expired. Ask for a new one.');
    if (row.attempts >= 5) throw new HubError('OTP_LOCKED', 'Too many wrong codes. Ask for a new one.', 429);
    if (hash(mobile + String(code ?? '').trim()) !== row.code_hash) {
      exec(this.db, 'UPDATE otp SET attempts = attempts + 1 WHERE mobile = ?', mobile);
      throw new HubError('OTP_WRONG', 'That code is not right.');
    }
    exec(this.db, 'DELETE FROM otp WHERE mobile = ?', mobile);
    const token = `otp_${randomBytes(24).toString('base64url')}`;
    exec(this.db, 'INSERT INTO otp_token (token_hash, mobile, expires_at) VALUES (?,?,?)', hash(token), mobile, this.now() + OTP_TOKEN_TTL);
    return { otpToken: token, mobile };
  }

  private verifiedMobile(token: string | null | undefined): string | null {
    if (!token) return null;
    const r = one<{ mobile: string; expires_at: number }>(this.db, 'SELECT mobile, expires_at FROM otp_token WHERE token_hash = ?', hash(token));
    return r && r.expires_at > this.now() ? r.mobile : null;
  }

  // ---------------------------------------------------------------- customer: orders

  async placeOrder(slug: string, body: unknown, idemKey: string | undefined) {
    try { return await this.placeOrderChecked(slug, body, idemKey); } catch (e) { this.recordFailedAttempt(slug, body, e); throw e; }
  }

  private async placeOrderChecked(slug: string, body: unknown, idemKey: string | undefined) {
    const scope = `place:${slug}`;
    const done = idemKey ? this.idemGet(scope, idemKey) : null;
    if (done) return done as { order: Order; accessToken: string };
    const c = checkPlaceOrder(body);
    if (!c.ok) throw new HubError('VALIDATION', Object.values(c.errors)[0]!, 400, { fields: c.errors });
    const req = c.value;
    const s = this.store({ slug });
    const m = this.menu(s);
    const channel = req.channel ?? 'website';
    const a = this.availability(s, m, { channel, fulfilment: req.fulfilment, payment: req.payment });
    if (!a.open) throw new HubError(req.payment === 'ONLINE' && /payment/i.test(a.reason ?? '') ? 'PAYMENT_NOT_AVAILABLE' : 'STORE_CLOSED', a.reason!, 409);
    const verified = this.verifiedMobile(req.otpToken);
    if (req.payment === 'COD' && verified !== req.customer.mobile) throw new HubError('OTP_REQUIRED', 'Verify your mobile number with the OTP to pay cash on delivery.', 400);
    const priced = await this.priceWithFees(this.forChannel(m!, channel), { fulfilment: req.fulfilment, location: req.location, lines: req.lines });
    if (priced.total !== req.expectedTotal) throw new HubError('PRICE_CHANGED', `The total is now Rs ${(priced.total / 100).toFixed(2)}. Please check and order again.`, 409, { total: priced.total, menuVersion: priced.menuVersion });

    const now = this.now();
    const result = tx(this.db, () => {
      const n = one<{ order_counter: number }>(this.db, 'UPDATE store SET order_counter = order_counter + 1 WHERE id = ? RETURNING order_counter', s.id)!.order_counter;
      const id = randomUUID();
      const accessToken = `ord_${randomBytes(24).toString('base64url')}`;
      const manual = m!.options.acceptMode === 'manual';
      const state: OrderState = req.payment === 'COD' ? 'SENT_TO_STORE' : 'PAYMENT_PENDING';
      const order: Order = {
        id, number: `${channel === 'app' ? 'A' : 'W'}-${n}`, storeId: s.id, channel, state, fulfilment: req.fulfilment, payment: req.payment, paid: false,
        customer: { name: req.customer.name ?? null, mobile: req.customer.mobile, verified: verified === req.customer.mobile },
        address: req.address ?? null, lines: priced.lines, note: req.note ?? null,
        itemsTotal: priced.itemsTotal, deliveryFee: priced.deliveryFee, packagingFee: priced.packagingFee, total: priced.total,
        distanceKm: priced.distanceKm, location: req.location ?? null, prepMinutes: null, etaAt: null,
        menuVersion: m!.version, placedAt: now, acceptBy: state === 'SENT_TO_STORE' && manual ? now + m!.options.acceptTimeoutMin * 60_000 : null,
        rider: null, posBillNo: null, rejectReason: null, reasonText: null,
      };
      exec(this.db, 'INSERT INTO orders (id, store_id, number, state, data_json, access_hash, accept_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, s.id, order.number, state, JSON.stringify(order), hash(accessToken), order.acceptBy, now, now);
      const evs = state === 'SENT_TO_STORE' ? [this.addEvent(s.id, id, 'order.created', { order })] : [];
      const out = { order, accessToken };
      if (idemKey) this.idemPut(scope, idemKey, 201, out);
      return { out, evs };
    });
    for (const ev of result.evs) this.bus.emit('pos', s.id, ev);
    this.emitCustomer(result.out.order);
    return result.out;
  }

  /** The answer already given to this order request (same idempotency key at this store), or null. */
  placedBefore(slug: string, idemKey: string | undefined): { order: Order; accessToken: string } | null {
    return idemKey ? this.idemGet(`place:${slug}`, idemKey) as { order: Order; accessToken: string } | null : null;
  }

  orderForCustomer(id: string, token: string | undefined): Order {
    const r = one<OrderRow>(this.db, 'SELECT * FROM orders WHERE id = ?', id);
    if (!r || !token || hash(token) !== r.access_hash) throw new HubError('NOT_FOUND', 'Order not found.', 404);
    return JSON.parse(r.data_json) as Order;
  }

  cancelByCustomer(id: string, token: string | undefined, reasonText?: string | null) {
    const o = this.orderForCustomer(id, token);
    return this.move(o.storeId, id, 'CANCELLED', 'customer', { reasonText: reasonText ? String(reasonText).slice(0, 200) : 'Cancelled by the customer' });
  }

  // ---------------------------------------------------------------- Swiggy / Zomato orders (src/urbanpiper.ts)

  /**
   * A platform order, already priced: straight to the store (the platform has taken the customer's payment or cash
   * arrangement). onSaved runs in the same transaction: the caller records the platform's order id there, so a repeated
   * webhook can never make a second order.
   */
  createExternalOrder(storeId: string, f: Pick<Order, 'fulfilment' | 'payment' | 'paid' | 'customer' | 'address' | 'lines' | 'note' | 'itemsTotal' | 'deliveryFee' | 'packagingFee' | 'total' | 'location'> & { external: ExternalOrder }, onSaved: (orderId: string) => void): Order {
    const s = this.store({ id: storeId });
    const m = this.menu(s);
    const now = this.now();
    const res = tx(this.db, () => {
      const n = one<{ order_counter: number }>(this.db, 'UPDATE store SET order_counter = order_counter + 1 WHERE id = ? RETURNING order_counter', s.id)!.order_counter;
      const id = randomUUID();
      const manual = m?.options.acceptMode !== 'auto';
      const order: Order = {
        id, number: `${f.external.platform === 'swiggy' ? 'S' : 'Z'}-${n}`, storeId: s.id, channel: f.external.platform, state: 'SENT_TO_STORE',
        fulfilment: f.fulfilment, payment: f.payment, paid: f.paid, customer: f.customer, address: f.address, lines: f.lines, note: f.note,
        itemsTotal: f.itemsTotal, deliveryFee: f.deliveryFee, packagingFee: f.packagingFee, total: f.total, distanceKm: null, location: f.location,
        prepMinutes: null, etaAt: null, menuVersion: m?.version ?? 0, placedAt: now, acceptBy: manual ? now + (m?.options.acceptTimeoutMin ?? 5) * 60_000 : null,
        rider: null, posBillNo: null, rejectReason: null, reasonText: null, external: f.external,
      };
      exec(this.db, 'INSERT INTO orders (id, store_id, number, state, data_json, access_hash, accept_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, s.id, order.number, order.state, JSON.stringify(order), hash(randomBytes(24).toString('base64url')), order.acceptBy, now, now);
      onSaved(id);
      return { order, ev: this.addEvent(s.id, id, 'order.created', { order }) };
    });
    this.bus.emit('pos', s.id, res.ev);
    return res.order;
  }

  /** The platform moved its order on (cancelled, picked up by its rider, delivered). False when that step does not apply now. */
  aggregatorMove(storeId: string, orderId: string, to: OrderState, patch: Partial<Order> = {}): boolean {
    try { this.move(storeId, orderId, to, 'aggregator', patch); return true; } catch (e) { if (e instanceof HubError && e.code === 'BAD_TRANSITION') return false; throw e; }
  }

  /** The platform's rider (name, phone) and how far it got, for the ODS. */
  setRider(storeId: string, orderId: string, rider: Rider | null, riderStatus: string | null) {
    const ev = tx(this.db, () => {
      const r = one<OrderRow>(this.db, 'SELECT * FROM orders WHERE id = ? AND store_id = ?', orderId, storeId);
      if (!r) throw new HubError('NOT_FOUND', 'Order not found.', 404);
      const o = JSON.parse(r.data_json) as Order;
      exec(this.db, 'UPDATE orders SET data_json = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...o, rider }), this.now(), orderId);
      return this.addEvent(storeId, orderId, 'order.rider', { orderId, rider, riderStatus });
    });
    this.bus.emit('pos', storeId, ev);
  }

  /** A message for the store about one order (shown on the ODS). */
  addNotice(storeId: string, orderId: string, text: string) {
    const ev = this.addEvent(storeId, orderId, 'order.notice', { orderId, text: text.slice(0, 300) });
    this.bus.emit('pos', storeId, ev);
  }

  order(orderId: string): Order | null {
    const r = one<{ data_json: string }>(this.db, 'SELECT data_json FROM orders WHERE id = ?', orderId);
    return r ? JSON.parse(r.data_json) as Order : null;
  }

  // ---------------------------------------------------------------- POS actions

  eventsSince(storeId: string, afterSeq: number): PosEvent[] {
    return many<{ seq: number; data_json: string }>(this.db, 'SELECT seq, data_json FROM event WHERE store_id = ? AND seq > ? ORDER BY seq LIMIT 500', storeId, afterSeq)
      .map((r) => ({ ...JSON.parse(r.data_json), seq: r.seq }) as PosEvent);
  }

  openOrders(dev: DeviceRef): Order[] {
    return many<{ data_json: string }>(this.db, `SELECT data_json FROM orders WHERE store_id = ? AND state IN (${OPEN_STATES}) ORDER BY created_at`, dev.storeId)
      .map((r) => JSON.parse(r.data_json) as Order);
  }

  posAction(dev: DeviceRef, orderId: string, action: 'received' | 'accept' | 'reject' | 'state', body: Record<string, unknown>, idemKey: string | undefined) {
    if (!idemKey) throw new HubError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key with every change.', 400);
    const scope = `pos:${dev.storeId}`;
    const done = this.idemGet(scope, idemKey);
    if (done) return done;
    const r = one<OrderRow>(this.db, 'SELECT * FROM orders WHERE id = ? AND store_id = ?', orderId, dev.storeId);
    if (!r) throw new HubError('NOT_FOUND', 'Order not found.', 404);
    let out: unknown;
    if (action === 'received') {
      // several counters may confirm; only the first moves the order
      out = r.state === 'SENT_TO_STORE' ? this.move(dev.storeId, orderId, 'RECEIVED', 'pos', {}) : { orderId, state: r.state };
    } else if (action === 'accept') {
      const prep = Number(body.prepMinutes), bill = String(body.posBillNo ?? '');
      if (!Number.isInteger(prep) || prep < 1 || prep > 180) throw new HubError('VALIDATION', 'Preparation time must be 1 to 180 minutes.');
      if (!bill || bill.length > 40) throw new HubError('VALIDATION', 'The POS bill number is missing.');
      out = this.move(dev.storeId, orderId, 'ACCEPTED', 'pos', { prepMinutes: prep, posBillNo: bill });
    } else if (action === 'reject') {
      const reason = String(body.reason ?? '') as RejectReason;
      if (!(REJECT_REASONS as readonly string[]).includes(reason)) throw new HubError('VALIDATION', 'Choose a reason.');
      out = this.move(dev.storeId, orderId, 'REJECTED', 'pos', { rejectReason: reason, reasonText: body.reasonText ? String(body.reasonText).slice(0, 200) : null });
    } else {
      const to = String(body.to ?? '') as OrderState;
      if (!['PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'].includes(to)) throw new HubError('VALIDATION', 'Unknown order step.');
      let rider: Rider | null = null;
      if (to === 'OUT_FOR_DELIVERY') {
        const rd = (body.rider ?? {}) as Record<string, unknown>;
        if (typeof rd.name !== 'string' || !rd.name.trim() || rd.name.length > 60) throw new HubError('VALIDATION', 'Enter the rider name.');
        rider = { name: rd.name.trim(), phone: typeof rd.phone === 'string' && rd.phone.trim() ? rd.phone.trim().slice(0, 15) : null };
      }
      if (to === 'CANCELLED' && !(typeof body.reasonText === 'string' && body.reasonText.trim())) throw new HubError('VALIDATION', 'Give a reason for cancelling.');
      out = this.move(dev.storeId, orderId, to, 'pos', { ...(rider ? { rider } : {}), ...(to === 'CANCELLED' ? { reasonText: String(body.reasonText).slice(0, 200) } : {}) });
    }
    this.idemPut(scope, idemKey, 200, out);
    return out;
  }

  /** One state change, checked against the contract, saved with its events in one transaction, then pushed live. */
  private move(storeId: string, orderId: string, to: OrderState, by: 'pos' | 'customer' | 'hub' | 'aggregator', patch: Partial<Order>) {
    const res = tx(this.db, () => {
      const r = one<OrderRow>(this.db, 'SELECT * FROM orders WHERE id = ? AND store_id = ?', orderId, storeId);
      if (!r) throw new HubError('NOT_FOUND', 'Order not found.', 404);
      const o = JSON.parse(r.data_json) as Order;
      const facts: OrderFacts = { fulfilment: o.fulfilment, payment: o.payment, deliveredBy: o.external?.deliveredBy };
      const ok = canTransition(facts, r.state, to, by);
      if (!ok.ok) throw new HubError('BAD_TRANSITION', ok.reason, 409, { state: r.state });
      const now = this.now();
      const next: Order = { ...o, ...patch, state: to };
      if (to === 'ACCEPTED' && typeof patch.prepMinutes === 'number') next.etaAt = now + patch.prepMinutes * 60_000;
      const keepTimer = to === 'RECEIVED';
      next.acceptBy = keepTimer ? o.acceptBy : null;
      if (!o.external && needsRefund({ ...facts, paid: o.paid }, to)) this.opts.log?.warn('refund needed (online payments: phase 3)', { order: o.number });
      exec(this.db, 'UPDATE orders SET state = ?, data_json = ?, accept_by = ?, updated_at = ? WHERE id = ?', to, JSON.stringify(next), next.acceptBy, now, orderId);
      const type = to === 'AUTO_REJECTED' ? 'order.auto_rejected' : (by === 'customer' || by === 'aggregator') && to === 'CANCELLED' ? 'order.cancelled' : 'order.updated';
      const data = type === 'order.cancelled' ? { orderId, by, reasonText: next.reasonText } : type === 'order.auto_rejected' ? { orderId } : { orderId, state: to, by: by === 'aggregator' ? 'aggregator' : 'pos' };
      const ev = this.addEvent(storeId, orderId, type, data);
      return { next, ev, from: r.state };
    });
    this.bus.emit('pos', storeId, res.ev);
    this.bus.emit('moved', storeId, res.next, by, res.from);
    this.emitCustomer(res.next);
    return { orderId, state: res.next.state, order: res.next };
  }

  /** Timers: unanswered orders are auto-rejected (manual mode, F7); unpaid online orders expire. */
  sweep(): number {
    const now = this.now();
    let n = 0;
    for (const r of many<{ id: string; store_id: string }>(this.db, "SELECT id, store_id FROM orders WHERE state IN ('SENT_TO_STORE','RECEIVED') AND accept_by IS NOT NULL AND accept_by <= ?", now)) {
      try { this.move(r.store_id, r.id, 'AUTO_REJECTED', 'hub', { reasonText: 'The store did not answer in time.' }); n++; } catch { /* accepted meanwhile */ }
    }
    for (const r of many<{ id: string; store_id: string }>(this.db, "SELECT id, store_id FROM orders WHERE state = 'PAYMENT_PENDING' AND created_at <= ?", now - PAYMENT_TTL)) {
      try { this.move(r.store_id, r.id, 'PAYMENT_FAILED', 'hub', {}); n++; } catch { /* paid meanwhile */ }
    }
    exec(this.db, 'DELETE FROM order_attempt WHERE at < ?', now - ATTEMPT_DAYS * 86_400_000);
    this.accounts.sweep();
    return n;
  }

  // ---------------------------------------------------------------- helpers

  private addEvent(storeId: string, orderId: string | null, type: PosEvent['type'], data: Record<string, unknown>): PosEvent {
    const at = this.now();
    const body = { type, at, ...data };
    const seq = Number(exec(this.db, 'INSERT INTO event (store_id, order_id, type, data_json, at) VALUES (?,?,?,?,?)', storeId, orderId, type, JSON.stringify(body), at).lastInsertRowid);
    return { ...body, seq } as unknown as PosEvent;
  }
  private emitCustomer(o: Order) {
    const ev: CustomerEvent = { seq: Date.now(), type: 'order.state', at: this.now(), orderId: o.id, state: o.state, label: label(o.state), etaMinutes: o.etaAt ? Math.max(0, Math.round((o.etaAt - this.now()) / 60_000)) : null, rider: o.rider };
    this.bus.emit('customer', o.id, ev);
  }
  private idemGet(scope: string, key: string): unknown | null {
    const r = one<{ response_json: string }>(this.db, 'SELECT response_json FROM idem WHERE scope = ? AND key = ?', scope, key);
    return r ? JSON.parse(r.response_json) : null;
  }
  private idemPut(scope: string, key: string, status: number, body: unknown) {
    exec(this.db, 'INSERT OR IGNORE INTO idem (scope, key, status, response_json, at) VALUES (?,?,?,?,?)', scope, key, status, JSON.stringify(body), this.now());
  }
}
