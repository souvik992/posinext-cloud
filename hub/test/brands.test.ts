import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, menu, posStream, startHub, STORE_AT } from './helpers.ts';
import type { TestHub } from './helpers.ts';
import { DEFAULT_SERVICEABILITY } from '../../contract/src/serviceability.ts';

// P6-05: a brand website sends each order to the nearest outlet that can take it.
// Outlet A at STORE_AT; outlet B ~4.3 km north; delivery bands up to 6 km (road factor 1, so straight line = road).
const A_AT = STORE_AT;
const B_AT = { lat: 13.06, lng: 77.646 };
const NEAR_B = { lat: 13.055, lng: 77.646 }; // ~0.6 km from B, ~3.8 km from A: both deliver here
const NEAR_A = { lat: 13.0225, lng: 77.646 }; // ~0.1 km from A
const FAR = { lat: 13.2, lng: 77.646 }; // outside every outlet's bands

async function outlet(h: TestHub, slug: string, at: { lat: number; lng: number }, o: { price?: number } = {}) {
  const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug, name: `Outlet ${slug}` } })).json;
  const key = (await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'Counter' } })).json.deviceKey as string;
  const m = menu({ storeName: `Outlet ${slug}` });
  m.serviceability = { ...m.serviceability, location: { ...at, label: `${slug} street` } };
  if (o.price) m.items[0]!.price = o.price;
  assert.equal((await h.call('PUT', '/v1/pos/menu', { key, body: m })).status, 200);
  assert.equal((await h.call('PUT', '/v1/pos/status', { key, body: { accepting: true } })).status, 200);
  const stream = posStream(h.base, key);
  return { slug, key, stream };
}

async function brandWith(h: TestHub, slugs: string[]) {
  assert.equal((await h.call('POST', '/v1/admin/brands', { admin: true, body: { slug: 'spice', name: 'Spice Garden' } })).status, 200);
  for (const s of slugs) assert.equal((await h.call('PUT', `/v1/admin/brands/spice/stores/${s}`, { admin: true })).status, 200);
}

const settle = () => new Promise((r) => setTimeout(r, 100)); // POS streams connected
const find = (h: TestHub, fulfilment: string, location: unknown) => h.call('POST', '/v1/brands/spice/outlet', { body: { fulfilment, location } });

async function brandOrder(h: TestHub, store: string, o: { fulfilment?: string; location?: { lat: number; lng: number }; near?: { lat: number; lng: number }; idem?: string } = {}) {
  const mobile = '9876543210';
  const sent = (await h.call('POST', '/v1/otp/send', { body: { mobile } })).json;
  const { otpToken } = (await h.call('POST', '/v1/otp/verify', { body: { mobile, otp: sent.devCode } })).json;
  const fulfilment = o.fulfilment ?? 'DELIVERY';
  const lines = [{ itemId: 'burger', qtyMilli: 1000 }];
  const location = fulfilment === 'DELIVERY' ? o.location ?? NEAR_B : null;
  const q = await h.call('POST', `/v1/stores/${store}/quote`, { body: { fulfilment, location, lines } });
  return h.call('POST', '/v1/brands/spice/orders', { idem: o.idem, body: {
    store, near: o.near ?? null, fulfilment, payment: 'COD', customer: { name: 'Asha', mobile }, otpToken, location, lines, menuVersion: 1, expectedTotal: q.json?.total ?? 0,
    address: fulfilment === 'DELIVERY' ? { line1: '12, 4th Cross', city: 'Bengaluru', pincode: '560043' } : null,
  } });
}

