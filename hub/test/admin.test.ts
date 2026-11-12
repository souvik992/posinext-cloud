import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, menu, posStream, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

async function pairedStore(h: TestHub) {
  const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'demo-burger', name: 'Demo Burger Hub' } })).json;
  const key = (await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'Counter 1' } })).json.deviceKey as string;
  await h.call('PUT', '/v1/pos/menu', { key, body: menu() });
  await h.call('PUT', '/v1/pos/status', { key, body: { accepting: true } });
  return { store, key };
}

test('hub admin: the admin page is served without secrets; every admin call needs the key and wrong keys are slowed down', async () => {
  const h = await startHub();
  try {
    const page = await fetch(`${h.base}/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    const html = await page.text();
    assert.match(html, /PosiNext Cloud admin/);
    assert.doesNotMatch(html, /admin-test-key/);
    assert.equal((await h.call('GET', '/v1/admin/overview')).status, 403);
    for (let i = 0; i < 10; i++) await fetch(`${h.base}/v1/admin/overview`, { headers: { 'x-admin-key': 'wrong' } });
    const blocked = await fetch(`${h.base}/v1/admin/overview`, { headers: { 'x-admin-key': 'wrong' } });
    assert.equal(blocked.status, 429);
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub admin: the overview shows each store, its POS devices, whether it is online and taking orders, and recent orders with masked mobiles', async () => {
  const h = await startHub();
  try {
    const { key } = await pairedStore(h);
    const s = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    const o = (await h.call('GET', '/v1/admin/overview', { admin: true })).json;
    assert.deepEqual([o.hub.devOtp, o.hub.onlinePayments], [true, false]);
    const st = o.stores[0];
    assert.deepEqual([st.slug, st.name, st.menuVersion, st.menuItems, st.connected, st.accepting, st.pausedReason, st.openOrders], ['demo-burger', 'Demo Burger Hub', 1, 2, true, true, null, 0]);
    assert.deepEqual(st.devices.map((d: { name: string; revokedAt: number | null }) => [d.name, d.revokedAt]), [['Counter 1', null]]);

    const mobile = '9876543210';
    const { devCode } = (await h.call('POST', '/v1/otp/send', { body: { mobile } })).json;
    const { otpToken } = (await h.call('POST', '/v1/otp/verify', { body: { mobile, otp: devCode } })).json;
    const lines = [{ itemId: 'burger', qtyMilli: 1000 }];
    const q = (await h.call('POST', '/v1/stores/demo-burger/quote', { body: { fulfilment: 'PICKUP', lines } })).json;
    assert.equal((await h.call('POST', '/v1/stores/demo-burger/orders', { body: { fulfilment: 'PICKUP', payment: 'COD', customer: { name: 'Asha', mobile }, otpToken, location: null, address: null, lines, menuVersion: 1, expectedTotal: q.total } })).status, 201);
    const orders = (await h.call('GET', '/v1/admin/stores/demo-burger/orders', { admin: true })).json.orders;
    assert.equal(orders.length, 1);
    assert.deepEqual([orders[0].state, orders[0].total, orders[0].mobile], ['SENT_TO_STORE', q.total, '98******10']);
    assert.equal((await h.call('GET', '/v1/admin/overview', { admin: true })).json.stores[0].openOrders, 1);
    assert.equal((await h.call('GET', '/v1/admin/stores/nope/orders', { admin: true })).status, 404);
    await s.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub admin: pausing a store from the hub closes it for customers until resumed; a revoked POS is refused at once', async () => {
  const h = await startHub();
  try {
    const { key } = await pairedStore(h);
    const s = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    const page = async () => (await h.call('GET', '/v1/stores/demo-burger')).json;
    assert.equal((await page()).open, true);
    assert.equal((await h.call('PUT', '/v1/admin/stores/demo-burger/pause', { admin: true, body: { paused: true, reason: 'Back on Monday' } })).status, 200);
    assert.deepEqual([(await page()).open, (await page()).reason], [false, 'Back on Monday']);
    await h.call('PUT', '/v1/pos/status', { key, body: { accepting: true } }); // the POS cannot undo a hub pause
    assert.equal((await page()).open, false);
    assert.equal((await h.call('GET', '/v1/admin/overview', { admin: true })).json.stores[0].pausedReason, 'Back on Monday');
    await h.call('PUT', '/v1/admin/stores/demo-burger/pause', { admin: true, body: { paused: false } });
    assert.equal((await page()).open, true);
    assert.equal((await h.call('PUT', '/v1/admin/stores/demo-burger/pause', { admin: true, body: { paused: true, reason: 'x'.repeat(201) } })).status, 400);

    const dev = (await h.call('GET', '/v1/admin/overview', { admin: true })).json.stores[0].devices[0];
    assert.equal((await h.call('POST', `/v1/admin/devices/${dev.id}/revoke`, { admin: true })).status, 200);
    assert.equal((await h.call('PUT', '/v1/pos/status', { key, body: { accepting: true } })).status, 401);
    assert.equal((await h.call('POST', '/v1/admin/devices/nope/revoke', { admin: true })).status, 404);
    await s.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub admin: settings are checked, saved in the database, used at once and kept after a restart', async () => {
  let h = await startHub();
  try {
    const before = (await h.call('GET', '/v1/admin/overview', { admin: true })).json.settings;
    assert.deepEqual(before, { routingUrl: '', offlineAfterSec: 60, pairingCodeMinutes: 30, otpPerMinute: 5, ordersPerMinute: 20, pairPerMinute: 10 });
    const bad = await h.call('PUT', '/v1/admin/settings', { admin: true, body: { routingUrl: 'ftp://x', offlineAfterSec: 1 } });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.json.error.details.fields).sort(), ['offlineAfterSec', 'routingUrl']);
    assert.equal((await h.call('PUT', '/v1/admin/settings', { admin: true, body: { nope: 1 } })).status, 400);

    const saved = (await h.call('PUT', '/v1/admin/settings', { admin: true, body: { otpPerMinute: 1, pairingCodeMinutes: 5, routingUrl: 'https://osrm.example.com/' } })).json.settings;
    assert.deepEqual([saved.otpPerMinute, saved.pairingCodeMinutes, saved.routingUrl, saved.ordersPerMinute], [1, 5, 'https://osrm.example.com', 20]);
    assert.equal((await h.call('POST', '/v1/otp/send', { body: { mobile: '9876543210' } })).status, 200);
    assert.equal((await h.call('POST', '/v1/otp/send', { body: { mobile: '9876543211' } })).status, 429); // new limit applies at once

    const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'demo-burger', name: 'Demo Burger Hub' } })).json;
    h.clock.t += 6 * 60_000; // past the 5-minute pairing code
    assert.equal((await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'Counter 1' } })).json.error.code, 'BAD_PAIRING_CODE');
    const fresh = (await h.call('POST', '/v1/admin/stores/demo-burger/pairing-code', { admin: true })).json;
    assert.equal(fresh.expiresAt, h.clock.t + 5 * 60_000);

    h = await h.restart();
    assert.equal((await h.call('GET', '/v1/admin/overview', { admin: true })).json.settings.otpPerMinute, 1);
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub admin: a hub database from before the admin page opens, keeps its stores and can pause them', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hub-old-'));
  const old = new DatabaseSync(join(dir, 'hub.db'));
  old.exec(`CREATE TABLE store (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL, menu_json TEXT, menu_version INTEGER NOT NULL DEFAULT 0,
    accepting INTEGER NOT NULL DEFAULT 0, accepting_reason TEXT, order_counter INTEGER NOT NULL DEFAULT 1000, last_seen_at INTEGER);
    INSERT INTO store (id, slug, name, created_at) VALUES ('s1', 'old-store', 'Old Store', 1);`);
  old.close();
  const h = await startHub(dir);
  try {
    assert.equal((await h.call('GET', '/v1/admin/overview', { admin: true })).json.stores[0].slug, 'old-store');
    assert.equal((await h.call('PUT', '/v1/admin/stores/old-store/pause', { admin: true, body: { paused: true } })).json.pausedReason, 'This store is not taking online orders right now.');
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub admin: adding a store gives one connection link (hub address + one-use code); opening it in a browser does not use it up', async () => {
  const h = await startHub();
  try {
    const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'demo-burger', name: 'Demo Burger Hub' } })).json;
    assert.equal(store.connectUrl, `${h.base}/connect/${store.pairingCode}`);
    const page = await fetch(store.connectUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), new RegExp(store.pairingCode));
    assert.equal((await fetch(`${h.base}/connect/%3Cscript%3E`).then((r) => r.text())).includes('<script>'), false);
    assert.equal((await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'Counter 1' } })).status, 200); // still unused
    const proxied = await fetch(`${h.base}/v1/admin/stores/demo-burger/pairing-code`, { method: 'POST', headers: { 'x-admin-key': 'admin-test-key', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'orders.example.in' } });
    assert.match((await proxied.json()).connectUrl, /^https:\/\/orders\.example\.in\/connect\/[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub admin: a store shows the settings its POS published; orders are listed for all stores or one, open or all, with their items', async () => {
  const h = await startHub();
  try {
    assert.equal((await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'second-store', name: 'Second' } })).status, 200);
    assert.equal((await h.call('GET', '/v1/admin/stores/second-store', { admin: true })).json.published, null); // no menu yet
    const { key } = await pairedStore(h);
    const s = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    const d = (await h.call('GET', '/v1/admin/stores/demo-burger', { admin: true })).json;
    assert.deepEqual([d.name, d.published.options.acceptMode, d.published.options.acceptTimeoutMin, d.published.serviceability.location.label, d.published.menu], ['Demo Burger Hub', 'manual', 5, 'Kalyan Nagar', { items: 2, unavailable: 0, categories: [{ name: 'Burgers', items: 2 }] }]);
    assert.equal((await h.call('GET', '/v1/admin/stores/nope', { admin: true })).status, 404);

    const mobile = '9876543210';
    const { devCode } = (await h.call('POST', '/v1/otp/send', { body: { mobile } })).json;
    const { otpToken } = (await h.call('POST', '/v1/otp/verify', { body: { mobile, otp: devCode } })).json;
    const lines = [{ itemId: 'burger', qtyMilli: 2000 }];
    const q = (await h.call('POST', '/v1/stores/demo-burger/quote', { body: { fulfilment: 'PICKUP', lines } })).json;
    const placed = (await h.call('POST', '/v1/stores/demo-burger/orders', { body: { fulfilment: 'PICKUP', payment: 'COD', customer: { name: 'Asha', mobile }, otpToken, location: null, address: null, lines, menuVersion: 1, expectedTotal: q.total } })).json;
    const all = (await h.call('GET', '/v1/admin/orders', { admin: true })).json.orders;
    assert.deepEqual([all.length, all[0].store, all[0].customerName, all[0].mobile, all[0].lines], [1, { slug: 'demo-burger', name: 'Demo Burger Hub' }, 'Asha', '98******10', [{ name: 'Cheese Burger', qtyMilli: 2000, modifiers: [], note: null, lineTotal: q.total }]]);
    assert.equal((await h.call('GET', '/v1/admin/orders?store=second-store', { admin: true })).json.orders.length, 0);
    assert.equal((await h.call('GET', '/v1/admin/orders?status=open', { admin: true })).json.orders.length, 1);
    await h.call('POST', `/v1/pos/orders/${placed.order.id}/reject`, { key, idem: 'r1', body: { reason: 'TOO_BUSY' } });
    assert.equal((await h.call('GET', '/v1/admin/orders?status=open', { admin: true })).json.orders.length, 0);
    assert.equal((await h.call('GET', '/v1/admin/orders?status=all&store=demo-burger', { admin: true })).json.orders[0].rejectReason, 'TOO_BUSY');
    assert.equal((await h.call('GET', '/v1/admin/orders?store=nope', { admin: true })).status, 404);
    await s.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub admin: each order shows one status (placed, accepted, preparing, in transit, delivered, cancelled by store or customer, failed) with what happened', async () => {
  const h = await startHub();
  try {
    const { key } = await pairedStore(h);
    let s = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    const mobile = '9876543210';
    const { devCode } = (await h.call('POST', '/v1/otp/send', { body: { mobile } })).json;
    const { otpToken } = (await h.call('POST', '/v1/otp/verify', { body: { mobile, otp: devCode } })).json;
    const place = async (fulfilment: 'PICKUP' | 'DELIVERY' = 'PICKUP') => {
      const lines = [{ itemId: 'burger', qtyMilli: 1000 }];
      const location = fulfilment === 'DELIVERY' ? { lat: 13.03, lng: 77.646 } : null;
      const q = (await h.call('POST', '/v1/stores/demo-burger/quote', { body: { fulfilment, location, lines } })).json;
      const r = await h.call('POST', '/v1/stores/demo-burger/orders', { body: { fulfilment, payment: 'COD', customer: { name: 'Asha', mobile }, otpToken, location, lines, menuVersion: 1, expectedTotal: q.total,
        address: fulfilment === 'DELIVERY' ? { line1: '12, 4th Cross', city: 'Bengaluru', pincode: '560043' } : null } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json as { order: { id: string }; accessToken: string };
    };
    let n = 0;
    const act = (id: string, action: string, body: unknown) => h.call('POST', `/v1/pos/orders/${id}/${action}`, { key, idem: `i${n++}`, body });
    const status = async (id: string) => {
      const o = (await h.call('GET', '/v1/admin/orders?status=all', { admin: true })).json.orders.find((x: { id: string }) => x.id === id);
      return [o.status, o.statusDetail];
    };
    const a = await place();
    assert.deepEqual(await status(a.order.id), ['placed', 'Not yet seen by the store']);
    await act(a.order.id, 'received', {});
    assert.deepEqual(await status(a.order.id), ['placed', 'Seen by the store, waiting for it to accept']);
    await act(a.order.id, 'accept', { prepMinutes: 10, posBillNo: 'B1' });
    assert.equal((await status(a.order.id))[0], 'accepted');
    await act(a.order.id, 'state', { to: 'PREPARING' });
    assert.equal((await status(a.order.id))[0], 'preparing');
    await act(a.order.id, 'state', { to: 'READY' });
    assert.deepEqual(await status(a.order.id), ['preparing', 'Ready for pickup']);
    await act(a.order.id, 'state', { to: 'PICKED_UP' });
    assert.deepEqual(await status(a.order.id), ['delivered', 'Picked up by the customer']);

    const d = await place('DELIVERY');
    await act(d.order.id, 'accept', { prepMinutes: 10, posBillNo: 'B2' });
    await act(d.order.id, 'state', { to: 'PREPARING' });
    await act(d.order.id, 'state', { to: 'READY' });
    assert.deepEqual(await status(d.order.id), ['preparing', 'Ready, waiting for the rider']);
    assert.equal((await act(d.order.id, 'state', { to: 'OUT_FOR_DELIVERY', rider: { name: 'Raju' } })).status, 200);
    assert.deepEqual(await status(d.order.id), ['in_transit', 'Rider: Raju']);

    const r = await place();
    await act(r.order.id, 'reject', { reason: 'TOO_BUSY', reasonText: 'Rush hour' });
    assert.deepEqual(await status(r.order.id), ['cancelled_store', 'Too busy: Rush hour']);
    const c = await place();
    await h.call('POST', `/v1/orders/${c.order.id}/cancel`, { token: c.accessToken, body: { reasonText: 'Ordered by mistake' } });
    assert.deepEqual(await status(c.order.id), ['cancelled_customer', 'Ordered by mistake']);
    const k = await place();
    await act(k.order.id, 'accept', { prepMinutes: 10, posBillNo: 'B3' });
    await act(k.order.id, 'state', { to: 'CANCELLED', reasonText: 'Gas cylinder empty' });
    assert.deepEqual(await status(k.order.id), ['cancelled_store', 'Gas cylinder empty']);

    // the store's POS goes offline: the order never reaches it and is auto-rejected
    await s.close();
    const lost = await place();
    h.clock.t += 6 * 60_000;
    h.hub.sweep();
    assert.deepEqual(await status(lost.order.id), ['failed', 'The order did not reach the store: its POS was offline or had no internet. Rejected automatically.']);
    s = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    const slow = await place();
    await act(slow.order.id, 'received', {});
    h.clock.t += 6 * 60_000;
    h.hub.sweep();
    assert.deepEqual(await status(slow.order.id), ['failed', 'The store did not accept in time. Rejected automatically.']);

    const groups = async (st: string) => (await h.call('GET', `/v1/admin/orders?status=${st}`, { admin: true })).json.orders.map((o: { status: string }) => o.status).sort();
    assert.deepEqual(await groups('cancelled'), ['cancelled_customer', 'cancelled_store', 'cancelled_store']);
    assert.deepEqual(await groups('delivered'), ['delivered']);
    assert.deepEqual(await groups('open'), ['in_transit']);
    await s.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub admin: order attempts that fail before an order exists (store offline, price changed, technical error) are listed as failed with the reason', async () => {
  const h = await startHub();
  try {
    const { key } = await pairedStore(h);
    const mobile = '9876543210';
    const { devCode } = (await h.call('POST', '/v1/otp/send', { body: { mobile } })).json;
    const { otpToken } = (await h.call('POST', '/v1/otp/verify', { body: { mobile, otp: devCode } })).json;
    const body = (o: Record<string, unknown> = {}) => ({ fulfilment: 'PICKUP', payment: 'COD', customer: { name: 'Asha', mobile }, otpToken, location: null, address: null, lines: [{ itemId: 'burger', qtyMilli: 1000 }], menuVersion: 1, expectedTotal: 12900, channel: 'app', ...o });
    assert.equal((await h.call('POST', '/v1/stores/demo-burger/orders', { body: body() })).status, 409); // no POS stream: offline
    const s = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await h.call('POST', '/v1/stores/demo-burger/orders', { body: body({ expectedTotal: 100 }) })).json.error.code, 'PRICE_CHANGED');
    const orig = (h.hub as unknown as { priceWithFees: unknown }).priceWithFees;
    (h.hub as unknown as { priceWithFees: () => never }).priceWithFees = () => { throw new Error('disk I/O error'); };
    assert.equal((await h.call('POST', '/v1/stores/demo-burger/orders', { body: body() })).status, 500);
    (h.hub as unknown as { priceWithFees: unknown }).priceWithFees = orig;

    const failed = (await h.call('GET', '/v1/admin/orders?status=failed', { admin: true })).json.orders;
    assert.deepEqual(failed.map((o: { kind: string; status: string; channel: string; payment: string; mobile: string; errorCode: string; statusDetail: string }) => [o.kind, o.status, o.channel, o.payment, o.mobile, o.errorCode, o.statusDetail]), [
      ['attempt', 'failed', 'app', 'COD', '98******10', 'INTERNAL', 'Technical error on the hub: disk I/O error'],
      ['attempt', 'failed', 'app', 'COD', '98******10', 'PRICE_CHANGED', 'The total is now Rs 129.00. Please check and order again.'],
      ['attempt', 'failed', 'app', 'COD', '98******10', 'STORE_CLOSED', 'The store is offline right now. Please try again later.'],
    ]);
    assert.equal((await h.call('GET', '/v1/admin/orders?status=all', { admin: true })).json.orders.length, 3);
    assert.equal((await h.call('GET', '/v1/admin/orders?status=open', { admin: true })).json.orders.length, 0);
    h.clock.t += 31 * 86_400_000; // kept 30 days
    h.hub.sweep();
    assert.equal((await h.call('GET', '/v1/admin/orders?status=failed', { admin: true })).json.orders.length, 0);
    await s.close();
  } finally { await h.close(); cleanup(h.dir); }
});
