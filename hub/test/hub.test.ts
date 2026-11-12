import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, FAR, menu, NEAR, posStream, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

/** A store with one paired POS that has published its menu and is taking orders. */
async function readyStore(h: TestHub, o: { menu?: ReturnType<typeof menu> } = {}) {
  const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'demo-burger', name: 'Demo Burger Hub' } })).json;
  const paired = (await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'Counter 1' } })).json;
  const key = paired.deviceKey as string;
  assert.equal((await h.call('PUT', '/v1/pos/menu', { key, body: o.menu ?? menu() })).status, 200);
  assert.equal((await h.call('PUT', '/v1/pos/status', { key, body: { accepting: true } })).status, 200);
  return { store, key };
}
async function codOrder(h: TestHub, o: { mobile?: string; lines?: unknown[]; fulfilment?: string; location?: unknown; expectedTotal?: number; idem?: string } = {}) {
  const mobile = o.mobile ?? '9876543210';
  const sent = (await h.call('POST', '/v1/otp/send', { body: { mobile } })).json;
  const { otpToken } = (await h.call('POST', '/v1/otp/verify', { body: { mobile, otp: sent.devCode } })).json;
  const lines = o.lines ?? [{ itemId: 'burger', qtyMilli: 2000 }];
  const fulfilment = o.fulfilment ?? 'PICKUP';
  const q = await h.call('POST', '/v1/stores/demo-burger/quote', { body: { fulfilment, location: o.location, lines } });
  return h.call('POST', '/v1/stores/demo-burger/orders', { idem: o.idem, body: { fulfilment, payment: 'COD', customer: { name: 'Asha', mobile }, otpToken, location: o.location ?? null,
    address: fulfilment === 'DELIVERY' ? { line1: '12, 4th Cross', city: 'Bengaluru', pincode: '560043' } : null, lines, menuVersion: 1, expectedTotal: o.expectedTotal ?? q.json?.total } });
}