test('brands: a delivery goes to the nearest outlet that delivers there; the menu shown is that outlet’s own', async () => {
  const h = await startHub();
  const a = await outlet(h, 'out-a', A_AT), b = await outlet(h, 'out-b', B_AT, { price: 13900 });
  try {
    await brandWith(h, ['out-a', 'out-b']);
    await settle();
    const r = await find(h, 'DELIVERY', NEAR_B);
    assert.equal(r.status, 200);
    assert.equal(r.json.outlet.slug, 'out-b');
    assert.equal(r.json.distanceKm, 0.6);
    assert.equal(r.json.outlet.menu.items.find((i: { id: string }) => i.id === 'burger').price, 13900); // B's price, not A's
    assert.equal((await find(h, 'DELIVERY', NEAR_A)).json.outlet.slug, 'out-a');
  } finally { await a.stream.close(); await b.stream.close(); await h.close(); cleanup(h.dir); }
});

test('brands: with the nearest outlet closed or not delivering to the address, the next nearest gets it; with none, a clear message and a failed attempt', async () => {
  const h = await startHub();
  const a = await outlet(h, 'out-a', A_AT), b = await outlet(h, 'out-b', B_AT);
  try {
    await brandWith(h, ['out-a', 'out-b']);
    await settle();
    await h.call('PUT', '/v1/pos/status', { key: b.key, body: { accepting: false, reason: 'Shift closed' } });
    assert.equal((await find(h, 'DELIVERY', NEAR_B)).json.outlet.slug, 'out-a'); // B closed: A (3.8 km) delivers there
    await h.call('PUT', '/v1/pos/status', { key: b.key, body: { accepting: true } });
    // B delivers only up to 0.5 km now: the address (0.6 km) is outside its bands, so A gets it
    const m = menu({ storeName: 'Outlet out-b' });
    m.serviceability = { ...m.serviceability, location: { ...B_AT, label: 'out-b street' }, zones: [{ ...DEFAULT_SERVICEABILITY.zones[0]!, upToKm: 0.5 }] };
    await h.call('PUT', '/v1/pos/menu', { key: b.key, body: m });
    assert.equal((await find(h, 'DELIVERY', NEAR_B)).json.outlet.slug, 'out-a');

    const none = await find(h, 'DELIVERY', FAR);
    assert.equal(none.status, 409);
    assert.equal(none.json.error.code, 'NO_OUTLET');
    assert.match(none.json.error.message, /no Spice Garden outlet delivers to this address right now/);
    const failed = (await h.call('GET', '/v1/admin/orders?status=failed', { admin: true })).json.orders as Array<{ kind: string; code?: string; error?: { code: string } }>;
    assert.ok(failed.some((x) => JSON.stringify(x).includes('NO_OUTLET')), JSON.stringify(failed));
    assert.equal((await find(h, 'DELIVERY', { lat: 50, lng: 0 })).json.error.code, 'VALIDATION'); // a location is needed
  } finally { await a.stream.close(); await b.stream.close(); await h.close(); cleanup(h.dir); }
});

test('brands: pickup goes to the nearest open outlet', async () => {
  const h = await startHub();
  const a = await outlet(h, 'out-a', A_AT), b = await outlet(h, 'out-b', B_AT);
  try {
    await brandWith(h, ['out-a', 'out-b']);
    await settle();
    assert.equal((await find(h, 'PICKUP', NEAR_A)).json.outlet.slug, 'out-a');
    assert.equal((await find(h, 'PICKUP', FAR)).json.outlet.slug, 'out-b'); // pickup has no delivery bands: B is nearer to FAR
    await h.call('PUT', '/v1/pos/status', { key: b.key, body: { accepting: false } });
    assert.equal((await find(h, 'PICKUP', FAR)).json.outlet.slug, 'out-a');
    await h.call('PUT', '/v1/pos/status', { key: a.key, body: { accepting: false } });
    const none = await find(h, 'PICKUP', FAR);
    assert.equal(none.json.error.code, 'NO_OUTLET');
    assert.match(none.json.error.message, /no Spice Garden outlet is open for pickup/);
  } finally { await a.stream.close(); await b.stream.close(); await h.close(); cleanup(h.dir); }
});

