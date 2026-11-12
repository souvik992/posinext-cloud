import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { exec, many, one } from './db.ts';
import { HubError } from './hub.ts';
import type { Hub, StoreRow } from './hub.ts';
import { TERMINAL } from '../../contract/src/order.ts';
import type { OrderState } from '../../contract/src/order.ts';
import { priceOrder } from '../../contract/src/menu.ts';
import type { MenuItem, PublishedMenu } from '../../contract/src/menu.ts';
import type { ExternalOrder, Order, OrderLine, PlatformAction, RejectReason, Rider } from '../../contract/src/types.ts';
import type { DeviceRef } from './hub.ts';
import { MOBILE_RE, normaliseMobile } from '../../contract/src/validate.ts';

/**
 * Swiggy and Zomato through UrbanPiper (https://api-docs.urbanpiper.com/downstream). The hub admin saves the one
 * UrbanPiper account in Hub settings (Atlas business: API username, API key, Biz ID; webhooks), and per store its id there,
 * city, address, platforms and packaging charge. Then:
 *   in    UrbanPiper calls POST /v1/urbanpiper/<bizId> (header x-dinepos-token) for new orders, status changes from the
 *         platform (cancelled, picked up, delivered), rider updates, and the results of what we sent. A new order becomes
 *         a hub order (channel swiggy/zomato, priced from the store's published menu like the POS bill) and goes to the
 *         POS over its event stream like any other order.
 *   out   accept / ready / dispatched / completed / cancel from the POS go back as order status updates; the store's
 *         details and menu are sent on demand (then the menu again whenever the POS publishes a changed one); items
 *         switched on/off in the POS and the store pausing are passed on. Order and availability calls go through an
 *         outbox (up_outbox) that retries when UrbanPiper cannot be reached or is busy.
 * Money: UrbanPiper sends rupees as decimals; everything here is converted to integer paise once, at the edge.
 */

export const STAGING_URL = 'https://pos-int.urbanpiper.com';
export const PLATFORMS = ['swiggy', 'zomato'] as const;
export type Platform = typeof PLATFORMS[number];
const NAME: Record<Platform, string> = { swiggy: 'Swiggy', zomato: 'Zomato' };
/** The webhooks we register (one per event; all to the same address). */
export const EVENTS = ['order_placed', 'order_status_update', 'rider_status_update', 'store_creation', 'store_action', 'item_state_toggle', 'option_state_toggle', 'inventory_update', 'hub_menu_publish'];
/** X-UPR-Event-Type codes (api/references/webhook-event-headers). */
const EVENT_CODE: Record<string, string> = { '18': 'order', '60008': 'status', '60012': 'rider', '60013': 'Menu', '60014': 'Store details', '60015': 'Store on/off', '12004': 'Items on/off', '12005': 'Options on/off', '12002': 'Menu published', '60016': 'Category timings', '60018': 'Items out of stock', '60017': 'Order feature', '60019': 'Order retry' };
export const TOKEN_HEADER = 'x-dinepos-token';
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const OTHER_CATEGORY = { ref_id: 'dinepos-other', name: 'Other' };
/** Our reject reasons as UrbanPiper reason codes (order-status-update). An item that is out of stock is sent as
 * "unspecified" with the reason in words: item_out_of_stock needs the item list, and the POS reject has no item. */
const REASON: Record<RejectReason, string> = { ITEM_UNAVAILABLE: 'unspecified', TOO_BUSY: 'store_busy', CLOSING: 'store_closed', OUT_OF_DELIVERY_AREA: 'out_of_delivery_radius', OTHER: 'unspecified' };
const REASON_TEXT: Record<RejectReason, string> = { ITEM_UNAVAILABLE: 'Item not available', TOO_BUSY: 'Store too busy', CLOSING: 'Store closing', OUT_OF_DELIVERY_AREA: 'Outside the delivery area', OTHER: 'Store could not take the order' };

