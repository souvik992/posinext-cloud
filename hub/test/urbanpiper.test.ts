import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, menu, posStream, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';
import type { Fetcher } from '../src/urbanpiper.ts';
import { buildMenu, STAGING_URL, TOKEN_HEADER } from '../src/urbanpiper.ts';
import { one } from '../src/db.ts';

/** A stand-in UrbanPiper: records each call and answers like the docs (api-docs.urbanpiper.com/downstream). */
function fakeUrbanPiper() {
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: any }> = [];
  const state = { webhooks: [] as any[], down: 0, status: new Map<string, number>(), refuseFeature: false };
  const reply = (status: number, json: unknown) => ({ status, text: async () => JSON.stringify(json) });
  const fetch: Fetcher = async (url, init) => {
    const path = url.replace(STAGING_URL, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, headers: init.headers, body });
    if (state.down > 0) { state.down--; return reply(503, { message: 'busy' }); }
    if (init.headers.Authorization !== 'apikey dinepos:secret-key-123') return reply(401, { status: 'error', message: 'Invalid credentials' });
    if (path === '/external/api/v1/webhooks/' && init.method === 'GET') return reply(200, state.webhooks);
    if (path === '/external/api/v1/webhooks/' && init.method === 'POST') return reply(200, { status: 'success', message: 'webhooks has been successfully created.', webhook_id: 100 + calls.length });
    if (/^\/external\/api\/v1\/webhooks\/\d+\/$/.test(path)) return reply(200, { status: 'success' });
    if (path === '/external/api/v1/stores/') return reply(200, { status: 'success', message: 'Your request has been queued.', reference: 'ref-store-1' });
    if (path.startsWith('/external/api/v1/inventory/locations/')) return reply(200, { status: 'success', message: 'Your request has been queued.', reference: 'ref-menu-1' });
    if (path === '/external/api/v1/aggregator/zomato/feature-action/') return state.refuseFeature ? reply(400, { status: 'error', message: 'not enabled for this outlet' }) : reply(200, { status: 'success', message: 'Your request has been enqueued to be dispatched to Zomato' });
    if (path === '/hub/api/v1/orders/items-oos/') return reply(200, { status: 'success', message: 'Your request has been queued.', reference_id: 'oos-1' });
    if (path === '/hub/api/v1/items/' || path === '/hub/api/v1/location/') return reply(200, { status: 'success', message: 'Task queued successfully', reference_id: 'r1' });
    const st = /^\/external\/api\/v1\/orders\/(\d+)\/status\/$/.exec(path);
    if (st) {
      if (state.status.get(st[1]!) && body.new_status === 'Acknowledged') return reply(400, { status: 'error', err_code: 'err_order_already_in_status', message: 'already' });
      state.status.set(st[1]!, 1);
      return reply(200, { status: 'success', message: 'Order status updated' });
    }
    return reply(404, { message: 'no such path' });
  };
  return { calls, state, fetch };
}

const NO_PACKAGING = { mode: 'none' as const, value: 0 };
const ACCOUNT = { env: 'staging', username: 'dinepos', apiKey: 'secret-key-123', bizId: '324255' };
const DETAILS = { locationRef: 'DINE-KN-1', city: 'Bengaluru', address: '12, 4th Cross, Kalyan Nagar', phone: '08041440067', platforms: ['swiggy', 'zomato'] };
const ONLINE_MENU = (o: Parameters<typeof menu>[0] = {}) => menu({
  options: { acceptMode: 'manual', acceptTimeoutMin: 5, channels: { app: true, website: true, swiggy: true, zomato: true }, fulfilment: { pickup: true, delivery: true }, payments: { online: true, cod: true } },
  ...o,
});

async function setup(h: TestHub) {
  const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'demo-burger', name: 'Demo Burger Hub' } })).json;
  const key = (await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'Counter 1' } })).json.deviceKey as string;
  assert.equal((await h.call('PUT', '/v1/pos/menu', { key, body: ONLINE_MENU() })).status, 200);
  assert.equal((await h.call('PUT', '/v1/pos/status', { key, body: { accepting: true } })).status, 200);
  assert.equal((await h.call('PUT', '/v1/admin/urbanpiper', { admin: true, body: ACCOUNT })).status, 200);
  const saved = await h.call('PUT', '/v1/admin/stores/demo-burger/urbanpiper', { admin: true, body: DETAILS });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const token = one<{ webhook_token: string }>(h.hub.db, 'SELECT webhook_token FROM up_account')!.webhook_token;
  const hook = (event: string, body: unknown, t = token) => h.call('POST', '/v1/urbanpiper/324255', { body, headers: { [TOKEN_HEADER]: t, 'x-upr-event-type': event } });
  return { key, hook };
}

