import { randomUUID } from 'node:crypto';
import { exec, many, one, tx } from './db.ts';
import { HubError } from './hub.ts';
import type { Hub, StoreRow } from './hub.ts';
import { readSite } from './site.ts';
import { MOBILE_RE, normaliseMobile } from '../../contract/src/validate.ts';
import { roadKm } from '../../contract/src/serviceability.ts';

/**
 * Brand websites (P6-05): one website (/order/<brand>) for several outlets. The customer gives their location first;
 * the hub chooses the outlet and the customer then sees and orders from that outlet's own menu, prices and fees.
 *
 * - Delivery: the brand's outlets that can take an order right now (POS online, shift open, accepting, open hours,
 *   delivery on, the address inside its delivery bands) are tried nearest first; the first one gets the order.
 * - Pickup: the nearest open outlet that offers pickup.
 * Distance is the road distance from the routing server when one is set, otherwise straight line x the outlet's road
 * factor (the same distance its delivery bands use). An order is placed in the chosen outlet exactly like a store-page
 * order (Hub.placeOrder); when the choice has changed since the customer saw it, nothing is placed (OUTLET_CHANGED) so
 * the customer always orders from the outlet shown. The hub never moves a placed order to another outlet.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{2,40}$/;

interface BrandRow { id: string; slug: string; name: string; main_store_id: string | null; created_at: number }
type Fulfilment = 'PICKUP' | 'DELIVERY';
type Point = { lat: number; lng: number };

const isPoint = (p: unknown): p is Point => {
  const x = p as Point | null;
  return !!x && typeof x.lat === 'number' && typeof x.lng === 'number' && x.lat >= 6 && x.lat <= 38 && x.lng >= 68 && x.lng <= 98;
};

export class Brands {
  private readonly hub: Hub;
  constructor(hub: Hub) { this.hub = hub; }

  private get db() { return this.hub.db; }

  brand(slug: string): BrandRow {
    const b = one<BrandRow>(this.db, 'SELECT * FROM brand WHERE slug = ?', slug);
    if (!b) throw new HubError('NOT_FOUND', 'No such brand.', 404);
    return b;
  }

  isBrand(slug: string): boolean { return Boolean(one(this.db, 'SELECT 1 FROM brand WHERE slug = ?', slug)); }

  /** The brand's outlets, in the order they were added. */
  private outlets(b: BrandRow): StoreRow[] {
    return many<StoreRow>(this.db, 'SELECT s.* FROM brand_store bs JOIN store s ON s.id = bs.store_id WHERE bs.brand_id = ? ORDER BY bs.added_at, s.slug', b.id);
  }

  // ---------------------------------------------------------------- admin

  create(slug: string, name: string) {
    if (!SLUG.test(slug)) throw new HubError('VALIDATION', 'The brand address must be 3-41 lowercase letters, digits or dashes.');
    if (!name.trim() || name.length > 80) throw new HubError('VALIDATION', 'Enter the brand name.');
    if (one(this.db, 'SELECT 1 FROM store WHERE slug = ? UNION ALL SELECT 1 FROM brand WHERE slug = ?', slug, slug)) throw new HubError('SLUG_TAKEN', 'That address is already used by a store or a brand.', 409);
    exec(this.db, 'INSERT INTO brand (id, slug, name, created_at) VALUES (?,?,?,?)', randomUUID(), slug, name.trim(), this.hub.now());
    return this.adminView(slug);
  }

  addStore(brandSlug: string, storeSlug: string) {
    const b = this.brand(brandSlug), s = this.hub.store({ slug: storeSlug });
    const inBrand = one<{ slug: string }>(this.db, 'SELECT b.slug FROM brand_store bs JOIN brand b ON b.id = bs.brand_id WHERE bs.store_id = ?', s.id);
    if (inBrand && inBrand.slug !== b.slug) throw new HubError('IN_OTHER_BRAND', `Store "${s.slug}" is already in brand "${inBrand.slug}". Remove it there first.`, 409);
    tx(this.db, () => {
      if (!inBrand) exec(this.db, 'INSERT INTO brand_store (store_id, brand_id, added_at) VALUES (?,?,?)', s.id, b.id, this.hub.now());
      if (!b.main_store_id) exec(this.db, 'UPDATE brand SET main_store_id = ? WHERE id = ?', s.id, b.id);
    });
    return this.adminView(b.slug);
  }

  /** Takes a store out of the brand (the store and its orders are untouched). */
  removeStore(brandSlug: string, storeSlug: string) {
    const b = this.brand(brandSlug), s = this.hub.store({ slug: storeSlug });
    tx(this.db, () => {
      exec(this.db, 'DELETE FROM brand_store WHERE store_id = ? AND brand_id = ?', s.id, b.id);
      if (b.main_store_id === s.id) {
        const next = one<{ store_id: string }>(this.db, 'SELECT store_id FROM brand_store WHERE brand_id = ? ORDER BY added_at LIMIT 1', b.id);
        exec(this.db, 'UPDATE brand SET main_store_id = ? WHERE id = ?', next?.store_id ?? null, b.id);
      }
    });
    return this.adminView(b.slug);
  }

  /** The outlet whose published website design the brand website shows. */
  setMain(brandSlug: string, storeSlug: string) {
    const b = this.brand(brandSlug), s = this.hub.store({ slug: storeSlug });
    if (!one(this.db, 'SELECT 1 FROM brand_store WHERE store_id = ? AND brand_id = ?', s.id, b.id)) throw new HubError('NOT_IN_BRAND', `Store "${s.slug}" is not in this brand.`, 409);
    exec(this.db, 'UPDATE brand SET main_store_id = ? WHERE id = ?', s.id, b.id);
    return this.adminView(b.slug);
  }

  adminView(slug: string) {
    const b = this.brand(slug);
    return {
      slug: b.slug, name: b.name, createdAt: b.created_at,
      mainStore: b.main_store_id ? this.hub.store({ id: b.main_store_id }).slug : null,
      outlets: this.outlets(b).map((s) => {
        const m = this.hub.menu(s);
        return {
          slug: s.slug, name: s.name, connected: this.hub.connected(s.id), accepting: Boolean(s.accepting), pausedReason: s.paused_reason,
          open: this.hub.availability(s, m ? this.hub.forChannel(m, 'website') : null, { channel: 'website' }),
          location: m?.serviceability.location?.label ?? null, pickup: Boolean(m?.options.fulfilment.pickup), delivery: Boolean(m?.options.fulfilment.delivery),
        };
      }),
    };
  }

  adminList() {
    return many<{ slug: string }>(this.db, 'SELECT slug FROM brand ORDER BY slug').map((b) => this.adminView(b.slug));
  }

  // ---------------------------------------------------------------- customers

  /** The brand website before an outlet is chosen. */
  publicView(slug: string) {
    const b = this.brand(slug);
    const outlets = this.outlets(b);
    const main = b.main_store_id ? outlets.find((s) => s.id === b.main_store_id) : undefined;
    const menus = outlets.map((s) => this.hub.menu(s));
    return {
      kind: 'brand' as const, slug: b.slug, name: b.name, site: readSite(main?.website_json ?? null),
      outlets: outlets.map((s, i) => ({ slug: s.slug, name: s.name, label: menus[i]?.serviceability.location?.label ?? null })),
      fulfilment: { pickup: menus.some((m) => m?.options.fulfilment.pickup), delivery: menus.some((m) => m?.options.fulfilment.delivery) },
    };
  }

  /** Every outlet that can take this order now, nearest first. */
  private async candidates(b: BrandRow, fulfilment: Fulfilment, near: Point) {
    const measure = this.hub.roadKm();
    const found = await Promise.all(this.outlets(b).map(async (s) => {
      const full = this.hub.menu(s);
      const m = full ? this.hub.forChannel(full, 'website') : null;
      if (!this.hub.availability(s, m, { channel: 'website', fulfilment }).open) return null;
      const sv = m!.serviceability;
      if (!sv.location) return fulfilment === 'PICKUP' ? { s, km: null } : null;
      const measured = measure ? await measure(sv.location, near).catch(() => null) : null;
      const km = roadKm(sv, near, measured);
      if (fulfilment === 'DELIVERY' && !sv.zones.some((z) => km <= z.upToKm)) return null;
      return { s, km };
    }));
    return found.filter((x): x is { s: StoreRow; km: number | null } => x !== null)
      .sort((x, y) => (x.km ?? Infinity) - (y.km ?? Infinity) || x.s.slug.localeCompare(y.s.slug));
  }

  /** The outlet that gets an order from here now (and its store page), or NO_OUTLET with a reason for the customer. */
  async choose(slug: string, body: unknown) {
    const b = this.brand(slug);
    const x = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const fulfilment = x.fulfilment === 'DELIVERY' ? 'DELIVERY' : x.fulfilment === 'PICKUP' ? 'PICKUP' : null;
    if (!fulfilment) throw new HubError('VALIDATION', 'Choose pickup or delivery.', 400, { fields: { fulfilment: 'Choose pickup or delivery.' } });
    if (!isPoint(x.location)) throw new HubError('VALIDATION', 'Share your location (or type it) so we can find the outlet nearest to you.', 400, { fields: { location: 'Location needed.' } });
    const best = (await this.candidates(b, fulfilment, x.location))[0];
    if (!best) {
      const message = fulfilment === 'DELIVERY' ? `Sorry, no ${b.name} outlet delivers to this address right now.` : `Sorry, no ${b.name} outlet is open for pickup right now.`;
      this.recordNoOutlet(b, fulfilment, x, message);
      throw new HubError('NO_OUTLET', message, 409);
    }
    return { store: best.s, distanceKm: best.km };
  }

  async outletFor(slug: string, body: unknown) {
    const c = await this.choose(slug, body);
    const m = this.hub.menu(c.store);
    return { outlet: this.hub.storePublic(c.store.slug, 'website'), distanceKm: c.distanceKm, label: m?.serviceability.location?.label ?? null };
  }

  /**
   * An order from the brand website. body = the store-page order (Hub.placeOrder) + store (the outlet the customer was
   * shown) + near (the customer's location for pickup; delivery uses the delivery location).
   */
  async placeOrder(slug: string, body: unknown, idemKey: string | undefined) {
    const b = this.brand(slug);
    const { store, near, ...order } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const storeSlug = typeof store === 'string' ? store : '';
    const s = one<{ id: string }>(this.db, 'SELECT s.id FROM brand_store bs JOIN store s ON s.id = bs.store_id WHERE bs.brand_id = ? AND s.slug = ?', b.id, storeSlug);
    if (!s) throw new HubError('VALIDATION', 'Choose an outlet of this brand.', 400, { fields: { store: 'Not an outlet of this brand.' } });
    const again = this.hub.placedBefore(storeSlug, idemKey); // a retry of an order already placed: the same answer
    if (again) return again;
    const c = await this.choose(slug, { ...order, location: order.fulfilment === 'DELIVERY' ? order.location : near ?? order.location });
    if (c.store.slug !== storeSlug) {
      const outlet = this.hub.storePublic(c.store.slug, 'website');
      throw new HubError('OUTLET_CHANGED', `Your order will now come from ${outlet.name}. Please check your cart and order again.`, 409, { outlet, distanceKm: c.distanceKm });
    }
    return this.hub.placeOrder(storeSlug, order, idemKey);
  }

  /** "No outlet could take it" for the admin page (order_attempt; kept on the brand's main outlet). Never throws. */
  private recordNoOutlet(b: BrandRow, fulfilment: Fulfilment, x: Record<string, unknown>, message: string) {
    try {
      const storeId = b.main_store_id ?? one<{ store_id: string }>(this.db, 'SELECT store_id FROM brand_store WHERE brand_id = ? ORDER BY added_at LIMIT 1', b.id)?.store_id;
      if (!storeId) return;
      const cust = (x.customer && typeof x.customer === 'object' ? x.customer : {}) as Record<string, unknown>;
      const mobile = typeof cust.mobile === 'string' ? normaliseMobile(cust.mobile) : '';
      exec(this.db, 'INSERT INTO order_attempt (store_id, at, channel, fulfilment, payment, customer_name, mobile_masked, total, code, message) VALUES (?,?,?,?,?,?,?,?,?,?)',
        storeId, this.hub.now(), 'website', fulfilment, x.payment === 'COD' || x.payment === 'ONLINE' ? x.payment : null,
        typeof cust.name === 'string' ? cust.name.slice(0, 60) : null, MOBILE_RE.test(mobile) ? mobile.slice(0, 2) + '******' + mobile.slice(-2) : null,
        Number.isSafeInteger(x.expectedTotal) ? x.expectedTotal as number : null, 'NO_OUTLET', `Brand ${b.slug}: ${message}`.slice(0, 300));
    } catch { /* the admin record is not essential */ }
  }
}