test('brands: a store outside the brand is never chosen, even when it is the nearest', async () => {
  const h = await startHub();
  const a = await outlet(h, 'out-a', A_AT), c = await outlet(h, 'other-c', NEAR_B);
  try {
    await brandWith(h, ['out-a']);
    await settle();
    assert.equal((await find(h, 'DELIVERY', NEAR_B)).json.outlet.slug, 'out-a');
    assert.equal((await find(h, 'PICKUP', NEAR_B)).json.outlet.slug, 'out-a');
    const refused = await brandOrder(h, 'other-c');
    assert.equal(refused.status, 400); // an order for a store outside the brand is refused
    assert.equal((await h.call('GET', '/v1/admin/orders', { admin: true })).json.orders.filter((o: { kind: string }) => o.kind === 'order').length, 0);
  } finally { await a.stream.close(); await c.stream.close(); await h.close(); cleanup(h.dir); }
});

test('brands: the outlet shown at checkout is the one that gets the order; a changed choice places nothing; a retry gives the same order', async () => {
  const h = await startHub();
  const a = await outlet(h, 'out-a', A_AT), b = await outlet(h, 'out-b', B_AT);
  try {
    await brandWith(h, ['out-a', 'out-b']);
    await settle();
    const placed = await brandOrder(h, 'out-b', { idem: 'k1' });
    assert.equal(placed.status, 201, JSON.stringify(placed.json));
    const bId = h.hub.store({ slug: 'out-b' }).id;
    assert.equal(placed.json.order.storeId, bId);
    await b.stream.waitFor((e) => e.some((x) => x.type === 'order.created')); // reaches B's POS
    const again = await brandOrder(h, 'out-b', { idem: 'k1' });
    assert.equal(again.json.order.id, placed.json.order.id);

    // the customer saw A, but B is now the nearest that can take it: nothing is placed, the page is told B
    const changed = await brandOrder(h, 'out-a', { idem: 'k2' });
    assert.equal(changed.status, 409);
    assert.equal(changed.json.error.code, 'OUTLET_CHANGED');
    assert.equal(changed.json.error.details.outlet.slug, 'out-b');
    const orders = (await h.call('GET', '/v1/admin/orders', { admin: true })).json.orders.filter((o: { kind: string }) => o.kind === 'order');
    assert.equal(orders.length, 1);

    // pickup: chosen by the customer's location (near), not sent on the order
    const pick = await brandOrder(h, 'out-a', { fulfilment: 'PICKUP', near: NEAR_A, idem: 'k3' });
    assert.equal(pick.status, 201, JSON.stringify(pick.json));
    assert.equal(pick.json.order.storeId, h.hub.store({ slug: 'out-a' }).id);
  } finally { await a.stream.close(); await b.stream.close(); await h.close(); cleanup(h.dir); }
});