/** An order relay payload, shaped like the docs' sample (api/endpoints/order-management/order-relay). */
function relay(o: { id?: number; channel?: string; delivery?: 'partner' | 'self'; cash?: number; store?: string; items?: unknown[] } = {}) {
  const channel = o.channel ?? 'swiggy';
  return {
    customer: { name: 'Asha', phone: '+91-9876543210', email: '', address: { line_1: 'Flat 4, Lake View', line_2: null, landmark: 'Near the park', city: 'Bengaluru', pin: '560043', latitude: 13.03, longitude: 77.646, sub_locality: 'Kalyan Nagar', is_guest_mode: false, tag: 'home' } },
    order: {
      details: {
        id: o.id ?? 3444567, biz_id: 324255, channel, order_type: 'delivery', order_state: 'Placed', created: 1760600000000, delivery_datetime: 1760600000000,
        instructions: 'Ring the bell', order_subtotal: 258, order_total: 271, payable_amount: 271, discount: 20, total_charges: 20, total_taxes: 13,
        charges: [{ title: 'Packaging Charge', value: 20, taxes: [] }], taxes: [],
        ext_platforms: [{ id: 'SW-998877', kind: 'food_aggregator', name: channel, delivery_type: o.delivery ?? 'partner', extras: { order_otp: '4321', can_reject_order: true, ...(o.cash ? { cash_to_be_collected: o.cash } : {}) }, discounts: [{ is_merchant_discount: true, rate: 0, title: 'Store promo', value: 20, code: 'TRY20' }] }],
      },
      items: o.items ?? [{ id: 1, title: 'Cheese Burger', merchant_id: 'burger', price: 122.86, quantity: 2, total: 245.72, options_to_add: [], options_to_remove: [], charges: [], taxes: [], instructions: 'no onion' }],
      next_state: 'Acknowledged', payment: o.cash ? [{ option: 'cash', amount: o.cash }] : [{ option: 'payment_gateway', amount: 271 }],
      store: { id: 1712, name: 'Kalyan Nagar', merchant_ref_id: o.store ?? 'DINE-KN-1' },
    },
  };
}

test('urbanpiper: one account in Hub settings (key never shown again, tested, webhooks pointed at the hub); each store adds only its own details', async () => {
  const up = fakeUrbanPiper();
  const h = await startHub(undefined, undefined, up.fetch);
  try {
    await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'demo-burger', name: 'Demo Burger Hub' } });
    await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'second-shop', name: 'Second Shop' } });
    assert.equal((await h.call('GET', '/v1/admin/urbanpiper')).status, 403, 'admin key needed');
    assert.equal((await h.call('GET', '/v1/admin/urbanpiper', { admin: true })).json.set, false);
    // the account
    const bad = await h.call('PUT', '/v1/admin/urbanpiper', { admin: true, body: { ...ACCOUNT, apiKey: '', bizId: 'abc' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.json.error.details.fields).sort(), ['apiKey', 'bizId']);
    const live = await h.call('PUT', '/v1/admin/urbanpiper', { admin: true, body: { ...ACCOUNT, env: 'production', baseUrl: 'http://evil.example.com' } });
    assert.ok(live.json.error.details.fields.baseUrl, 'the live address must be https');
    const saved = (await h.call('PUT', '/v1/admin/urbanpiper', { admin: true, body: ACCOUNT })).json;
    assert.equal(saved.set, true);
    assert.equal(saved.apiKeyHint, '…-123');
    assert.ok(!JSON.stringify(saved).includes('secret-key-123'), 'the key is never sent back');
    assert.ok(!JSON.stringify(saved).includes(one<{ webhook_token: string }>(h.hub.db, 'SELECT webhook_token FROM up_account')!.webhook_token), 'nor the webhook secret');
    assert.equal(saved.webhookUrl, `${h.base}/v1/urbanpiper/324255`);
    await h.call('PUT', '/v1/admin/urbanpiper', { admin: true, body: { ...ACCOUNT, apiKey: '' } });
    assert.equal(one<{ api_key: string }>(h.hub.db, 'SELECT api_key FROM up_account')!.api_key, 'secret-key-123', 'leaving the key empty keeps it');

    // stores: only their own details; one store ID per store
    const empty = (await h.call('GET', '/v1/admin/stores/demo-burger/urbanpiper', { admin: true })).json;
    assert.deepEqual([empty.set, empty.locationRef, empty.account], [false, 'demo-burger', { set: true, env: 'staging' }]);
    const noPlatforms = await h.call('PUT', '/v1/admin/stores/demo-burger/urbanpiper', { admin: true, body: { ...DETAILS, platforms: [] } });
    assert.deepEqual(Object.keys(noPlatforms.json.error.details.fields), ['platforms']);
    assert.equal((await h.call('PUT', '/v1/admin/stores/demo-burger/urbanpiper', { admin: true, body: DETAILS })).json.set, true);
    const clash = await h.call('PUT', '/v1/admin/stores/second-shop/urbanpiper', { admin: true, body: DETAILS });
    assert.equal(clash.status, 409);
    assert.equal((await h.call('PUT', '/v1/admin/stores/second-shop/urbanpiper', { admin: true, body: { ...DETAILS, locationRef: 'DINE-2' } })).status, 200);
    assert.equal((await h.call('GET', '/v1/admin/urbanpiper', { admin: true })).json.stores, 2);

    const t = (await h.call('POST', '/v1/admin/urbanpiper/test', { admin: true })).json;
    assert.equal(t.ok, true, t.message);
    assert.deepEqual(up.calls[0]!.headers['X-UPR-Biz-Id'], '324255');
    assert.equal(up.calls[0]!.headers.Authorization, 'apikey dinepos:secret-key-123');

    // webhooks (for the account, all stores): one exists for another address (updated), the rest are created, spaced for 5 a minute
    up.state.webhooks = [{ webhook_id: 7, event_type: 'order_placed', url: 'https://old.example.com/hook', active: true, headers: {} }];
    const w = (await h.call('POST', '/v1/admin/urbanpiper/webhooks', { admin: true })).json;
    assert.equal(w.ok, true);
    assert.match(w.message, /Setting up 9 webhooks/);
    up.calls.length = 0;
    for (let i = 0; i < 12; i++) { h.clock.t += 13_000; await h.up.pump(); }
    assert.equal(up.calls.length, 9);
    assert.equal(up.calls[0]!.method, 'PUT');
    assert.equal(up.calls[0]!.path, '/external/api/v1/webhooks/7/');
    const created = up.calls.filter((c) => c.method === 'POST').map((c) => c.body.event_type).sort();
    assert.deepEqual(created, ['hub_menu_publish', 'inventory_update', 'item_state_toggle', 'option_state_toggle', 'order_status_update', 'rider_status_update', 'store_action', 'store_creation']);
    for (const c of up.calls) { assert.equal(c.body.url, `${h.base}/v1/urbanpiper/324255`); assert.ok(c.body.headers[TOKEN_HEADER].startsWith('upt_')); }

    // a wrong key is explained, in the account's activity list
    await h.call('PUT', '/v1/admin/urbanpiper', { admin: true, body: { ...ACCOUNT, apiKey: 'wrong-key-999' } });
    assert.match((await h.call('POST', '/v1/admin/urbanpiper/test', { admin: true })).json.message, /refused the API username, API key or Biz ID/);
    const view = (await h.call('GET', '/v1/admin/urbanpiper', { admin: true })).json;
    assert.ok(view.log.some((l: { ok: boolean; kind: string }) => !l.ok && l.kind === 'Test'), 'the activity list shows it');
  } finally { await h.close(); cleanup(h.dir); }
});

