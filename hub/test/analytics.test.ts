import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

// Sales analytics for the portal (src/analytics.ts): an account sees its own outlets only, by brand, outlet and
// terminal; old POS builds (bill totals only) still count; everything can be rebuilt from the stored sync events.

const STREAM = '0123456789abcdef0123456789abcdef';
const OWNER = { businessName: 'Spice Garden', name: 'Asha Rao', email: 'asha@spicegarden.in', phone: '98765 43210', password: 'tandoor-2026' };

async function portal(h: TestHub, who = OWNER) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(h.base + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const v = /^dp_account=([^;]*)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
    if (v) cookie = `dp_account=${v}`;
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  const s = await call('POST', '/v1/account/signup', who);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  await call('POST', '/v1/account/verify', { email: s.json.email, code: /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1]! });
  return call;
}

/** A store on the admin page, paired with a POS and linked to the owner's account. */
async function outlet(h: TestHub, slug: string, name: string, email = OWNER.email) {
  const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug, name } })).json;
  const key = (await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'POS' } })).json.deviceKey as string;
  const link = await h.call('PUT', `/v1/admin/stores/${slug}/account`, { admin: true, body: { email } });
  assert.equal(link.status, 200, JSON.stringify(link.json));
  return key;
}

let seq = new Map<string, number>();
const send = async (h: TestHub, key: string, events: Array<[kind: string, payload: unknown, at: string]>) => {
  const from = (seq.get(key) ?? 0) + 1;
  seq.set(key, from + events.length - 1);
  const r = await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: STREAM, fromSeq: from, events: events.map(([kind, payload, createdAt], i) => ({ seq: from + i, kind, payload, createdAt })) } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
};
// 2026-10-15 is a Thursday; 07:30Z = 13:00 India, 15:00Z = 20:30 India
const D = '2026-10-15', LUNCH = `${D}T07:30:00.000Z`, DINNER = `${D}T15:00:00.000Z`;
const bill = (id: string, total: number, extra: object = {}) => ({ billId: id, billNo: id, totalPaise: total, businessDate: D, ...extra });
const paid = (id: string, total: number, mode = 'upi', given = total) => ({ billId: id, totalPaise: total, tenders: [{ mode, amountPaise: given }], changePaise: given - total, businessDate: D });