test('brands: the admin page lists each brand’s outlets and their state; addresses never clash; a store is in one brand only', async () => {
  const h = await startHub();
  const a = await outlet(h, 'out-a', A_AT), b = await outlet(h, 'out-b', B_AT);
  try {
    assert.equal((await h.call('POST', '/v1/admin/brands', { body: { slug: 'spice', name: 'X' } })).status, 403); // admin key needed
    await brandWith(h, ['out-a', 'out-b']);
    await settle();
    await h.call('PUT', '/v1/pos/status', { key: b.key, body: { accepting: false, reason: 'Kitchen closed' } });
    const list = (await h.call('GET', '/v1/admin/brands', { admin: true })).json.brands;
    assert.equal(list.length, 1);
    assert.equal(list[0].mainStore, 'out-a'); // the first outlet added
    assert.deepEqual(list[0].outlets.map((o: { slug: string; connected: boolean; accepting: boolean; open: { open: boolean } }) => [o.slug, o.connected, o.accepting, o.open.open]),
      [['out-a', true, true, true], ['out-b', true, false, false]]);
    assert.equal((await h.call('PUT', '/v1/admin/brands/spice/main', { admin: true, body: { store: 'out-b' } })).json.mainStore, 'out-b');

    assert.equal((await h.call('POST', '/v1/admin/brands', { admin: true, body: { slug: 'out-a', name: 'Clash' } })).json.error.code, 'SLUG_TAKEN');
    assert.equal((await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'spice', name: 'Clash' } })).json.error.code, 'SLUG_TAKEN');
    await h.call('POST', '/v1/admin/brands', { admin: true, body: { slug: 'other', name: 'Other' } });
    assert.equal((await h.call('PUT', '/v1/admin/brands/other/stores/out-a', { admin: true })).json.error.code, 'IN_OTHER_BRAND');

    const removed = (await h.call('DELETE', '/v1/admin/brands/spice/stores/out-b', { admin: true })).json;
    assert.deepEqual(removed.outlets.map((o: { slug: string }) => o.slug), ['out-a']);
    assert.equal(removed.mainStore, 'out-a'); // the main outlet left: the next one is main
    assert.equal((await h.call('GET', '/v1/stores/out-b')).status, 200); // the store itself is untouched
  } finally { await a.stream.close(); await b.stream.close(); await h.close(); cleanup(h.dir); }
});

test('brands: /order/<brand> opens the brand website; /order/<store> works unchanged', async () => {
  const h = await startHub();
  const a = await outlet(h, 'out-a', A_AT);
  try {
    await brandWith(h, ['out-a']);
    const brandPage = await (await fetch(`${h.base}/order/spice`)).text();
    assert.match(brandPage, /const BRAND = true, BRAND_SLUG = SLUG;/);
    assert.match(brandPage, /let SLUG = "spice";/);
    const storePage = await (await fetch(`${h.base}/order/out-a`)).text();
    assert.match(storePage, /const BRAND = false/);
    assert.match(storePage, /let SLUG = "out-a";/);
    const pub = (await h.call('GET', '/v1/brands/spice')).json;
    assert.equal(pub.name, 'Spice Garden');
    assert.deepEqual(pub.outlets.map((o: { slug: string; label: string }) => [o.slug, o.label]), [['out-a', 'out-a street']]);
    assert.deepEqual(pub.fulfilment, { pickup: true, delivery: true });
    assert.equal((await h.call('GET', '/v1/brands/nope')).status, 404);
  } finally { await a.stream.close(); await h.close(); cleanup(h.dir); }
});

test('brands: with a routing server, outlets are ranked by road distance (not straight line)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Hub } = await import('../src/hub.ts');
  const { Brands } = await import('../src/brands.ts');
  const dir = mkdtempSync(join(tmpdir(), 'hub-brand-'));
  // B is nearer in a straight line, but a river makes it 5.5 km by road; A is 3.9 km by road
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), now: () => Date.parse('2026-10-16T12:00:00+05:30'), roadKm: async (from) => (from.lat === B_AT.lat ? 5.5 : 3.9) });
  try {
    const brands = new Brands(hub);
    for (const [slug, at] of [['out-a', A_AT], ['out-b', B_AT]] as const) {
      const s = hub.createStore(slug, slug);
      const dev = hub.pair(s.pairingCode, 'Counter');
      const ref = hub.device(dev.deviceKey);
      const m = menu();
      m.serviceability = { ...m.serviceability, location: { ...at, label: slug } };
      hub.publishMenu(ref, m);
      hub.setStatus(ref, { accepting: true });
      hub.streamOpened(s.storeId);
    }
    brands.create('spice', 'Spice Garden');
    brands.addStore('spice', 'out-a'); brands.addStore('spice', 'out-b');
    const c = await brands.choose('spice', { fulfilment: 'DELIVERY', location: NEAR_B });
    assert.equal(c.store.slug, 'out-a');
    assert.equal(c.distanceKm, 3.9);
  } finally { hub.close(); cleanup(dir); }
});