test('urbanpiper: store details and menu go out in UrbanPiper\'s shape, with GST-free prices and the platforms\' rules checked', async () => {
  const up = fakeUrbanPiper();
  const h = await startHub(undefined, undefined, up.fetch);
  try {
    await setup(h);
    const s = (await h.call('POST', '/v1/admin/stores/demo-burger/urbanpiper/store', { admin: true })).json;
    assert.equal(s.ok, true, s.message);
    const store = up.calls.find((c) => c.path === '/external/api/v1/stores/')!.body.stores[0];
    assert.equal(store.ref_id, 'DINE-KN-1');
    assert.equal(store.city, 'Bengaluru');
    assert.deepEqual([store.geo_latitude, store.geo_longitude], [13.0213, 77.646]);
    assert.deepEqual(store.included_platforms, ['swiggy', 'zomato']);
    assert.equal(store.timings.length, 7);
    assert.deepEqual(store.timings[0], { day: 'sunday', slots: [{ start_time: '00:00:00', end_time: '23:59:00' }] });

    const m = (await h.call('POST', '/v1/admin/stores/demo-burger/urbanpiper/menu', { admin: true })).json;
    assert.equal(m.ok, true, m.message);
    assert.ok(m.warnings.some((w: string) => /no description/.test(w)));
    const call = up.calls.find((c) => c.path.startsWith('/external/api/v1/inventory/locations/'))!;
    assert.equal(call.path, '/external/api/v1/inventory/locations/DINE-KN-1/');
    const burger = call.body.items.find((i: { ref_id: string }) => i.ref_id === 'burger');
    assert.equal(burger.price, 122.86, 'Rs 129 including 5% GST is sent as Rs 122.86 plus 2.5% CGST and 2.5% SGST');
    assert.equal(burger.food_type, '1');
    assert.deepEqual(burger.category_ref_ids, ['c1']);
    assert.deepEqual(call.body.taxes.map((t: { code: string; title: string; structure: { value: number } }) => [t.code, t.title, t.structure.value]), [['CGST_2.5_P', 'CGST', 2.5], ['SGST_2.5_P', 'SGST', 2.5], ['CGST_6_P', 'CGST', 6], ['SGST_6_P', 'SGST', 6]]);
    assert.equal(call.body.flush_items, true, 'items removed in the POS leave the store on UrbanPiper');
  } finally { await h.close(); cleanup(h.dir); }
});