test('hub: pairing, publishing and the store page say clearly when and why a store cannot take orders', async () => {
  const h = await startHub();
  try {
    assert.equal((await h.call('POST', '/v1/admin/stores', { body: { slug: 'x-store', name: 'X' } })).status, 403); // admin key needed
    const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'demo-burger', name: 'Demo Burger Hub' } })).json;
    assert.match(store.pairingCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const paired = await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode.toLowerCase(), deviceName: 'Counter 1' } });
    assert.equal(paired.status, 200);
    assert.equal((await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'Again' } })).json.error.code, 'BAD_PAIRING_CODE'); // one use only
    const key = paired.json.deviceKey as string;
    assert.equal((await h.call('PUT', '/v1/pos/menu', { body: menu() })).status, 401);
    const page = async () => (await h.call('GET', '/v1/stores/demo-burger')).json;
    assert.match((await page()).reason, /not taking online orders yet/);
    await h.call('PUT', '/v1/pos/menu', { key, body: menu() });
    assert.match((await page()).reason, /offline/); // no POS connected
    const s = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    assert.match((await page()).reason, /not taking orders/); // connected, but the POS has no shift open
    await h.call('PUT', '/v1/pos/status', { key, body: { accepting: true } });
    const open = await page();
    assert.equal(open.open, true);
    assert.deepEqual(open.menu.items.map((i: { name: string; rateBp?: number }) => [i.name, i.rateBp]), [['Cheese Burger', undefined], ['Cola', undefined]]); // tax internals not public
    assert.equal(open.payments.online, false); // online payment: phase 3
    await h.call('PUT', '/v1/pos/status', { key, body: { accepting: false, reason: 'Kitchen closed for cleaning' } });
    assert.match((await page()).reason, /Kitchen closed for cleaning/);
    await s.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub: a COD order needs an OTP, is priced by the hub, and reaches the POS the moment it is placed; actions are safe to repeat', async () => {
  const h = await startHub();
  try {
    const { key } = await readyStore(h);
    const pos = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    const noOtp = await h.call('POST', '/v1/stores/demo-burger/orders', { body: { fulfilment: 'PICKUP', payment: 'COD', customer: { mobile: '9876543210' }, lines: [{ itemId: 'burger', qtyMilli: 1000 }], menuVersion: 1, expectedTotal: 12900 } });
    assert.equal(noOtp.json.error.code, 'VALIDATION'); // COD needs an OTP token
    const changed = await codOrder(h, { expectedTotal: 100 });
    assert.deepEqual([changed.status, changed.json.error.code, changed.json.error.details.total], [409, 'PRICE_CHANGED', 25800]);
    const online = await h.call('POST', '/v1/stores/demo-burger/orders', { body: { fulfilment: 'PICKUP', payment: 'ONLINE', customer: { mobile: '9876543210' }, lines: [{ itemId: 'burger', qtyMilli: 1000 }], menuVersion: 1, expectedTotal: 12900 } });
    assert.equal(online.json.error.code, 'PAYMENT_NOT_AVAILABLE');

    const placed = await codOrder(h, { idem: 'place-1' });
    assert.equal(placed.status, 201);
    const again = await codOrder(h, { idem: 'place-1' });
    assert.equal(again.json.order.id, placed.json.order.id); // a retried place is the same order
    const order = placed.json.order;
    assert.deepEqual([order.number, order.state, order.total, order.customer.verified], ['W-1001', 'SENT_TO_STORE', 25800, true]);
    await pos.waitFor((e) => e.some((x) => x.type === 'order.created'));
    const created = pos.events.find((x) => x.type === 'order.created')!;
    assert.equal((created.order as { id: string }).id, order.id);

    const recv = await h.call('POST', `/v1/pos/orders/${order.id}/received`, { key, idem: 'r-1' });
    assert.equal(recv.json.state, 'RECEIVED');
    const acc = await h.call('POST', `/v1/pos/orders/${order.id}/accept`, { key, idem: 'a-1', body: { prepMinutes: 15, posBillNo: 'A1/26-27/000099' } });
    const accAgain = await h.call('POST', `/v1/pos/orders/${order.id}/accept`, { key, idem: 'a-1', body: { prepMinutes: 15, posBillNo: 'A1/26-27/000099' } });
    assert.deepEqual([acc.json.state, accAgain.json.state], ['ACCEPTED', 'ACCEPTED']); // F2: a retried accept is answered, not refused
    assert.equal((await h.call('POST', `/v1/pos/orders/${order.id}/accept`, { key, idem: 'a-2', body: { prepMinutes: 15, posBillNo: 'X' } })).json.error.code, 'BAD_TRANSITION');
    assert.equal((await h.call('POST', `/v1/pos/orders/${order.id}/state`, { key, idem: 's-1', body: { to: 'OUT_FOR_DELIVERY', rider: { name: 'Ravi' } } })).json.error.code, 'BAD_TRANSITION'); // pickup: no rider
    for (const [i, to] of ['PREPARING', 'READY', 'PICKED_UP'].entries()) assert.equal((await h.call('POST', `/v1/pos/orders/${order.id}/state`, { key, idem: `st-${i}`, body: { to } })).json.state, to);
    const seen = await h.call('GET', `/v1/orders/${order.id}`, { token: placed.json.accessToken });
    assert.deepEqual([seen.json.state, seen.json.posBillNo, seen.json.prepMinutes], ['PICKED_UP', 'A1/26-27/000099', 15]);
    assert.equal((await h.call('GET', `/v1/orders/${order.id}`, { token: 'wrong' })).status, 404);
    await pos.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub: delivery fees and minimum order come from the published serviceability; outside the area is refused', async () => {
  const h = await startHub();
  try {
    const { key } = await readyStore(h);
    const pos = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    const q = (await h.call('POST', '/v1/stores/demo-burger/quote', { body: { fulfilment: 'DELIVERY', location: NEAR, lines: [{ itemId: 'burger', qtyMilli: 1000 }] } })).json;
    assert.deepEqual([q.deliveryFee, q.packagingFee, q.total, q.distanceKm], [2000, 0, 14900, 1]);
    const small = await h.call('POST', '/v1/stores/demo-burger/quote', { body: { fulfilment: 'DELIVERY', location: NEAR, lines: [{ itemId: 'cola', qtyMilli: 1000 }] } });
    assert.deepEqual([small.json.error.code, small.json.error.details.shortBy], ['BELOW_MINIMUM', 6000]);
    const far = await h.call('POST', '/v1/stores/demo-burger/quote', { body: { fulfilment: 'DELIVERY', location: FAR, lines: [{ itemId: 'burger', qtyMilli: 1000 }] } });
    assert.equal(far.json.error.code, 'OUT_OF_AREA');
    const placed = await codOrder(h, { fulfilment: 'DELIVERY', location: NEAR, lines: [{ itemId: 'burger', qtyMilli: 1000 }] });
    assert.deepEqual([placed.json.order.deliveryFee, placed.json.order.total, placed.json.order.address.pincode], [2000, 14900, '560043']);
    await pos.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub: a POS that was disconnected (or a restarted hub) gets every missed event exactly once (F1, F13)', async () => {
  let h = await startHub();
  try {
    const { key } = await readyStore(h);
    const first = posStream(h.base, key);
    await new Promise((r) => setTimeout(r, 100));
    await codOrder(h, { mobile: '9000000001' });
    await first.waitFor((e) => e.length === 1);
    const lastSeen = first.events[0]!.seq;
    await first.close(); // the internet drops; the store stays "online" for 60 s
    await codOrder(h, { mobile: '9000000002' });
    await codOrder(h, { mobile: '9000000003' });
    h = await h.restart(); // and the hub restarts
    const back = posStream(h.base, key, lastSeen);
    await back.waitFor((e) => e.filter((x) => x.type === 'order.created').length === 2);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(back.events.map((e) => (e.order as { customer: { mobile: string } }).customer.mobile), ['9000000002', '9000000003']);
    assert.ok(back.events.every((e) => e.seq > lastSeen));
    await back.close();
  } finally { await h.close(); cleanup(h.dir); }
});