test('analytics: totals, days, hours, items, order types, payments, outlets and terminals for the account', async () => {
  const h = await startHub(); seq = new Map();
  try {
    const call = await portal(h);
    const a = await outlet(h, 'spice-indiranagar', 'Spice Garden Indiranagar'), b = await outlet(h, 'spice-koramangala', 'Spice Garden Koramangala');
    await send(h, a, [
      ['bill.printed', bill('a1', 50000, { orderType: 'dine_in', channel: 'pos', terminal: 'Counter 1', covers: 2, taxPaise: 2400, discountPaise: 1000, lines: [{ name: 'Butter Chicken', category: 'Mains', qty: 2, amountPaise: 40000 }, { name: 'Naan', category: 'Breads', qty: 4, amountPaise: 10000 }] }), LUNCH],
      ['bill.settled', paid('a1', 50000, 'cash', 60000), LUNCH],
      ['bill.printed', bill('a2', 30000, { orderType: 'delivery', channel: 'swiggy', terminal: 'Counter 2', lines: [{ name: 'Butter Chicken', category: 'Mains', qty: 1, amountPaise: 20000 }] }), DINNER],
      ['bill.settled', paid('a2', 30000), DINNER],
      ['bill.printed', bill('a3', 9900, { orderType: 'takeaway', terminal: 'Counter 1' }), DINNER],
      ['bill.voided', { billId: 'a3', totalPaise: 9900, reason: 'Wrong order', businessDate: D }, DINNER],
    ]);
    await send(h, b, [['bill.printed', bill('b1', 20000), LUNCH], ['bill.settled', paid('b1', 20000, 'card'), LUNCH]]); // an older POS build: totals only

    const r = await call('GET', `/v1/account/analytics?from=${D}&to=2026-10-16`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const x = r.json;
    assert.deepEqual(x.totals, { orders: 3, sales: 100000, tax: 2400, discount: 1000, covers: 2, voids: 1, voidAmount: 9900, refunds: 0, refundAmount: 0, avgTicket: 33333 });
    assert.deepEqual(x.daily, [{ date: D, sales: 100000, orders: 3 }, { date: '2026-10-16', sales: 0, orders: 0 }]);
    assert.deepEqual(x.hours.sort((p: any, q: any) => p.hour - q.hour), [{ dow: 4, hour: 13, orders: 2, sales: 70000 }, { dow: 4, hour: 20, orders: 1, sales: 30000 }]);
    assert.deepEqual(x.topItems, [{ name: 'Naan', category: 'Breads', qtyMilli: 4000, amount: 10000 }, { name: 'Butter Chicken', category: 'Mains', qtyMilli: 3000, amount: 60000 }]);
    assert.deepEqual(x.orderTypes, [{ type: 'dine_in', orders: 1, sales: 50000 }, { type: 'delivery', orders: 1, sales: 30000 }, { type: '', orders: 1, sales: 20000 }]);
    assert.deepEqual(x.payments, [{ mode: 'cash', amount: 50000 }, { mode: 'upi', amount: 30000 }, { mode: 'card', amount: 20000 }], 'cash is what was kept, not what was handed over');
    assert.deepEqual(x.outlets.map((o: any) => [o.slug, o.sales, o.orders]), [['spice-indiranagar', 80000, 2], ['spice-koramangala', 20000, 1]]);
    assert.deepEqual(x.terminals.map((t: any) => [t.store, t.name, t.sales]), [['spice-indiranagar', 'Counter 1', 50000], ['spice-indiranagar', 'Counter 2', 30000]]);
    assert.deepEqual(x.recorded, { items: true, orderTypes: true, terminals: true });
    assert.equal(x.previousTotals.sales, 0);

    // one outlet, then one terminal of it
    const one = (await call('GET', `/v1/account/analytics?from=${D}&to=${D}&store=spice-indiranagar&terminal=Counter%202`)).json;
    assert.deepEqual([one.totals.sales, one.totals.orders, one.topItems.length, one.payments], [30000, 1, 1, [{ mode: 'upi', amount: 30000 }]]);
    assert.deepEqual(one.filters.terminals, [{ store: 'spice-indiranagar', name: 'Counter 1' }, { store: 'spice-indiranagar', name: 'Counter 2' }]);

    // a bill printed again with a new total, then refunded in part: the day is added up again (after the 30 s the answer is kept)
    await send(h, a, [['bill.printed', bill('a2', 35000, { orderType: 'delivery', channel: 'swiggy', terminal: 'Counter 2' }), DINNER], ['bill.refunded', { billId: 'cn1', refundPaise: 5000, businessDate: D, terminal: 'Counter 2', tenders: [{ mode: 'upi', amountPaise: 5000 }] }, DINNER]]);
    assert.equal((await call('GET', `/v1/account/analytics?from=${D}&to=2026-10-16`)).json.totals.sales, 100000, 'kept for 30 seconds');
    h.clock.t += 31_000;
    const later = (await call('GET', `/v1/account/analytics?from=${D}&to=2026-10-16`)).json;
    assert.deepEqual([later.totals.sales, later.totals.orders, later.totals.refunds, later.totals.refundAmount], [100000, 3, 1, 5000]);
    assert.deepEqual(later.topItems[1], { name: 'Butter Chicken', category: 'Mains', qtyMilli: 3000, amount: 60000 }, 'a reprint without items keeps the items it had');

    // rebuilt from the stored sync events: the same answer
    h.hub.analytics.rebuildAll();
    const rebuilt = (await call('GET', `/v1/account/analytics?from=${D}&to=2026-10-16`)).json;
    assert.deepEqual({ ...rebuilt, generatedAt: 0 }, { ...later, generatedAt: 0 });
  } finally { await h.close(); cleanup(h.dir); }
});

test('analytics: brands; another account sees nothing of it; signed out, wrong dates and unknown outlets are refused', async () => {
  const h = await startHub(); seq = new Map();
  try {
    const call = await portal(h);
    const a = await outlet(h, 'spice-indiranagar', 'Spice Garden Indiranagar'), b = await outlet(h, 'wrap-house', 'Wrap House');
    await h.call('POST', '/v1/admin/brands', { admin: true, body: { slug: 'spice-garden', name: 'Spice Garden' } });
    await h.call('PUT', '/v1/admin/brands/spice-garden/stores/spice-indiranagar', { admin: true });
    await send(h, a, [['bill.printed', bill('a1', 50000), LUNCH]]);
    // a bill of 30000 printed, then split in two: part 1 keeps its id, part 2 is only ever settled
    await send(h, b, [['bill.printed', bill('b1', 30000), LUNCH], ['bill.settled', paid('b1', 12000), LUNCH], ['bill.settled', paid('b1-2', 8000), LUNCH]]);

    const all = (await call('GET', `/v1/account/analytics?from=${D}&to=${D}`)).json;
    assert.deepEqual([all.totals.sales, all.filters.brands, all.filters.stores.map((s: any) => [s.slug, s.brand])], [70000, [{ slug: 'spice-garden', name: 'Spice Garden' }], [['spice-indiranagar', 'spice-garden'], ['wrap-house', null]]]);
    const brand = (await call('GET', `/v1/account/analytics?from=${D}&to=${D}&brand=spice-garden`)).json;
    assert.deepEqual([brand.totals.sales, brand.outlets.length], [50000, 1]);
    assert.deepEqual(brand.recorded, { items: false, orderTypes: false, terminals: false });

    const other = await portal(h, { ...OWNER, businessName: 'Other Cafe', email: 'other@cafe.in', phone: '91234 56780' });
    const theirs = (await other('GET', `/v1/account/analytics?from=${D}&to=${D}`)).json;
    assert.deepEqual([theirs.totals.sales, theirs.filters.stores, theirs.outlets], [0, [], []]);
    assert.equal((await other('GET', '/v1/account/analytics?store=spice-indiranagar')).status, 404);

    assert.equal((await h.call('GET', '/v1/account/analytics')).status, 401);
    assert.equal((await call('GET', '/v1/account/analytics?from=2026-10-20&to=2026-10-01')).status, 400);
    assert.equal((await call('GET', '/v1/account/analytics?from=2024-01-01&to=2026-10-01')).status, 400);
    assert.equal((await call('GET', '/v1/account/analytics?brand=nope')).status, 404);
    assert.equal((await call('GET', '/v1/account/analytics')).json.range.days, 30, 'the last 30 days by default');
    assert.equal((await h.call('PUT', '/v1/admin/stores/wrap-house/account', { admin: true, body: { email: 'nobody@x.in' } })).status, 404);
  } finally { await h.close(); cleanup(h.dir); }
});