test('urbanpiper: menu rules of Swiggy and Zomato are pointed out before sending', () => {
  const m = ONLINE_MENU({
    items: [
      { id: 'a', categoryId: 'c1', name: 'Chicken 65', price: 20000, unit: 'pcs', isVeg: false, rateBp: 500, cessBp: 0, priceIncludesTax: false, modifierGroupIds: [], available: true, description: 'Spicy chicken, 300 kcal' },
      { id: 'b', categoryId: 'c1', name: 'Chicken 95', price: 20000, unit: 'pcs', isVeg: false, rateBp: 500, cessBp: 0, priceIncludesTax: false, modifierGroupIds: [], available: true, description: 'Spicy chicken, 310 kcal' },
      { id: 'c', categoryId: null, name: 'Veg Thali offer', price: 15000, unit: 'pcs', isVeg: null, rateBp: 500, cessBp: 0, priceIncludesTax: false, modifierGroupIds: [], available: true },
      { id: 'd', categoryId: 'c1', name: 'Biryani', price: 25000, unit: 'pcs', isVeg: false, rateBp: 500, cessBp: 0, priceIncludesTax: false, modifierGroupIds: [], available: true, description: 'Dum biryani, 600 kcal', channels: ['zomato'] },
    ],
  });
  const b = buildMenu(m, ['swiggy', 'zomato'], NO_PACKAGING, () => null);
  const all = b.warnings.join('\n');
  assert.match(all, /Zomato ignores numbers in names.*Chicken 65 \/ Chicken 95/);
  assert.match(all, /Non-veg items must name the meat.*Biryani/);
  assert.match(all, /not marked veg or non-veg/);
  assert.match(all, /offer words.*Veg Thali offer/);
  assert.deepEqual(b.body.items.find((i) => i.ref_id === 'd')!.included_platforms, ['zomato'], 'an item listed only for Zomato');
  assert.deepEqual(b.body.items.find((i) => i.ref_id === 'c')!.category_ref_ids, ['dinepos-other'], 'items without a category go to "Other"');
  assert.equal(buildMenu(ONLINE_MENU({ options: { ...ONLINE_MENU().options, channels: { app: true, website: true, swiggy: false, zomato: false } } }), ['swiggy'], NO_PACKAGING, () => null).errors.length, 1, 'nothing to send when the channels are off in the POS');
});