test('hub: unanswered orders are auto-rejected (F7); a store offline for 60 s takes no orders (F8); cancel vs accept (F11); two counters (F12)', async () => {
  const h = await startHub();
  try {
    const { store, key } = await readyStore(h);
    const second = (await h.call('POST', `/v1/admin/stores/${store.slug}/pairing-code`, { admin: true })).json.pairingCode;
    const key2 = (await h.call('POST', '/v1/pos/pair', { body: { code: second, deviceName: 'Counter 2' } })).json.deviceKey as string;
    const c1 = posStream(h.base, key), c2 = posStream(h.base, key2);
    await new Promise((r) => setTimeout(r, 100));

    // F7
    const late = (await codOrder(h, { mobile: '9000000011' })).json;
    h.clock.t += 5 * 60_000 + 1;
    assert.equal(h.hub.sweep(), 1);
    assert.equal((await h.call('GET', `/v1/orders/${late.order.id}`, { token: late.accessToken })).json.state, 'AUTO_REJECTED');
    await c1.waitFor((e) => e.some((x) => x.type === 'order.auto_rejected'));

    // F12: both counters see the order; the first accept wins
    const both = (await codOrder(h, { mobile: '9000000012' })).json.order;
    await c2.waitFor((e) => e.some((x) => x.type === 'order.created' && (x.order as { id: string }).id === both.id));
    const a1 = await h.call('POST', `/v1/pos/orders/${both.id}/accept`, { key, idem: 'c1-accept', body: { prepMinutes: 10, posBillNo: 'A1/1' } });
    const a2 = await h.call('POST', `/v1/pos/orders/${both.id}/accept`, { key: key2, idem: 'c2-accept', body: { prepMinutes: 10, posBillNo: 'A2/1' } });
    assert.deepEqual([a1.json.state, a2.json.error.code], ['ACCEPTED', 'BAD_TRANSITION']);
    await c2.waitFor((e) => e.some((x) => x.type === 'order.updated' && x.orderId === both.id && x.state === 'ACCEPTED'));

    // F11: the customer cancels first; the late accept is refused, so the POS knows to cancel its bill
    const cx = (await codOrder(h, { mobile: '9000000013' })).json;
    assert.equal((await h.call('POST', `/v1/orders/${cx.order.id}/cancel`, { token: cx.accessToken, body: {} })).json.state, 'CANCELLED');
    await c1.waitFor((e) => e.some((x) => x.type === 'order.cancelled'));
    assert.equal((await h.call('POST', `/v1/pos/orders/${cx.order.id}/accept`, { key, idem: 'late', body: { prepMinutes: 5, posBillNo: 'B' } })).json.error.code, 'BAD_TRANSITION');
    const ok = (await codOrder(h, { mobile: '9000000014' })).json.order;
    await h.call('POST', `/v1/pos/orders/${ok.id}/accept`, { key, idem: 'ok-accept', body: { prepMinutes: 5, posBillNo: 'C' } });
    assert.equal((await h.call('POST', `/v1/orders/${ok.id}/cancel`, { token: 'x', body: {} })).status, 404);

    // F8
    await c1.close(); await c2.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await h.call('GET', '/v1/stores/demo-burger')).json.open, true); // a short drop is fine
    h.clock.t += 61_000;
    const page = (await h.call('GET', '/v1/stores/demo-burger')).json;
    assert.deepEqual([page.open, /offline/.test(page.reason)], [false, true]);
    assert.equal((await codOrder(h, { mobile: '9000000015' })).json.error.code, 'STORE_CLOSED');
  } finally { await h.close(); cleanup(h.dir); }
});