export interface Fetcher { (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{ status: number; text(): Promise<string> }> }
/** The hub's one UrbanPiper account (Atlas business): used for every store. api_key and webhook_token are secrets. */
interface AccountRow { base_url: string; username: string; api_key: string; biz_id: string; webhook_token: string; updated_at: number }
/** A store at UrbanPiper: its id there and what differs per store. */
interface LinkRow {
  store_id: string; location_ref: string; city: string; address: string; phone: string;
  platforms_json: string; enabled: number; items_json: string | null; menu_sig: string | null; store_on: number | null; created_at: number; updated_at: number;
  pack_mode: 'none' | 'per_item' | 'percent'; pack_value: number;
}
/** Packaging charge on Swiggy and Zomato. Both take only item-level packaging: an amount per item, or a share of the item price. */
export interface Packaging { mode: 'none' | 'per_item' | 'percent'; /** paise per item, or basis points of the item price */ value: number }
type LogLine = { at: number; dir: 'in' | 'out'; kind: string; ok: boolean; text: string };
export interface AccountView {
  set: boolean; env: 'staging' | 'production'; baseUrl: string; username: string; apiKeyHint: string | null; bizId: string;
  webhookUrl: string | null; webhookUrlProblem: string | null; stores: number; pending: number; log: LogLine[];
}
export interface LinkView {
  set: boolean; account: { set: boolean; env: 'staging' | 'production' }; locationRef: string;
  city: string; address: string; phone: string; platforms: Platform[]; enabled: boolean;
  /** Packaging as typed: rupees per item, or a percentage. */
  packMode: Packaging['mode']; packValue: string;
  menuSent: boolean; pending: number; log: LogLine[];
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);
/** Rupees (decimal) to paise. */
const paise = (v: unknown) => { const n = num(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const rupees = (p: number) => Math.round(p) / 100;
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const sameSecret = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isLocal = (u: string) => /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(u);

/** An answer from UrbanPiper that is worth trying again later (no connection, busy, their error). */
class Retry extends Error {}

export class UrbanPiper {
  private hub: Hub;
  private fetcher: Fetcher;
  private kick: boolean;
  /** Tests only: webhooks may point at this PC (UrbanPiper itself can never reach it). */
  private allowLocal: boolean;
  private running: Promise<void> | null = null;
  private log?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

  constructor(hub: Hub, o: { fetch?: Fetcher; kick?: boolean; allowLocalWebhooks?: boolean; log?: UrbanPiper['log'] } = {}) {
    this.hub = hub;
    this.fetcher = o.fetch ?? (fetch as unknown as Fetcher);
    this.kick = o.kick ?? true;
    this.allowLocal = o.allowLocalWebhooks ?? false;
    this.log = o.log;
    // never let a problem here break what the hub was doing (the event already happened)
    const safe = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => { try { fn(...a); } catch (e) { this.log?.warn('urbanpiper', String(e)); } };
    hub.bus.on('moved', safe((storeId: string, order: Order, by: string) => this.onMoved(storeId, order, by)));
    hub.bus.on('menu', safe((storeId: string) => this.onMenu(storeId)));
    hub.bus.on('status', safe((storeId: string) => this.onStatus(storeId)));
  }

  // ---------------------------------------------------------------- the UrbanPiper account (Hub settings) and each store (store page)

  private account(): AccountRow | undefined { return one<AccountRow>(this.hub.db, 'SELECT * FROM up_account WHERE id = 1'); }
  private link(storeId: string): LinkRow | undefined { return one<LinkRow>(this.hub.db, 'SELECT * FROM up_link WHERE store_id = ?', storeId); }
  private needAccount(): AccountRow {
    const a = this.account();
    if (!a) throw new HubError('NOT_SET_UP', 'Save the UrbanPiper account first (Hub settings > Swiggy & Zomato).', 409);
    return a;
  }
  private needLink(slug: string): { s: StoreRow; l: LinkRow } {
    const s = this.hub.store({ slug });
    const l = this.link(s.id);
    if (!l) throw new HubError('NOT_SET_UP', 'Save this store\'s UrbanPiper details first.', 409);
    this.needAccount();
    return { s, l };
  }
  private platforms(l: LinkRow): Platform[] { return (JSON.parse(l.platforms_json) as Platform[]).filter((p) => PLATFORMS.includes(p)); }
  private logOf(storeId: string | null): LogLine[] {
    return many<{ at: number; dir: 'in' | 'out'; kind: string; ok: number; text: string }>(this.hub.db, 'SELECT at, dir, kind, ok, text FROM up_log WHERE store_id IS ? ORDER BY id DESC LIMIT 40', storeId).map((r) => ({ ...r, ok: Boolean(r.ok) }));
  }
  private pendingOf(storeId: string | null) { return one<{ n: number }>(this.hub.db, 'SELECT COUNT(*) AS n FROM up_outbox WHERE store_id IS ? AND done_at IS NULL', storeId)?.n ?? 0; }
  /** Where UrbanPiper sends the account's webhooks. Needs the hub's public https address. */
  webhookUrl(bizId: string, base: string) { return `${base.replace(/\/+$/, '')}/v1/urbanpiper/${encodeURIComponent(bizId)}`; }
  private baseProblem(base: string) {
    if (isLocal(base) && !this.allowLocal) return 'This hub runs on this PC only (localhost): UrbanPiper cannot send orders here. Put the hub on the internet with an https address first.';
    return /^https:\/\//.test(base) || isLocal(base) ? null : 'UrbanPiper can only send orders to an https:// address. Open this page through the hub\'s https address (or set HUB_PUBLIC_URL).';
  }

  accountView(base: string): AccountView {
    const a = this.account();
    const stores = one<{ n: number }>(this.hub.db, 'SELECT COUNT(*) AS n FROM up_link')?.n ?? 0;
    if (!a) return { set: false, env: 'staging', baseUrl: STAGING_URL, username: '', apiKeyHint: null, bizId: '', webhookUrl: null, webhookUrlProblem: null, stores, pending: this.pendingOf(null), log: this.logOf(null) };
    return {
      set: true, env: a.base_url === STAGING_URL ? 'staging' : 'production', baseUrl: a.base_url, username: a.username, apiKeyHint: `…${a.api_key.slice(-4)}`, bizId: a.biz_id,
      webhookUrl: this.webhookUrl(a.biz_id, base), webhookUrlProblem: this.baseProblem(base), stores, pending: this.pendingOf(null), log: this.logOf(null),
    };
  }

  /** Saves (or changes) the UrbanPiper account. The API key can be left out to keep the saved one. */
  saveAccount(input: unknown, base: string): AccountView {
    const cur = this.account();
    const b = obj(input);
    const errors: Record<string, string> = {};
    const env = b.env === 'production' ? 'production' : 'staging';
    let baseUrl = STAGING_URL;
    if (env === 'production') {
      baseUrl = str(b.baseUrl).replace(/\/+$/, '');
      if (!/^https:\/\/[^\s/]+$/.test(baseUrl) && !isLocal(baseUrl)) errors.baseUrl = 'Enter the live address UrbanPiper gave you, like https://api.urbanpiper.com (from the certification email).';
    }
    const username = str(b.username);
    if (!/^\S{1,100}$/.test(username)) errors.username = 'Enter the API username (from the UrbanPiper email or the Postman collection).';
    const apiKey = str(b.apiKey);
    if (apiKey ? !/^\S{8,200}$/.test(apiKey) : !cur) errors.apiKey = 'Enter the API key (the part after the colon in "apikey username:key").';
    const bizId = str(b.bizId);
    if (!/^\d{1,20}$/.test(bizId)) errors.bizId = 'Enter the Biz ID: a number (the X-UPR-Biz-Id header).';
    if (Object.keys(errors).length) throw new HubError('VALIDATION', Object.values(errors)[0]!, 400, { fields: errors });
    const now = this.hub.now();
    const token = cur?.webhook_token ?? `upt_${randomBytes(24).toString('base64url')}`;
    exec(this.hub.db, `INSERT INTO up_account (id, base_url, username, api_key, biz_id, webhook_token, updated_at) VALUES (1,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, username = excluded.username, api_key = excluded.api_key, biz_id = excluded.biz_id, updated_at = excluded.updated_at`,
      baseUrl, username, apiKey || cur!.api_key, bizId, token, now);
    // another account (or test <-> live): what was sent to the old one counts as not sent
    if (cur && (cur.biz_id !== bizId || cur.base_url !== baseUrl)) exec(this.hub.db, 'UPDATE up_link SET menu_sig = NULL, items_json = NULL, store_on = NULL');
    this.note(null, 'out', 'Account', true, `Account saved (${env === 'staging' ? 'test account' : 'live account'}, Biz ID ${bizId}).`);
    return this.accountView(base);
  }

  removeAccount() {
    exec(this.hub.db, 'DELETE FROM up_account');
    exec(this.hub.db, 'UPDATE up_outbox SET done_at = ?, last_error = ? WHERE done_at IS NULL', this.hub.now(), 'UrbanPiper account removed');
    exec(this.hub.db, 'UPDATE up_link SET menu_sig = NULL, items_json = NULL, store_on = NULL');
    this.note(null, 'out', 'Account', true, 'UrbanPiper account removed. Swiggy and Zomato orders are refused until it is saved again.');
    return { ok: true };
  }

  view(slug: string): LinkView {
    const s = this.hub.store({ slug });
    const l = this.link(s.id), a = this.account();
    const account = { set: Boolean(a), env: (a && a.base_url !== STAGING_URL ? 'production' : 'staging') as 'staging' | 'production' };
    const log = this.logOf(s.id), pending = this.pendingOf(s.id);
    if (!l) return { set: false, account, locationRef: slug, city: '', address: s.menu_json ? (this.hub.menu(s)?.serviceability.location?.label ?? '') : '', phone: '', platforms: ['swiggy', 'zomato'], enabled: true, packMode: 'none', packValue: '', menuSent: false, pending, log };
    return {
      set: true, account, locationRef: l.location_ref, city: l.city, address: l.address, phone: l.phone, platforms: this.platforms(l), enabled: Boolean(l.enabled),
      packMode: l.pack_mode, packValue: l.pack_mode === 'none' ? '' : String(l.pack_value / 100), menuSent: l.menu_sig !== null, pending, log,
    };
  }

  /** Saves (or changes) a store's details at UrbanPiper. */
  saveLink(slug: string, input: unknown): LinkView {
    const s = this.hub.store({ slug });
    const cur = this.link(s.id);
    const b = obj(input);
    const errors: Record<string, string> = {};
    const locationRef = str(b.locationRef) || slug;
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(locationRef)) errors.locationRef = 'Use letters, digits, dots, dashes or underscores (up to 128).';
    const city = str(b.city);
    if (!city || city.length > 60) errors.city = 'Enter the city of the store.';
    const address = str(b.address).slice(0, 300), phone = str(b.phone);
    if (phone && !/^[0-9+\- ]{6,15}$/.test(phone)) errors.phone = 'Enter a phone number (digits only).';
    const platforms = PLATFORMS.filter((p) => arr(b.platforms).includes(p));
    if (!platforms.length) errors.platforms = 'Choose Swiggy, Zomato or both.';
    // packaging on the platforms: rupees per item (to paise) or a percentage (to basis points); typed text, parsed here
    const packMode: Packaging['mode'] = b.packMode === 'per_item' || b.packMode === 'percent' ? b.packMode : 'none';
    let packValue = 0;
    if (packMode !== 'none') {
      const m = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(str(b.packValue));
      packValue = m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : -1;
      if (packValue <= 0 || (packMode === 'percent' && packValue > 5000)) errors.packValue = packMode === 'percent' ? 'Enter a percentage from 0.01 to 50.' : 'Enter the rupees per item, like 10 or 7.50.';
    }
    if (Object.keys(errors).length) throw new HubError('VALIDATION', Object.values(errors)[0]!, 400, { fields: errors });
    const clash = one<{ slug: string }>(this.hub.db, 'SELECT s.slug FROM up_link u JOIN store s ON s.id = u.store_id WHERE u.location_ref = ? AND u.store_id <> ?', locationRef, s.id);
    if (clash) throw new HubError('VALIDATION', `Store "${clash.slug}" already uses this UrbanPiper store ID. Each store needs its own.`, 409, { fields: { locationRef: 'Already used by another store.' } });
    const now = this.hub.now();
    const enabled = b.enabled === false ? 0 : 1;
    if (cur) {
      exec(this.hub.db, `UPDATE up_link SET location_ref = ?, city = ?, address = ?, phone = ?, platforms_json = ?, enabled = ?, pack_mode = ?, pack_value = ?, updated_at = ?,
        menu_sig = CASE WHEN location_ref = ? THEN menu_sig ELSE NULL END, items_json = CASE WHEN location_ref = ? THEN items_json ELSE NULL END, store_on = CASE WHEN location_ref = ? THEN store_on ELSE NULL END
        WHERE store_id = ?`, locationRef, city, address, phone, JSON.stringify(platforms), enabled, packMode, packValue, now, locationRef, locationRef, locationRef, s.id);
    } else {
      exec(this.hub.db, 'INSERT INTO up_link (store_id, location_ref, city, address, phone, platforms_json, enabled, pack_mode, pack_value, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        s.id, locationRef, city, address, phone, JSON.stringify(platforms), enabled, packMode, packValue, now, now);
    }
    this.note(s.id, 'out', 'Settings', true, `Store details saved (${platforms.map((p) => NAME[p]).join(' and ')}${enabled ? '' : ', orders off'}).`);
    return this.view(slug);
  }

  removeLink(slug: string) {
    const s = this.hub.store({ slug });
    exec(this.hub.db, 'DELETE FROM up_link WHERE store_id = ?', s.id);
    exec(this.hub.db, 'UPDATE up_outbox SET done_at = ?, last_error = ? WHERE store_id = ? AND done_at IS NULL', this.hub.now(), 'UrbanPiper details removed', s.id);
    this.note(s.id, 'out', 'Settings', true, 'UrbanPiper details removed. Swiggy and Zomato orders for this store are refused until they are saved again.');
    return { ok: true };
  }

  // ---------------------------------------------------------------- calls to UrbanPiper

  private async call(a: AccountRow, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    let r: { status: number; text(): Promise<string> };
    try {
      r = await this.fetcher(a.base_url + path, {
        method, headers: { Authorization: `apikey ${a.username}:${a.api_key}`, 'X-UPR-Biz-Id': a.biz_id, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new Retry('UrbanPiper could not be reached. Check the hub\'s internet connection.'); }
    const text = await r.text().catch(() => '');
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { message: text.slice(0, 200) }; }
    if (r.status === 429) throw new Retry('UrbanPiper says too many requests: trying again in a minute.');
    if (r.status >= 500) throw new Retry(`UrbanPiper had a problem (${r.status}): trying again.`);
    return { status: r.status, json };
  }
  private refusal(status: number, json: any): string {
    if (status === 401 || status === 403) return 'UrbanPiper refused the API username, API key or Biz ID. Check them (the test and live accounts have different keys).';
    const m = str(json?.message) || str(json?.error?.message) || str(json?.error) || str(json?.detail);
    return `UrbanPiper refused (${status})${m ? `: ${m.slice(0, 300)}` : '.'}`;
  }
  /** An admin action now: ok with UrbanPiper's message, or the reason in words. storeId null: the account's activity. */
  private async now(storeId: string | null, kind: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; message: string; json: any }> {
    const a = this.needAccount();
    try {
      const r = await this.call(a, method, path, body);
      const ok = r.status >= 200 && r.status < 300 && r.json?.status !== 'error';
      const message = ok ? (str(r.json?.message) || 'Done.') : this.refusal(r.status, r.json);
      this.note(storeId, 'out', kind, ok, message);
      return { ok, message, json: r.json };
    } catch (e) {
      const message = (e as Error).message;
      this.note(storeId, 'out', kind, false, message);
      return { ok: false, message, json: null };
    }
  }

  /** A harmless check that the account works: lists its webhooks. */
  async test() {
    const a = this.needAccount();
    const r = await this.now(null, 'Test', 'GET', '/external/api/v1/webhooks/');
    if (!r.ok) return { ok: false, message: r.message };
    const list = this.webhookList(r.json);
    return { ok: true, message: `Connected to UrbanPiper (${a.base_url === STAGING_URL ? 'test account' : 'live account'}). ${list.length} webhook${list.length === 1 ? '' : 's'} set up for this business.` };
  }
  private webhookList(j: any): Array<{ webhook_id: number; event_type: string; url: string; headers?: Record<string, string>; active?: boolean }> {
    return arr(Array.isArray(j) ? j : j?.webhooks ?? j?.objects ?? j?.data ?? j?.results);
  }

  /** Points the account's UrbanPiper webhooks at this hub (all stores share them). Their API takes 5 calls a minute, so they go out spaced. */
  async setupWebhooks(base: string) {
    const a = this.needAccount();
    const problem = this.baseProblem(base);
    if (problem) throw new HubError('VALIDATION', problem);
    const r = await this.now(null, 'Order links', 'GET', '/external/api/v1/webhooks/');
    if (!r.ok) return { ok: false, message: r.message };
    const url = this.webhookUrl(a.biz_id, base);
    const have = this.webhookList(r.json);
    let queued = 0, kept = 0;
    for (const ev of EVENTS) {
      const w = have.find((x) => x.event_type === ev);
      if (w && w.url === url && w.active !== false && obj(w.headers)[TOKEN_HEADER] === a.webhook_token) { kept++; continue; }
      const body = { active: true, event_type: ev, url, retrial_interval_units: 'seconds', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: a.webhook_token } };
      this.enqueue(null, 'webhook', w ? 'PUT' : 'POST', w ? `/external/api/v1/webhooks/${w.webhook_id}/` : '/external/api/v1/webhooks/', body, `Order link: ${ev}`, 1000 + queued * 13_000);
      queued++;
    }
    const message = queued ? `Setting up ${queued} webhook${queued === 1 ? '' : 's'} to ${url}. UrbanPiper allows 5 a minute, so this takes about ${Math.ceil(queued * 13 / 60)} minute${queued > 4 ? 's' : ''}; follow it in the activity list.` : `All ${kept} webhooks already point to ${url}.`;
    this.note(null, 'out', 'Order links', true, message);
    return { ok: true, message };
  }

  /** The store's details (name, city, address, location, phones, hours, minimum order) to UrbanPiper. */
  async pushStore(slug: string) {
    const { s, l } = this.needLink(slug);
    const m = this.hub.menu(s);
    if (!m) throw new HubError('NOT_PUBLISHED', 'The shop\'s POS has not sent its menu and settings to the hub yet. Connect the POS and turn on online orders first.', 409);
    const r = await this.now(s.id, 'Store details', 'POST', '/external/api/v1/stores/', this.storeBody(s, l, m));
    return { ok: r.ok, message: r.ok ? 'Store details sent. UrbanPiper processes them in the background; the result shows in the activity list.' : r.message };
  }

  storeBody(s: StoreRow, l: LinkRow, m: PublishedMenu) {
    const sv = m.serviceability, z = sv.zones[0];
    const timings = DAYS.map((day, d) => ({ day, slots: (sv.hours[String(d) as keyof typeof sv.hours] ?? []).map((x) => ({ start_time: `${x.open}:00`, end_time: `${x.close}:00` })) })).filter((d) => d.slots.length);
    return {
      stores: [{
        ref_id: l.location_ref, name: m.storeName || s.name, city: l.city, address: l.address || sv.location?.label || '', ...(l.phone ? { contact_phone: l.phone } : {}),
        ...(sv.location ? { geo_latitude: sv.location.lat, geo_longitude: sv.location.lng } : {}),
        active: true, ordering_enabled: Boolean(l.enabled), min_pickup_time: sv.pickup.etaMinutes * 60, min_delivery_time: (z?.etaMinutes ?? 45) * 60,
        min_order_value: rupees(z?.minOrder ?? 0), included_platforms: this.platforms(l), timings,
      }],
    };
  }

  /** The menu now, with what Swiggy and Zomato will object to. Later POS changes follow automatically. */
  async pushMenu(slug: string, base: string) {
    const { s, l } = this.needLink(slug);
    const m = this.hub.menu(s);
    if (!m) throw new HubError('NOT_PUBLISHED', 'The shop\'s POS has not sent its menu to the hub yet.', 409);
    const built = buildMenu(m, this.platforms(l), { mode: l.pack_mode, value: l.pack_value }, (img) => (/^https:\/\//.test(base) ? `${base.replace(/\/+$/, '')}/v1/stores/${encodeURIComponent(s.slug)}/images/${img}` : null));
    if (built.errors.length) return { ok: false, message: built.errors.join(' '), warnings: built.warnings };
    const r = await this.now(s.id, 'Menu', 'POST', `/external/api/v1/inventory/locations/${encodeURIComponent(l.location_ref)}/`, built.body);
    if (r.ok) {
      exec(this.hub.db, 'UPDATE up_link SET menu_sig = ?, items_json = ? WHERE store_id = ?', built.sig, JSON.stringify(built.available), s.id);
      exec(this.hub.db, "INSERT INTO setting (key, value_json, updated_at) VALUES ('urbanpiper.publicBase', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at", JSON.stringify(base), this.hub.now());
    }
    return { ok: r.ok, message: r.ok ? `Menu sent: ${built.counts.items} item${built.counts.items === 1 ? '' : 's'} in ${built.counts.categories} categor${built.counts.categories === 1 ? 'y' : 'ies'}. UrbanPiper checks it in the background (up to 10 minutes); the result shows in the activity list. From now on, menu changes from the POS are sent by themselves.` : r.message, warnings: built.warnings };
  }

  // ---------------------------------------------------------------- what the POS does, passed on

  private onMoved(storeId: string, o: Order, by: string) {
    if (!o.external || by === 'aggregator') return;
    const up = one<{ up_id: string; can_reject: number }>(this.hub.db, 'SELECT up_id, can_reject FROM up_order WHERE order_id = ?', o.id);
    if (!up || !this.link(storeId) || !this.account()) return;
    const name = NAME[o.external.platform];
    let body: Record<string, unknown> | null = null;
    switch (o.state) {
      case 'ACCEPTED': body = { new_status: 'Acknowledged', message: `Accepted, ready in ${o.prepMinutes ?? '?'} min`, extra: o.channel === 'zomato' && o.prepMinutes ? { prep_time_mins: o.prepMinutes } : {} }; break;
      case 'READY': body = { new_status: 'Food Ready', message: 'Food is ready' }; break;
      case 'OUT_FOR_DELIVERY': body = { new_status: 'Dispatched', message: 'Out for delivery', extra: { rider_name: o.rider?.name ?? '', rider_phone: o.rider?.phone ?? '' } }; break;
      case 'DELIVERED': case 'PICKED_UP': body = { new_status: 'Completed', message: o.state === 'PICKED_UP' ? 'Collected by the customer' : 'Delivered' }; break;
      case 'REJECTED': case 'AUTO_REJECTED': case 'CANCELLED': {
        const reason = o.state === 'AUTO_REJECTED' ? 'TOO_BUSY' : (o.rejectReason ?? 'OTHER');
        const text = o.state === 'AUTO_REJECTED' ? 'Not accepted in time' : [o.rejectReason ? REASON_TEXT[o.rejectReason] : null, o.reasonText].filter(Boolean).join(': ') || 'Cancelled by the store';
        body = { new_status: 'Cancelled', reason_code: o.state === 'AUTO_REJECTED' ? REASON.TOO_BUSY : REASON[reason], message: text.slice(0, 200), extra: o.channel === 'swiggy' && up.can_reject ? { swiggy_direct_cancellation: true } : {} };
        break;
      }
    }
    if (body) this.enqueue(storeId, 'status', 'PUT', `/external/api/v1/orders/${encodeURIComponent(up.up_id)}/status/`, body, `${name} ${o.external.orderId} (${o.number}): ${body.new_status}`, 0, o.id);
  }

  /** The POS published its menu: availability changes now, other changes as a new menu (once the menu was sent by hand). */
  private onMenu(storeId: string) {
    const l = this.link(storeId);
    if (!l || !l.enabled || l.menu_sig === null || !this.account()) return;
    const s = this.hub.store({ id: storeId });
    const m = this.hub.menu(s);
    if (!m) return;
    const baseRow = one<{ value_json: string }>(this.hub.db, "SELECT value_json FROM setting WHERE key = 'urbanpiper.publicBase'");
    const base = baseRow ? JSON.parse(baseRow.value_json) as string : '';
    const built = buildMenu(m, this.platforms(l), { mode: l.pack_mode, value: l.pack_value }, (img) => (/^https:\/\//.test(base) ? `${base.replace(/\/+$/, '')}/v1/stores/${encodeURIComponent(s.slug)}/images/${img}` : null));
    if (built.errors.length) return;
    if (built.sig !== l.menu_sig) {
      // a newer menu replaces one still waiting to go
      exec(this.hub.db, "UPDATE up_outbox SET done_at = ?, last_error = 'replaced by a newer menu' WHERE store_id = ? AND kind = 'menu' AND done_at IS NULL", this.hub.now(), storeId);
      this.enqueue(storeId, 'menu', 'POST', `/external/api/v1/inventory/locations/${encodeURIComponent(l.location_ref)}/`, built.body, `Menu changed in the POS (${built.counts.items} items)`, 5000);
      exec(this.hub.db, 'UPDATE up_link SET menu_sig = ? WHERE store_id = ?', built.sig, storeId);
    }
    const before = JSON.parse(l.items_json ?? '{}') as Record<string, boolean>;
    const on: string[] = [], off: string[] = [];
    for (const [id, avail] of Object.entries(built.available)) if (before[id] !== undefined && before[id] !== avail) (avail ? on : off).push(id);
    for (const [ids, action] of [[on, 'enable'], [off, 'disable']] as const) {
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        this.enqueue(storeId, 'items', 'POST', '/hub/api/v1/items/', { location_ref_id: l.location_ref, item_ref_ids: chunk, action }, `${action === 'enable' ? 'Back on' : 'Sold out'}: ${chunk.map((id) => m.items.find((x) => x.id === id)?.name ?? id).slice(0, 5).join(', ')}${chunk.length > 5 ? ` and ${chunk.length - 5} more` : ''}`);
      }
    }
    exec(this.hub.db, 'UPDATE up_link SET items_json = ? WHERE store_id = ?', JSON.stringify(built.available), storeId);
  }

  /** Taking orders (POS accepting, not paused by the hub) switches the store on or off on the platforms. */
  private onStatus(storeId: string) {
    const l = this.link(storeId);
    if (!l || !l.enabled || !this.account()) return;
    const s = this.hub.store({ id: storeId });
    const on = Boolean(s.accepting) && !s.paused_reason ? 1 : 0;
    if (l.store_on === on) return;
    exec(this.hub.db, 'UPDATE up_link SET store_on = ? WHERE store_id = ?', on, storeId);
    const reason = on ? null : s.paused_reason ?? s.accepting_reason ?? 'Not taking orders';
    this.enqueue(storeId, 'store', 'POST', '/hub/api/v1/location/', { location_ref_id: l.location_ref, platforms: this.platforms(l), action: on ? 'enable' : 'disable', ...(reason ? { reason: reason.slice(0, 200) } : {}) }, on ? 'Store on (taking orders)' : `Store off: ${reason}`);
  }

  // ---------------------------------------------------------------- what the store asks the platform about an order

  /**
   * POST /v1/pos/orders/<id>/platform-action from the POS. Checked here (platform, order state), then sent through the
   * outbox; the platform's answer comes back as a notice on the order (customer's number, PIN, refusal).
   *   items_out_of_stock  Swiggy only, before the food is ready (mark-order-item-stock-out)
   *   extra_rider, customer_phone, rider_check   Zomato only (zomato-feature-actions)
   */
  platformAction(dev: DeviceRef, orderId: string, input: unknown, idemKey: string | undefined) {
    if (!idemKey) throw new HubError('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key with every change.', 400);
    const scope = `upact:${dev.storeId}`;
    const done = one<{ response_json: string }>(this.hub.db, 'SELECT response_json FROM idem WHERE scope = ? AND key = ?', scope, idemKey);
    if (done) return JSON.parse(done.response_json);
    const o = this.hub.order(orderId);
    if (!o || o.storeId !== dev.storeId) throw new HubError('NOT_FOUND', 'Order not found.', 404);
    const up = one<{ up_id: string }>(this.hub.db, 'SELECT up_id FROM up_order WHERE order_id = ?', orderId);
    if (!o.external || !up) throw new HubError('NOT_PLATFORM_ORDER', 'This is not a Swiggy or Zomato order.', 409);
    if (!this.link(dev.storeId) || !this.account()) throw new HubError('NOT_SET_UP', 'UrbanPiper is not set up for this store on the hub.', 409);
    if (TERMINAL.includes(o.state)) throw new HubError('ORDER_CLOSED', 'This order is already finished.', 409);
    const b = obj(input) as Partial<PlatformAction> & Record<string, unknown>;
    const name = NAME[o.external.platform], label = (what: string) => `${name} ${o.external!.orderId} (${o.number}): ${what}`;
    const zomato = (what: string) => { if (o.external!.platform !== 'zomato') throw new HubError('NOT_SUPPORTED', `${what} is a Zomato request; this is a ${name} order.`, 409); };
    const feature = (body: Record<string, unknown>, what: string) => this.enqueue(dev.storeId, 'feature', 'POST', '/external/api/v1/aggregator/zomato/feature-action/', { order_id: up.up_id, ...body }, label(what), 0, o.id);
    let message: string;
    if (b.action === 'items_out_of_stock') {
      if (o.external.platform !== 'swiggy') throw new HubError('NOT_SUPPORTED', 'Only Swiggy takes out-of-stock items on an order. For Zomato, reject or cancel the order.', 409);
      if (!['SENT_TO_STORE', 'RECEIVED', 'ACCEPTED', 'PREPARING'].includes(o.state)) throw new HubError('ORDER_CLOSED', 'Swiggy takes this only before the food is marked ready.', 409);
      const ids = [...new Set(arr(b.itemIds).map(str))].filter((id) => o.lines.some((l) => l.itemId === id));
      if (!ids.length) throw new HubError('VALIDATION', 'Choose the items that ran out.');
      const allowEdit = b.allowEdit === true;
      this.enqueue(dev.storeId, 'oos', 'POST', '/hub/api/v1/orders/items-oos/', { order_upipr_id: Number(up.up_id), order_ref_id: o.external.orderId, allow_edit: allowEdit, items_oos: ids.map((ref_id) => ({ ref_id })) },
        label(`out of stock: ${ids.map((id) => o.lines.find((l) => l.itemId === id)!.name).join(', ')}${allowEdit ? ' (customer asked to change the order)' : ' (order cancelled)'}`), 0, o.id);
      message = allowEdit ? 'Sent to Swiggy. Swiggy asks the customer to change the order; the customer\'s number and a PIN to call appear on the order.' : 'Sent to Swiggy: the order will be cancelled.';
    } else if (b.action === 'extra_rider') {
      zomato('Another rider');
      if (!o.external.bulk) throw new HubError('NOT_SUPPORTED', 'Zomato gives an extra rider only for bulk orders.', 409);
      feature({ action: 'request_additional_rider' }, 'extra rider asked for');
      message = 'Asked Zomato for another rider.';
    } else if (b.action === 'customer_phone') {
      zomato('The customer\'s number');
      feature({ action: 'fetch_customer_data' }, 'customer\'s number asked for');
      message = 'Asked Zomato for the customer\'s number. It appears on the order in a moment.';
    } else if (b.action === 'rider_check') {
      zomato('The rider check');
      const temp = num(b.temperatureF), phone = str(b.riderPhone).replace(/\D/g, '');
      if (!(temp >= 90 && temp <= 110)) throw new HubError('VALIDATION', 'Enter the rider\'s temperature in °F (90 to 110).');
      if (typeof b.wearingMask !== 'boolean') throw new HubError('VALIDATION', 'Say whether the rider wears a mask.');
      if (o.external.deliveredBy === 'store' && !/^[6-9]\d{9}$/.test(phone)) throw new HubError('VALIDATION', 'Enter your rider\'s 10-digit mobile number.');
      feature({ action: 'rider_body_temp', temp: Math.round(temp * 10) / 10, ...(o.external.deliveredBy === 'store' ? { phone } : {}) }, `rider temperature ${temp} °F`);
      feature({ action: 'rider_with_mask', wearing_mask: b.wearingMask }, `rider ${b.wearingMask ? 'wears' : 'does not wear'} a mask`);
      message = 'Rider check sent to Zomato.';
    } else throw new HubError('VALIDATION', 'Unknown request.');
    const out = { ok: true, message };
    exec(this.hub.db, 'INSERT OR IGNORE INTO idem (scope, key, status, response_json, at) VALUES (?,?,?,?,?)', scope, idemKey, 200, JSON.stringify(out), this.hub.now());
    return out;
  }

  /** Swiggy's answer to out-of-stock items (Order Level Item Stock-out Callback) and Zomato's to a feature action: a notice. */
  private platformAnswer(b: Record<string, any>): boolean {
    const upId = str(b.upipr_order_id) || (str(b.action) && str(b.platform).toLowerCase() === 'zomato' ? str(b.order_id) : '');
    if (!upId) return false;
    const f = this.orderFor(upId);
    if (!f) return true;
    const name = NAME[f.o.external!.platform];
    let text: string;
    if (b.upipr_order_id !== undefined) {
      const d = obj(b.data);
      text = b.success === false ? `Swiggy could not take the out-of-stock items${str(d.message) ? `: ${str(d.message)}` : '.'}`
        : [str(d.message) || 'Swiggy took the out-of-stock items.', str(d.customer_masked_number) ? `Customer: ${str(d.customer_masked_number)}` : '', str(d.pin) ? `PIN: ${str(d.pin)}` : ''].filter(Boolean).join(' ');
    } else if (str(b.customer_phone)) text = `Customer's number (from ${name}): ${str(b.customer_phone)}`;
    else text = `${name}: ${str(b.action).replace(/_/g, ' ')} ${b.status === false || b.success === false ? 'refused' : 'done'}${str(b.message) ? ` (${str(b.message)})` : ''}.`;
    this.hub.addNotice(f.storeId, f.o.id, text);
    this.note(f.storeId, 'in', `${name} ${f.o.external!.orderId} (${f.o.number})`, b.success !== false && b.status !== false, text);
    return true;
  }

  // ---------------------------------------------------------------- outbox

  private enqueue(storeId: string | null, kind: string, method: string, path: string, body: unknown, label: string, delayMs = 0, orderId: string | null = null) {
    const now = this.hub.now();
    exec(this.hub.db, 'INSERT INTO up_outbox (store_id, kind, method, path, body_json, label, order_id, next_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)', storeId, kind, method, path, JSON.stringify(body), label, orderId, now + delayMs, now);
    if (this.kick && delayMs === 0) void this.pump();
  }

  /** Sends what is due. Safe to call often (the hub's timer calls it every few seconds). */
  pump(): Promise<void> {
    if (!this.running) this.running = this.pumpOnce().finally(() => { this.running = null; });
    return this.running;
  }
  private async pumpOnce() {
    const due = many<{ id: number; store_id: string | null; kind: string; method: string; path: string; body_json: string; label: string; order_id: string | null; attempts: number }>(this.hub.db,
      'SELECT id, store_id, kind, method, path, body_json, label, order_id, attempts FROM up_outbox WHERE done_at IS NULL AND next_at <= ? ORDER BY id LIMIT 20', this.hub.now());
    for (const row of due) {
      const acct = this.account();
      const l = row.store_id ? this.link(row.store_id) : null;
      const finish = (ok: boolean, text: string) => {
        exec(this.hub.db, 'UPDATE up_outbox SET done_at = ?, last_error = ? WHERE id = ?', this.hub.now(), ok ? null : text, row.id);
        this.note(row.store_id, 'out', row.label, ok, text);
        // the store should know when Swiggy / Zomato did not take something about one of its orders
        if (!ok && row.order_id && row.store_id) try { this.hub.addNotice(row.store_id, row.order_id, `Not taken by ${row.label}: ${text}`); } catch { /* order gone */ }
      };
      if (!acct) { finish(false, 'Not sent: the UrbanPiper account was removed.'); continue; }
      if (row.store_id && !l) { finish(false, 'Not sent: the store\'s UrbanPiper details were removed.'); continue; }
      try {
        const r = await this.call(acct, row.method, row.path, JSON.parse(row.body_json));
        const code = str(r.json?.err_code);
        if ((r.status >= 200 && r.status < 300 && r.json?.status !== 'error') || code === 'err_order_already_in_status') finish(true, str(r.json?.message) || 'Done.');
        else finish(false, this.refusal(r.status, r.json));
      } catch (e) {
        if (!(e instanceof Retry)) { finish(false, String((e as Error).message)); continue; }
        const attempts = row.attempts + 1;
        if (attempts >= 10) { finish(false, `Gave up after ${attempts} tries: ${e.message}`); continue; }
        exec(this.hub.db, 'UPDATE up_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?', attempts, this.hub.now() + Math.min(600_000, 15_000 * 2 ** row.attempts) + (/too many/.test(e.message) ? 60_000 : 0), e.message, row.id);
      }
    }
  }

  private note(storeId: string | null, dir: 'in' | 'out', kind: string, ok: boolean, text: string) {
    exec(this.hub.db, 'INSERT INTO up_log (store_id, at, dir, kind, ok, text) VALUES (?,?,?,?,?,?)', storeId, this.hub.now(), dir, kind.slice(0, 120), ok ? 1 : 0, text.slice(0, 500));
    exec(this.hub.db, 'DELETE FROM up_log WHERE store_id IS ? AND id <= (SELECT id FROM up_log WHERE store_id IS ? ORDER BY id DESC LIMIT 1 OFFSET 500)', storeId, storeId);
  }

  // ---------------------------------------------------------------- webhooks from UrbanPiper

  /** POST /v1/urbanpiper/<bizId>. Throws 401 for a wrong secret, 422 (UrbanPiper does not retry) for what can never work. */
  webhook(bizId: string, headers: Record<string, string | string[] | undefined>, body: unknown): unknown {
    const a = this.account();
    const got = String(headers[TOKEN_HEADER] ?? '');
    if (!a || a.biz_id !== bizId || !sameSecret(a.webhook_token, got)) throw new HubError('FORBIDDEN', 'Unknown UrbanPiper business or wrong secret.', 401);
    const links = many<LinkRow>(this.hub.db, 'SELECT * FROM up_link');
    const code = String(headers['x-upr-event-type'] ?? '');
    const kind = EVENT_CODE[code] ?? (obj(obj(body).order).details ? 'order' : `Event ${code || '?'}`);
    const b = obj(body);
    if (kind === 'order') return this.newOrder(links, b);
    if (kind === 'status') return this.statusFromPlatform(b);
    if (kind === 'rider') return this.riderFromPlatform(b);
    if (this.platformAnswer(b)) return { ok: true };
    this.callback(links, kind, b);
    return { ok: true };
  }

  private orderFor(upId: string) {
    const m = one<{ store_id: string; order_id: string }>(this.hub.db, 'SELECT store_id, order_id FROM up_order WHERE up_id = ?', upId);
    const o = m ? this.hub.order(m.order_id) : null;
    return m && o ? { storeId: m.store_id, o } : null;
  }

  private newOrder(links: LinkRow[], b: Record<string, any>) {
    const ord = obj(b.order), d = obj(ord.details);
    const upId = str(d.id);
    if (!upId) throw new HubError('VALIDATION', 'The order has no id.', 422);
    const ref = str(obj(ord.store).merchant_ref_id);
    const l = links.find((x) => x.location_ref === ref) ?? (links.length === 1 && !ref ? links[0] : undefined);
    if (!l) { this.note(null, 'in', 'Order', false, `An order for UrbanPiper store "${ref}" was refused: no hub store has that UrbanPiper store ID.`); throw new HubError('UNKNOWN_STORE', `No store here has the UrbanPiper store ID "${ref}".`, 422); }
    const seen = this.orderFor(upId);
    if (seen) return { order_ref_id: seen.o.number };
    if (!l.enabled) { this.note(l.store_id, 'in', 'Order', false, `Order ${upId} refused: orders from UrbanPiper are switched off for this store.`); throw new HubError('STORE_OFF', 'Orders from UrbanPiper are switched off for this store.', 422); }
    const ext = arr(d.ext_platforms).map(obj);
    const platform = ([str(d.channel), str(ext[0]?.name)].map((x) => x.toLowerCase()).find((x) => (PLATFORMS as readonly string[]).includes(x)) ?? null) as Platform | null;
    if (!platform) { this.note(l.store_id, 'in', 'Order', false, `Order ${upId} from "${str(d.channel)}" refused: only Swiggy and Zomato orders are taken.`); throw new HubError('CHANNEL', 'Only Swiggy and Zomato orders are taken here.', 422); }
    const s = this.hub.store({ id: l.store_id });
    const built = buildOrder(b, platform, ext.find((x) => str(x.name).toLowerCase() === platform) ?? ext[0] ?? {}, this.hub.menu(s), (m, p) => this.hub.forChannel(m, p));
    let order: Order;
    try {
      order = this.hub.createExternalOrder(l.store_id, built, (orderId) => exec(this.hub.db, 'INSERT INTO up_order (up_id, store_id, order_id, platform, can_reject, created_at) VALUES (?,?,?,?,?,?)', upId, l.store_id, orderId, platform, built.canReject ? 1 : 0, this.hub.now()));
    } catch (e) {
      const again = this.orderFor(upId); // the same order arriving twice at once
      if (again) return { order_ref_id: again.o.number };
      throw e;
    }
    this.note(l.store_id, 'in', 'Order', true, `${NAME[platform]} order ${built.external.orderId} → ${order.number}, Rs ${(built.external.platformTotal / 100).toFixed(2)}${built.external.notes.length ? `. ${built.external.notes.join(' ')}` : ''}`);
    return { order_ref_id: order.number };
  }

  private statusFromPlatform(b: Record<string, any>) {
    const f = this.orderFor(str(b.order_id));
    if (!f) return { ok: true };
    const { storeId, o } = f;
    const state = str(b.new_state).toLowerCase(), name = NAME[o.external!.platform];
    let moved: OrderState | null = null;
    if (TERMINAL.includes(o.state)) moved = null;
    else if (state === 'cancelled' || state === 'customer_cancelled') moved = this.hub.aggregatorMove(storeId, o.id, 'CANCELLED', { reasonText: (str(b.message) || (state === 'customer_cancelled' ? `The customer cancelled on ${name}` : `Cancelled on ${name}`)).slice(0, 200) }) ? 'CANCELLED' : null;
    else if (state === 'dispatched' && o.external!.deliveredBy === 'platform') moved = this.hub.aggregatorMove(storeId, o.id, 'OUT_FOR_DELIVERY') ? 'OUT_FOR_DELIVERY' : null;
    else if (state === 'completed') { const to = o.fulfilment === 'PICKUP' ? 'PICKED_UP' : 'DELIVERED'; moved = this.hub.aggregatorMove(storeId, o.id, to) ? to : null; }
    if (moved) this.note(storeId, 'in', 'Order status', true, `${name} ${o.external!.orderId} (${o.number}): ${moved === 'CANCELLED' ? `cancelled by ${name}` : moved === 'OUT_FOR_DELIVERY' ? 'picked up by the rider' : 'completed'}`);
    return { ok: true };
  }

  private riderFromPlatform(b: Record<string, any>) {
    const f = this.orderFor(str(b.order_id));
    if (!f || TERMINAL.includes(f.o.state)) return { ok: true };
    const info = obj(b.delivery_info), p = obj(info.delivery_person_details);
    const rider: Rider | null = str(p.name) ? { name: str(p.name).slice(0, 60), phone: str(p.phone).slice(0, 15) || null } : f.o.rider;
    const state = str(info.current_state);
    this.hub.setRider(f.storeId, f.o.id, rider, state || null);
    if (/^out for delivery$/i.test(state)) this.hub.aggregatorMove(f.storeId, f.o.id, 'OUT_FOR_DELIVERY');
    else if (/^delivered$/i.test(state)) this.hub.aggregatorMove(f.storeId, f.o.id, f.o.fulfilment === 'PICKUP' ? 'PICKED_UP' : 'DELIVERED');
    return { ok: true };
  }

  /** Results of what we sent (store, menu, items on/off, ...): kept for the activity list. */
  private callback(links: LinkRow[], kind: string, b: Record<string, any>) {
    const refs = [str(b.location_ref_id), str(obj(b.location).ref_id), str(obj(b.store).ref_id), ...arr(b.stores).map((x) => str(obj(x).ref_id)), ...arr(b.status).map((x) => str(obj(obj(x).location).ref_id))].filter(Boolean);
    const l = links.find((x) => refs.includes(x.location_ref)) ?? (links.length === 1 ? links[0] : undefined);
    const problems: string[] = [];
    const walk = (v: unknown, depth: number) => {
      if (depth > 6 || problems.length > 5) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      const o = obj(v);
      if (o.error === true || o.success === false || o.status === 'failed' || o.status === false) {
        const msg = str(o.err_msg) || str(o.reason) || str(o.message) || str(o.error_message);
        problems.push(`${str(o.ref_id) || str(o.location_ref_id) || ''}${msg ? ` ${msg}` : ' failed'}`.trim());
      }
      for (const x of Object.values(o)) if (x && typeof x === 'object') walk(x, depth + 1);
    };
    walk(b, 0);
    const stats = obj(b.stats);
    const extra = Object.keys(stats).length ? ` (${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(', ')})` : '';
    const platform = str(b.platform) ? ` on ${str(b.platform)}` : '';
    this.note(l?.store_id ?? null, 'in', kind, problems.length === 0 && b.status !== 'error', problems.length ? `Failed${platform}: ${problems.join('; ')}` : `Done${platform}${extra}.`);
  }
}

// ---------------------------------------------------------------- pure: an order from UrbanPiper, the menu for UrbanPiper

type Built = Pick<Order, 'fulfilment' | 'payment' | 'paid' | 'customer' | 'address' | 'lines' | 'note' | 'itemsTotal' | 'deliveryFee' | 'packagingFee' | 'total' | 'location'> & { external: ExternalOrder; canReject: boolean };

/** UrbanPiper's order (api/endpoints/order-management/order-relay) as a hub order. Priced from the store's published menu
 * with the platform's prices, exactly as the POS will bill it; the platform's own total, charges and discounts are kept
 * beside it. Items not on the menu: the platform's prices are used and the store is told. */
export function buildOrder(b: Record<string, any>, platform: Platform, ext: Record<string, any>, menu: PublishedMenu | null, forChannel: (m: PublishedMenu, p: Platform) => PublishedMenu): Built {
  const ord = obj(b.order), d = obj(ord.details), c = obj(b.customer), a = obj(c.address), extras = obj(ext.extras);
  const name = NAME[platform];
  const notes: string[] = [];
  const fulfilment = /pick|takeaway|take_away/i.test(str(d.order_type)) ? 'PICKUP' : 'DELIVERY';
  const deliveredBy = str(ext.delivery_type).toLowerCase() === 'self' ? 'store' : 'platform';
  const cash = arr(ord.payment).filter((p) => /cash/i.test(str(obj(p).option))).reduce((s, p) => s + paise(obj(p).amount), 0);
  const items = arr(ord.items).map(obj);
  // charges: order level and item level, by title
  const charges = new Map<string, number>();
  for (const ch of [...arr(d.charges), ...items.flatMap((it) => arr(it.charges))].map(obj)) {
    const t = str(ch.title) || 'Charge';
    charges.set(t, (charges.get(t) ?? 0) + paise(ch.value));
  }
  const packaging = [...charges].filter(([t]) => /packag/i.test(t)).reduce((s, [, v]) => s + v, 0);
  const delivery = deliveredBy === 'store' ? [...charges].filter(([t]) => /deliver/i.test(t)).reduce((s, [, v]) => s + v, 0) : 0;
  const cart = items.map((it) => ({ itemId: str(it.merchant_id), qtyMilli: Math.round(num(it.quantity) * 1000) || 1000, modifierIds: arr(it.options_to_add).map((x) => str(obj(x).merchant_id)), note: str(it.instructions).slice(0, 120) || null }));
  let lines: OrderLine[], itemsTotal: number, deliveryFee = 0, packagingFee = 0, total: number;
  const fees = menu?.feeTax ? { delivery, packaging } : { delivery: 0, packaging: 0 };
  if ((delivery || packaging) && !menu?.feeTax) notes.push(`The ${name} charges (packaging, delivery) are not on the POS bill: set the GST rate for charges in the POS (Settings > Serviceability).`);
  const priced = menu ? priceOrder(forChannel(menu, platform), cart, fees) : null;
  if (priced?.ok) ({ lines, itemsTotal, deliveryFee, packagingFee, total } = priced);
  else {
    lines = items.map((it, i) => {
      const mods = arr(it.options_to_add).map(obj).map((x) => ({ id: str(x.merchant_id) || str(x.id), name: str(x.title), price: paise(x.price) * (Math.round(num(x.quantity)) || 1) }));
      const unitPrice = paise(it.price), qtyMilli = cart[i]!.qtyMilli;
      return { itemId: cart[i]!.itemId, name: str(it.title), qtyMilli, unitPrice, modifiers: mods, note: cart[i]!.note, lineTotal: Math.round((unitPrice + mods.reduce((s, m) => s + m.price, 0)) * qtyMilli / 1000) };
    });
    itemsTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    total = itemsTotal;
    notes.push(`Check the items before accepting: ${priced ? priced.message : 'the POS has not sent its menu to the hub'} (${name}'s prices are shown).`);
  }
  const platformTotal = paise(d.order_total ?? d.payable_amount);
  if (cash > 0 && deliveredBy === 'platform') notes.push(`The ${name} rider collects Rs ${(cash / 100).toFixed(2)} in cash from the customer.`);
  if (cash > 0 && deliveredBy === 'store') notes.push(`Collect Rs ${(cash / 100).toFixed(2)} in cash on delivery.`);
  const when = num(d.delivery_datetime);
  if (Number.isFinite(when) && when > num(d.created) + 90 * 60_000) notes.push(`Scheduled for ${new Date(when).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}.`);
  const digits = normaliseMobile(str(c.phone).replace(/[^\d+]/g, ''));
  const lat = num(a.latitude), lng = num(a.longitude);
  const external: ExternalOrder = {
    platform, orderId: str(ext.id) || str(d.merchant_ref_id) || str(d.id), deliveredBy, otp: str(extras.order_otp) || null, platformTotal,
    charges: [...charges].map(([title, amount]) => ({ title, amount })),
    discounts: arr(ext.discounts).map(obj).map((x) => ({ title: str(x.title) || str(x.code) || 'Discount', amount: paise(x.value), byStore: x.is_merchant_discount === true })),
    notes, ...(platform === 'zomato' && extras.is_bulk_order === true ? { bulk: true } : {}),
  };
  return {
    fulfilment, payment: cash > 0 ? 'COD' : 'ONLINE', paid: cash === 0,
    customer: { name: str(c.name).slice(0, 60) || null, mobile: MOBILE_RE.test(digits) ? digits : str(c.phone).slice(0, 20), verified: false },
    address: fulfilment === 'DELIVERY' && Object.keys(a).length ? { line1: (str(a.line_1) || str(a.sub_locality) || '-').slice(0, 120), line2: str(a.line_2).slice(0, 120) || null, landmark: str(a.landmark).slice(0, 120) || null, city: str(a.city).slice(0, 60), pincode: str(a.pin).slice(0, 10) } : null,
    location: fulfilment === 'DELIVERY' && Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? { lat, lng } : null,
    lines, note: str(d.instructions).slice(0, 300) || null, itemsTotal, deliveryFee, packagingFee, total, external,
    canReject: extras.can_reject_order === true,
  };
}

const MEAT = /\b(chicken|mutton|lamb|goat|fish|prawns?|shrimps?|crab|egg|eggs|beef|pork|keema|meat|seafood|squid|duck|turkey|bacon|ham|salami|sausage|tuna|basa|pomfret|surmai|rawas)\b/i;
const PROMO = /\b(off|free|offer|sale|discount|bogo|deal)\b/i;
const ALCOHOL = /\b(beer|rum|whisky|whiskey|vodka|wine|gin|tequila|brandy|cigarettes?|hookah|tobacco)\b/i;

/** The published menu as UrbanPiper's Add/Update Menu body for one store, with the platforms' rules checked
 * (aggregator-constraints/swiggy and /zomato). POS prices that include GST are sent without it, since the platforms add
 * the GST from the tax entries: the customer then pays the POS price. */
export function buildMenu(m: PublishedMenu, platforms: Platform[], packaging: Packaging, imageUrl: (name: string) => string | null) {
  const warnings: string[] = [], errors: string[] = [];
  const off = platforms.filter((p) => !m.options.channels[p]);
  if (off.length) warnings.push(`${off.map((p) => NAME[p]).join(' and ')} ${off.length > 1 ? 'are' : 'is'} switched off in the POS (Settings > Online orders > Sales channels), so no items are listed there.`);
  const listed = (it: MenuItem) => platforms.filter((p) => (it.channels ? it.channels.includes(p) : m.options.channels[p]));
  const items = m.items.filter((it) => listed(it).length);
  if (!items.length) errors.push('No menu items are listed for Swiggy or Zomato. In the POS, switch the channels on (Settings > Online orders) and choose their items.');
  // UrbanPiper has GST taxes only (CGST, SGST): GST is taken out of GST-inclusive prices and added back by the platform as
  // taxes; cess stays inside the price. Either way the customer pays what the POS bill says.
  const exTax = (p: number, it: Pick<MenuItem, 'priceIncludesTax' | 'rateBp' | 'cessBp'>) => (it.priceIncludesTax ? Math.round(p * (10000 + it.cessBp) / (10000 + it.rateBp + it.cessBp)) : Math.round(p * (10000 + it.cessBp) / 10000));
  const usedCats = new Set(items.map((i) => i.categoryId ?? OTHER_CATEGORY.ref_id));
  const categories = [...m.categories].sort((a, b) => a.sort - b.sort).filter((c) => usedCats.has(c.id)).map((c, i) => ({ ref_id: c.id, name: c.name, sort_order: i + 1, active: true }));
  if (usedCats.has(OTHER_CATEGORY.ref_id)) categories.push({ ...OTHER_CATEGORY, sort_order: categories.length + 1, active: true });
  const groupIds = new Set(items.flatMap((i) => i.modifierGroupIds));
  const groups = m.modifierGroups.filter((g) => groupIds.has(g.id));
  const firstItem = (gid: string) => items.find((i) => i.modifierGroupIds.includes(gid))!;
  const rates = [...new Set(items.map((i) => i.rateBp).filter((r) => r > 0))].sort((a, b) => a - b);
  const body = {
    flush_items: true, flush_options: true,
    categories,
    items: items.map((it, i) => {
      const own = listed(it).filter((p) => it.prices?.[p] !== undefined && it.prices[p] !== it.price);
      const img = it.image ? imageUrl(it.image) : null;
      return {
        ref_id: it.id, title: it.name, ...(it.description ? { description: it.description } : {}), price: rupees(exTax(it.price, it)), sort_order: i + 1,
        food_type: it.isVeg === true ? '1' : it.isVeg === false ? '2' : '4', available: it.available, sold_at_store: true, current_stock: -1,
        category_ref_ids: [it.categoryId && m.categories.some((c) => c.id === it.categoryId) ? it.categoryId : OTHER_CATEGORY.ref_id],
        included_platforms: listed(it), ...(own.length ? { platform_pricing: own.map((p) => ({ platform: p, price: rupees(exTax(it.prices![p]!, it)) })) } : {}),
        ...(img ? { images: [{ tag: 'default', url: img }] } : {}),
      };
    }),
    option_groups: groups.map((g, i) => ({ ref_id: g.id, title: g.name, min_selectable: g.minSelect, max_selectable: g.maxSelect, active: true, sort_order: i + 1, item_ref_ids: items.filter((it) => it.modifierGroupIds.includes(g.id)).map((it) => it.id) })),
    options: [...new Map(groups.flatMap((g) => g.modifiers.map((x) => [x.id, { x, gids: groups.filter((gg) => gg.modifiers.some((y) => y.id === x.id)).map((gg) => gg.id), g }] as const))).values()]
      .map(({ x, gids, g }, i) => ({ ref_id: x.id, title: x.name, price: rupees(exTax(x.price, firstItem(g.id))), available: true, sold_at_store: true, sort_order: i + 1, opt_grp_ref_ids: gids })),
    // codes: CGST_P / SGST_P (UrbanPiper's India codes); with more than one GST rate each rate gets its own code (CGST_2.5_P, ...)
    taxes: rates.flatMap((r) => (['CGST', 'SGST'] as const).map((t) => ({
      code: rates.length === 1 ? `${t}_P` : `${t}_${r / 200}_P`, title: t, active: true, structure: { value: r / 200 }, item_ref_ids: items.filter((i) => i.rateBp === r).map((i) => i.id),
    }))),
    // packaging: item level only (Swiggy takes no order-level charges; Zomato only percentages on the order), titled as both require
    ...(packaging.mode === 'none' ? {} : {
      charges: [{
        code: packaging.mode === 'per_item' ? 'PC_F' : 'PC_P', title: 'Packaging Charge', active: true,
        structure: packaging.mode === 'per_item' ? { applicable_on: 'item.quantity', value: rupees(packaging.value) } : { applicable_on: 'item.price', value: packaging.value / 100 },
        fulfillment_modes: ['delivery', 'pickup'], item_ref_ids: items.map((i) => i.id),
      }],
    }),
  };
  // the platforms' rules
  const dup = (names: string[]) => [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  const dupCats = dup(categories.map((c) => c.name.trim().toLowerCase()));
  if (dupCats.length) warnings.push(`Category names must be different on Swiggy: ${dupCats.join(', ')}.`);
  const dupItems = dup(items.map((i) => i.name.trim().toLowerCase()));
  if (dupItems.length) warnings.push(`Item names must be different: ${dupItems.slice(0, 8).join(', ')}.`);
  if (platforms.includes('zomato')) {
    const noDigits = items.map((i) => i.name.replace(/\d+/g, '').replace(/\s+/g, ' ').trim().toLowerCase());
    const clash = dup(noDigits).filter((n) => !dupItems.includes(n));
    if (clash.length) warnings.push(`Zomato ignores numbers in names, so these clash and stop the menu: ${clash.slice(0, 6).map((n) => items.filter((_, i) => noDigits[i] === n).map((i) => i.name).join(' / ')).join('; ')}.`);
  }
  if (items.length > 400) warnings.push(`Swiggy takes up to 400 items per store; this menu lists ${items.length}.`);
  const noDesc = items.filter((i) => !i.description?.trim());
  if (noDesc.length) warnings.push(`${noDesc.length} item${noDesc.length === 1 ? ' has' : 's have'} no description. Swiggy and Zomato want one on every item, with nutrition information (e.g. ${noDesc.slice(0, 3).map((i) => i.name).join(', ')}).`);
  const meatless = items.filter((i) => i.isVeg === false && !MEAT.test(`${i.name} ${i.description ?? ''}`));
  if (meatless.length) warnings.push(`Non-veg items must name the meat in the title or description: ${meatless.slice(0, 5).map((i) => i.name).join(', ')}.`);
  const unknownVeg = items.filter((i) => i.isVeg === null);
  if (unknownVeg.length) warnings.push(`${unknownVeg.length} item${unknownVeg.length === 1 ? ' is' : 's are'} not marked veg or non-veg; Swiggy shows them as non-veg (e.g. ${unknownVeg.slice(0, 3).map((i) => i.name).join(', ')}).`);
  const promo = items.filter((i) => PROMO.test(i.name) || ALCOHOL.test(i.name));
  if (promo.length) warnings.push(`Names may not contain offer words (off, free, offer, sale) or alcohol and tobacco names: ${promo.slice(0, 5).map((i) => i.name).join(', ')}.`);
  if (m.serviceability.packagingFee > 0 && packaging.mode === 'none') warnings.push('The store charges packaging on its own website, but no packaging charge is set for Swiggy and Zomato. Set one in this card (per item, or a percentage of the item price).');
  if (packaging.mode !== 'none') warnings.push('GST on the packaging charge is set by UrbanPiper (Zomato: in Atlas; Swiggy: through your Swiggy contact), not sent from here.');
  if (items.some((i) => i.image) && !items.some((i) => i.image && imageUrl(i.image))) warnings.push('Photos are not sent: the hub has no https:// address yet (open this page through it, or set HUB_PUBLIC_URL).');
  const zero = items.filter((i) => i.price === 0 && !i.modifierGroupIds.length);
  if (zero.length) warnings.push(`Items priced at zero: ${zero.slice(0, 5).map((i) => i.name).join(', ')}.`);
  const available = Object.fromEntries(items.map((i) => [i.id, i.available]));
  const sig = sha(JSON.stringify({ ...body, items: body.items.map(({ available: _a, ...rest }) => rest) }));
  return { body, warnings, errors, sig, available, counts: { items: items.length, categories: categories.length } };
}