test('urbanpiper: a Swiggy order reaches the POS once; accept, ready and the platform\'s rider follow it to delivery', async () => {
  const up = fakeUrbanPiper();
  const h = await startHub(undefined, undefined, up.fetch);
  try {
    const { key, hook } = await setup(h);
    const pos = posStream(h.base, key);
    assert.equal((await hook('18', relay(), 'upt_wrong')).status, 401, 'a wrong secret is refused');
    const r = await hook('18', relay());
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { order_ref_id: 'S-1001' });
    assert.deepEqual((await hook('18', relay())).json, { order_ref_id: 'S-1001' }, 'UrbanPiper retrying: no second order');
    assert.equal((await hook('18', relay({ id: 5, store: 'NOT-OURS' }))).status, 422, 'an unknown store is refused for good (no retries)');
    assert.equal((await hook('18', relay({ id: 6, channel: 'ubereats' }))).status, 422);
    await pos.waitFor((e) => e.some((x) => x.type === 'order.created'));
    const o = pos.events.find((x) => x.type === 'order.created')!.order as any;
    assert.equal(o.channel, 'swiggy');
    assert.equal(o.number, 'S-1001');
    assert.equal(o.state, 'SENT_TO_STORE');
    assert.equal(o.customer.mobile, '9876543210');
    assert.equal(o.address.landmark, 'Near the park');
    assert.deepEqual(o.lines.map((l: any) => [l.itemId, l.qtyMilli, l.unitPrice, l.note]), [['burger', 2000, 12900, 'no onion']], 'priced from the POS menu with the Swiggy price');
    assert.equal(o.packagingFee, 2000, 'the Swiggy packaging charge is on the bill (GST for charges is set)');
    assert.equal(o.deliveryFee, 0, 'the Swiggy rider delivers: no delivery fee on the store bill');
    assert.deepEqual({ ...o.external, notes: undefined }, { platform: 'swiggy', orderId: 'SW-998877', deliveredBy: 'platform', otp: '4321', platformTotal: 27100, charges: [{ title: 'Packaging Charge', amount: 2000 }], discounts: [{ title: 'Store promo', amount: 2000, byStore: true }], notes: undefined });
    assert.equal(o.paid, true);

    // the POS accepts, marks it ready: UrbanPiper hears it
    up.calls.length = 0;
    assert.equal((await h.call('POST', `/v1/pos/orders/${o.id}/accept`, { key, idem: 'a1', body: { prepMinutes: 15, posBillNo: 'INV-77' } })).status, 200);
    assert.equal((await h.call('POST', `/v1/pos/orders/${o.id}/state`, { key, idem: 's1', body: { to: 'READY' } })).status, 200);
    await h.up.pump();
    assert.deepEqual(up.calls.map((c) => [c.method, c.path, c.body.new_status]), [['PUT', '/external/api/v1/orders/3444567/status/', 'Acknowledged'], ['PUT', '/external/api/v1/orders/3444567/status/', 'Food Ready']]);
    // the store cannot send the Swiggy rider out itself
    assert.equal((await h.call('POST', `/v1/pos/orders/${o.id}/state`, { key, idem: 's2', body: { to: 'OUT_FOR_DELIVERY', rider: { name: 'Ravi' } } })).status, 409);
    // the Swiggy rider: assigned, then picked up, then delivered
    await hook('60012', { order_id: 3444567, delivery_info: { current_state: 'Assigned', delivery_person_details: { name: 'Ravi K', phone: '9000000000' }, mode: 'aggregator', status_updates: [] }, store: { ref_id: 'DINE-KN-1' } });
    await pos.waitFor((e) => e.some((x) => x.type === 'order.rider'));
    assert.deepEqual(pos.events.find((x) => x.type === 'order.rider')!.rider, { name: 'Ravi K', phone: '9000000000' });
    await hook('60012', { order_id: 3444567, delivery_info: { current_state: 'Out for delivery', delivery_person_details: { name: 'Ravi K', phone: '9000000000' } } });
    await pos.waitFor((e) => e.some((x) => x.type === 'order.updated' && x.state === 'OUT_FOR_DELIVERY' && x.by === 'aggregator'));
    await hook('60008', { order_id: 3444567, new_state: 'Completed', prev_state: 'Dispatched', from_aggregator: true });
    await pos.waitFor((e) => e.some((x) => x.type === 'order.updated' && x.state === 'DELIVERED'));
    up.calls.length = 0;
    await h.up.pump();
    assert.equal(up.calls.length, 0, 'what the platform did is not sent back to it');
    await pos.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('urbanpiper: cancelled on the platform, rejected by the store, cash and self-delivery orders', async () => {
  const up = fakeUrbanPiper();
  const h = await startHub(undefined, undefined, up.fetch);
  try {
    const { key, hook } = await setup(h);
    const pos = posStream(h.base, key);
    // Zomato cancels after the store accepted
    await hook('18', relay({ id: 11, channel: 'zomato' }));
    await pos.waitFor((e) => e.some((x) => x.type === 'order.created'));
    const z = pos.events.find((x) => x.type === 'order.created')!.order as any;
    assert.equal(z.number, 'Z-1001');
    await h.call('POST', `/v1/pos/orders/${z.id}/accept`, { key, idem: 'z1', body: { prepMinutes: 20, posBillNo: 'INV-1' } });
    await h.up.pump();
    assert.deepEqual(up.calls.at(-1)!.body, { new_status: 'Acknowledged', message: 'Accepted, ready in 20 min', extra: { prep_time_mins: 20 } }, 'Zomato gets the preparation time');
    await hook('60008', { order_id: 11, new_state: 'Cancelled', message: 'Customer changed their mind', from_aggregator: true });
    await pos.waitFor((e) => e.some((x) => x.type === 'order.cancelled'));
    const c = pos.events.find((x) => x.type === 'order.cancelled')!;
    assert.deepEqual([c.by, c.reasonText], ['aggregator', 'Customer changed their mind']);

    // the store rejects a Swiggy order that Swiggy lets it reject directly
    await hook('18', relay({ id: 12 }));
    await pos.waitFor((e) => e.filter((x) => x.type === 'order.created').length === 2);
    const s = pos.events.filter((x) => x.type === 'order.created')[1]!.order as any;
    up.calls.length = 0;
    await h.call('POST', `/v1/pos/orders/${s.id}/reject`, { key, idem: 'r1', body: { reason: 'TOO_BUSY' } });
    await h.up.pump();
    assert.deepEqual(up.calls[0]!.body, { new_status: 'Cancelled', reason_code: 'store_busy', message: 'Store too busy', extra: { swiggy_direct_cancellation: true } });

    // unanswered in time: rejected by the hub, Swiggy is told
    await hook('18', relay({ id: 13 }));
    h.clock.t += 6 * 60_000;
    h.hub.sweep();
    up.calls.length = 0;
    await h.up.pump();
    assert.equal(up.calls[0]!.body.new_status, 'Cancelled');
    assert.equal(up.calls[0]!.path, '/external/api/v1/orders/13/status/');

    // cash, the store's own rider: the store delivers and completes it
    await hook('18', relay({ id: 14, delivery: 'self', cash: 271 }));
    await pos.waitFor((e) => e.filter((x) => x.type === 'order.created').length === 4);
    const self = pos.events.filter((x) => x.type === 'order.created')[3]!.order as any;
    assert.equal(self.payment, 'COD');
    assert.equal(self.external.deliveredBy, 'store');
    assert.ok(self.external.notes.some((n: string) => /Collect Rs 271.00 in cash/.test(n)));
    await h.call('POST', `/v1/pos/orders/${self.id}/accept`, { key, idem: 'x1', body: { prepMinutes: 10, posBillNo: 'INV-9' } });
    await h.call('POST', `/v1/pos/orders/${self.id}/state`, { key, idem: 'x2', body: { to: 'READY' } });
    assert.equal((await h.call('POST', `/v1/pos/orders/${self.id}/state`, { key, idem: 'x3', body: { to: 'OUT_FOR_DELIVERY', rider: { name: 'Mohan', phone: '9111111111' } } })).status, 200);
    await h.call('POST', `/v1/pos/orders/${self.id}/state`, { key, idem: 'x4', body: { to: 'DELIVERED' } });
    up.calls.length = 0;
    await h.up.pump();
    assert.deepEqual(up.calls.map((x) => x.body.new_status), ['Acknowledged', 'Food Ready', 'Dispatched', 'Completed']);
    assert.deepEqual(up.calls[2]!.body.extra, { rider_name: 'Mohan', rider_phone: '9111111111' });

    // an item that is not on the POS menu: the platform's prices, and a note for the store
    await hook('18', relay({ id: 15, items: [{ id: 9, title: 'Mystery Shake', merchant_id: 'shake', price: 99, quantity: 1, options_to_add: [] }] }));
    await pos.waitFor((e) => e.filter((x) => x.type === 'order.created').length === 5);
    const odd = pos.events.filter((x) => x.type === 'order.created')[4]!.order as any;
    assert.deepEqual(odd.lines.map((l: any) => [l.itemId, l.name, l.lineTotal]), [['shake', 'Mystery Shake', 9900]]);
    assert.match(odd.external.notes.join(' '), /Check the items before accepting/);
    await pos.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('urbanpiper: POS changes follow by themselves (sold out, menu changes, store paused); calls are retried when UrbanPiper is busy', async () => {
  const up = fakeUrbanPiper();
  const h = await startHub(undefined, undefined, up.fetch);
  try {
    const { key } = await setup(h);
    // nothing automatic until the menu was sent once by hand
    await h.call('PUT', '/v1/pos/menu', { key, body: ONLINE_MENU({ version: 2 }) });
    await h.up.pump();
    assert.equal(up.calls.filter((c) => c.path !== '/hub/api/v1/location/').length, 0);
    await h.call('POST', '/v1/admin/stores/demo-burger/urbanpiper/menu', { admin: true });
    up.calls.length = 0;
    // cola sold out in the POS: switched off on the platforms; nothing else changed, so no new menu
    const cola = ONLINE_MENU().items.map((i) => (i.id === 'cola' ? { ...i, available: false } : i));
    await h.call('PUT', '/v1/pos/menu', { key, body: ONLINE_MENU({ version: 3, items: cola }) });
    await h.up.pump();
    assert.deepEqual(up.calls.map((c) => [c.path, c.body.action, c.body.item_ref_ids]), [['/hub/api/v1/items/', 'disable', ['cola']]]);
    // a price change: the whole menu again (a few seconds later)
    up.calls.length = 0;
    await h.call('PUT', '/v1/pos/menu', { key, body: ONLINE_MENU({ version: 4, items: cola.map((i) => (i.id === 'burger' ? { ...i, price: 13900 } : i)) }) });
    h.clock.t += 6000;
    await h.up.pump();
    assert.equal(up.calls.length, 1);
    assert.equal(up.calls[0]!.body.items.find((i: { ref_id: string }) => i.ref_id === 'burger').price, 132.38);
    // the POS stops taking orders: the store goes off on both platforms; UrbanPiper is busy at first
    up.calls.length = 0;
    up.state.down = 1;
    await h.call('PUT', '/v1/pos/status', { key, body: { accepting: false, reason: 'Kitchen closed' } });
    await h.up.pump();
    assert.equal(up.calls.length, 1, 'tried once, UrbanPiper busy');
    await h.up.pump();
    assert.equal(up.calls.length, 1, 'not again straight away');
    h.clock.t += 16_000;
    await h.up.pump();
    assert.equal(up.calls.length, 2);
    assert.deepEqual(up.calls[1]!.body, { location_ref_id: 'DINE-KN-1', platforms: ['swiggy', 'zomato'], action: 'disable', reason: 'Kitchen closed' });
    const view = (await h.call('GET', '/v1/admin/stores/demo-burger/urbanpiper', { admin: true })).json;
    assert.equal(view.pending, 0);
    assert.ok(view.log.some((l: { kind: string; ok: boolean }) => /Store off: Kitchen closed/.test(l.kind) && l.ok));
    // callbacks from UrbanPiper land in the activity list
    const token = one<{ webhook_token: string }>(h.hub.db, 'SELECT webhook_token FROM up_account')!.webhook_token;
    await h.call('POST', '/v1/urbanpiper/324255', { headers: { [TOKEN_HEADER]: token, 'x-upr-event-type': '60014' }, body: { reference: 'ref-store-1', stats: { created: 0, updated: 0, errors: 1 }, stores: [{ ref_id: 'DINE-KN-1', upipr_status: { action: 'U', error: true, err_msg: 'City is not serviceable' } }] } });
    const after = (await h.call('GET', '/v1/admin/stores/demo-burger/urbanpiper', { admin: true })).json;
    assert.match(after.log[0].text, /City is not serviceable/);
    assert.equal(after.log[0].ok, false);
  } finally { await h.close(); cleanup(h.dir); }
});

test('urbanpiper: packaging charge per item or as a percentage goes out as an item-level charge; cess stays inside the price; one GST rate uses the plain codes', async () => {
  const one5 = ONLINE_MENU({ items: [
    { id: 'cola', categoryId: 'c1', name: 'Cola 300 ml', price: 4000, unit: 'pcs', isVeg: true, rateBp: 500, cessBp: 1200, priceIncludesTax: true, modifierGroupIds: [], available: true, description: 'Chilled' },
    { id: 'tea', categoryId: 'c1', name: 'Masala Tea', price: 2000, unit: 'pcs', isVeg: true, rateBp: 500, cessBp: 0, priceIncludesTax: false, modifierGroupIds: [], available: true, description: 'Hot' },
  ] });
  const fixed = buildMenu(one5, ['swiggy', 'zomato'], { mode: 'per_item', value: 750 }, () => null);
  assert.deepEqual((fixed.body as any).charges, [{ code: 'PC_F', title: 'Packaging Charge', active: true, structure: { applicable_on: 'item.quantity', value: 7.5 }, fulfillment_modes: ['delivery', 'pickup'], item_ref_ids: ['cola', 'tea'] }]);
  const pct = buildMenu(one5, ['swiggy'], { mode: 'percent', value: 500 }, () => null);
  assert.deepEqual((pct.body as any).charges[0].structure, { applicable_on: 'item.price', value: 5 });
  assert.equal((pct.body as any).charges[0].code, 'PC_P');
  // Rs 40 including 5% GST and 12% cess: 40 x 1.12 / 1.17 = 38.29 sent; the platform adds 5% GST (cess stays inside)
  assert.equal(fixed.body.items.find((i) => i.ref_id === 'cola')!.price, 38.29);
  assert.equal(fixed.body.items.find((i) => i.ref_id === 'tea')!.price, 20, 'a GST-exclusive price is sent as it is');
  assert.deepEqual(fixed.body.taxes.map((x) => x.code), ['CGST_P', 'SGST_P'], 'one rate: the plain UrbanPiper codes');
  assert.ok(fixed.warnings.some((w) => /GST on the packaging charge is set by UrbanPiper/.test(w)));
  assert.ok(!('charges' in buildMenu(one5, ['swiggy'], NO_PACKAGING, () => null).body));

  // saved in the card, as typed
  const up = fakeUrbanPiper();
  const h = await startHub(undefined, undefined, up.fetch);
  try {
    await setup(h);
    const bad = await h.call('PUT', '/v1/admin/stores/demo-burger/urbanpiper', { admin: true, body: { ...DETAILS, packMode: 'percent', packValue: '80' } });
    assert.ok(bad.json.error.details.fields.packValue);
    const v = (await h.call('PUT', '/v1/admin/stores/demo-burger/urbanpiper', { admin: true, body: { ...DETAILS, packMode: 'per_item', packValue: '7.50' } })).json;
    assert.deepEqual([v.packMode, v.packValue], ['per_item', '7.5']);
    await h.call('POST', '/v1/admin/stores/demo-burger/urbanpiper/menu', { admin: true });
    assert.equal(up.calls.at(-1)!.body.charges[0].structure.value, 7.5);
  } finally { await h.close(); cleanup(h.dir); }
});

test("urbanpiper: the store tells Swiggy which items ran out, asks Zomato for the customer's number, another rider and a rider check; answers show on the order", async () => {
  const up = fakeUrbanPiper();
  const h = await startHub(undefined, undefined, up.fetch);
  try {
    const { key, hook } = await setup(h);
    const pos = posStream(h.base, key);
    await hook('18', relay({ id: 21, items: [
      { id: 1, title: 'Cheese Burger', merchant_id: 'burger', price: 122.86, quantity: 1, options_to_add: [] },
      { id: 2, title: 'Cola', merchant_id: 'cola', price: 38.1, quantity: 1, options_to_add: [] },
    ] }));
    await pos.waitFor((e) => e.some((x) => x.type === 'order.created'));
    const sw = pos.events.find((x) => x.type === 'order.created')!.order as any;
    const act = (id: string, body: unknown, idem: string) => h.call('POST', `/v1/pos/orders/${id}/platform-action`, { key, idem, body });
    assert.equal((await act(sw.id, { action: 'items_out_of_stock', itemIds: ['nope'], allowEdit: true }, 'a0')).status, 400, 'items must be on the order');
    assert.equal((await act(sw.id, { action: 'customer_phone' }, 'a1')).status, 409, 'a Zomato request on a Swiggy order');
    const r = await act(sw.id, { action: 'items_out_of_stock', itemIds: ['cola'], allowEdit: true }, 'a2');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual((await act(sw.id, { action: 'items_out_of_stock', itemIds: ['cola'], allowEdit: true }, 'a2')).json, r.json, 'the same request twice is sent once');
    up.calls.length = 0;
    await h.up.pump();
    assert.deepEqual(up.calls.map((c) => [c.path, c.body]), [['/hub/api/v1/orders/items-oos/', { order_upipr_id: 21, order_ref_id: 'SW-998877', allow_edit: true, items_oos: [{ ref_id: 'cola' }] }]]);
    // Swiggy's answer: the customer's masked number and a PIN
    await hook('60018', { success: true, reference_id: 'x', platform: 'swiggy', upipr_order_id: 21, ref_order_id: 'SW-998877', item_ids: [2], data: { message: 'Request for edit submitted. Please call customer.', customer_masked_number: '08046801234', pin: '7853' } });
    await pos.waitFor((e) => e.some((x) => x.type === 'order.notice'));
    assert.equal(pos.events.find((x) => x.type === 'order.notice')!.text, 'Request for edit submitted. Please call customer. Customer: 08046801234 PIN: 7853');
    // once ready, too late for Swiggy
    await h.call('POST', `/v1/pos/orders/${sw.id}/accept`, { key, idem: 'acc', body: { prepMinutes: 10, posBillNo: 'INV-1' } });
    await h.call('POST', `/v1/pos/orders/${sw.id}/state`, { key, idem: 'rdy', body: { to: 'READY' } });
    assert.equal((await act(sw.id, { action: 'items_out_of_stock', itemIds: ['cola'], allowEdit: false }, 'a3')).status, 409);

    // Zomato: a bulk order, and one the store delivers itself
    const bulk = relay({ id: 22, channel: 'zomato' });
    (bulk.order.details.ext_platforms[0]!.extras as any).is_bulk_order = true;
    await hook('18', bulk);
    await hook('18', relay({ id: 23, channel: 'zomato', delivery: 'self' }));
    await pos.waitFor((e) => e.filter((x) => x.type === 'order.created').length === 3);
    const [, zb, zs] = pos.events.filter((x) => x.type === 'order.created').map((x) => x.order as any);
    assert.equal(zb.external.bulk, true);
    assert.equal((await act(zs.id, { action: 'extra_rider' }, 'z0')).status, 409, 'an extra rider only for bulk orders');
    assert.equal((await act(zb.id, { action: 'extra_rider' }, 'z1')).status, 200);
    assert.equal((await act(zb.id, { action: 'customer_phone' }, 'z2')).status, 200);
    assert.equal((await act(zs.id, { action: 'rider_check', temperatureF: 98.6, wearingMask: true }, 'z3')).status, 400, "the store's own rider: phone needed");
    assert.equal((await act(zs.id, { action: 'rider_check', temperatureF: 98.6, wearingMask: true, riderPhone: '9111111111' }, 'z4')).status, 200);
    up.calls.length = 0;
    await h.up.pump();
    const zomatoCalls = up.calls.filter((c) => c.path === '/external/api/v1/aggregator/zomato/feature-action/');
    assert.deepEqual(zomatoCalls.map((c) => c.body), [
      { order_id: '22', action: 'request_additional_rider' },
      { order_id: '22', action: 'fetch_customer_data' },
      { order_id: '23', action: 'rider_body_temp', temp: 98.6, phone: '9111111111' },
      { order_id: '23', action: 'rider_with_mask', wearing_mask: true },
    ]);
    await hook('60017', { reference: 'r', order_id: 22, customer_phone: '09999999999', platform: 'zomato', action: 'fetch_customer_data', platform_order_id: 1180383 });
    await pos.waitFor((e) => e.some((x) => x.type === 'order.notice' && String(x.text) === "Customer's number (from Zomato): 09999999999"));

    // UrbanPiper refuses: the store sees why on the order
    await act(zb.id, { action: 'customer_phone' }, 'z5');
    up.state.refuseFeature = true;
    await h.up.pump();
    await pos.waitFor((e) => e.some((x) => x.type === 'order.notice' && String(x.text).includes("customer's number asked for: UrbanPiper refused (400): not enabled for this outlet")));
    await pos.close();
  } finally { await h.close(); cleanup(h.dir); }
});
