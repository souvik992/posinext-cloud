import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

// Purchases and stock for the portal (src/inventory.ts): purchases come in the sync stream, the stock list is put whole.

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
  await call('POST', '/v1/account/verify', { email: s.json.email, code: /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1]! });
  return call;
}
async function outlet(h: TestHub, slug: string, name: string) {
  const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug, name } })).json;
  const key = (await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'POS' } })).json.deviceKey as string;
  await h.call('PUT', `/v1/admin/stores/${slug}/account`, { admin: true, body: { email: OWNER.email } });
  return key;
}
const D = '2026-10-15', AT = `${D}T07:30:00.000Z`;
const batch = (from: number, events: Array<[string, unknown]>) => ({ streamId: STREAM, fromSeq: from, events: events.map(([kind, payload], i) => ({ seq: from + i, kind, payload, createdAt: AT })) });

test('inventory: stock now (value, low items), purchases by supplier and material, and food cost against sales', async () => {
  const h = await startHub();
  try {
    const call = await portal(h);
    const a = await outlet(h, 'spice-indiranagar', 'Spice Garden Indiranagar'), b = await outlet(h, 'spice-koramangala', 'Spice Garden Koramangala');
    const sent = await h.call('POST', '/v1/pos/sync/batches', { key: a, body: batch(1, [
      ['purchase.recorded', { purchaseId: 'p1', supplier: 'Fresh Farms', billNo: 'FF-101', businessDate: D, totalPaise: 90000, lines: [{ name: 'Paneer', unit: 'kg', qtyMilli: 2000, amountPaise: 70000 }, { name: 'Onion', unit: 'kg', qtyMilli: 10000, amountPaise: 20000 }] }],
      ['purchase.recorded', { purchaseId: 'p2', supplier: 'fresh farms', businessDate: D, totalPaise: 35000, lines: [{ name: 'Paneer', unit: 'kg', qtyMilli: 1000, amountPaise: 35000 }] }],
      ['purchase.recorded', { purchaseId: 'p3', supplier: 'Metro Cash', businessDate: D, totalPaise: 50000, lines: [{ name: 'Oil', unit: 'l', qtyMilli: 5000, amountPaise: 50000 }] }],
      ['purchase.voided', { purchaseId: 'p3' }],
      ['bill.printed', { billId: 'b1', totalPaise: 100000, businessDate: D }],
    ]) });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    const put = (key: string, body: unknown) => h.call('PUT', '/v1/pos/inventory', { key, body });
    const at = Date.parse(AT);
    assert.deepEqual((await put(a, { at, items: [
      { id: 's1', name: 'Paneer', unit: 'kg', onHandMilli: 1500, reorderMilli: 2000, unitCostPaise: 35000 },
      { id: 's2', name: 'Onion', unit: 'kg', onHandMilli: 8000, reorderMilli: 3000, unitCostPaise: 2000 },
      { id: 's3', name: 'Oil', unit: 'l', onHandMilli: -500, reorderMilli: 0, unitCostPaise: 10000 },
    ], usage: [{ date: D, usedPaise: 30000, wastePaise: 2000 }] })).json, { ok: true, items: 3, kept: true });
    await put(b, { at, items: [{ id: 'x1', name: 'Rice', unit: 'kg', onHandMilli: 20000, reorderMilli: 5000, unitCostPaise: 6000 }], usage: [] });

    const r = await call('GET', `/v1/account/inventory?from=${D}&to=${D}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const x = r.json;
    assert.deepEqual([x.stock.value, x.stock.items, x.stock.low, x.stock.out, x.stock.list], [52500 + 16000 + 120000, 4, 1, 1, null]);
    assert.deepEqual(x.stock.lowItems.map((i: any) => [i.store, i.name, i.onHandMilli, i.reorderMilli]), [['spice-indiranagar', 'Paneer', 1500, 2000]]);
    assert.deepEqual(x.stock.outlets.map((o: any) => [o.slug, o.items, o.low, o.value, o.updatedAt]), [['spice-koramangala', 1, 0, 120000, at], ['spice-indiranagar', 3, 1, 68500, at]]);
    assert.deepEqual([x.purchases.total, x.purchases.count, x.purchases.previousTotal], [125000, 2, 0], 'the voided purchase is left out');
    assert.deepEqual(x.purchases.suppliers, [{ supplier: 'Fresh Farms', total: 125000, count: 2 }], 'one supplier however its name was typed');
    assert.deepEqual(x.purchases.materials, [{ name: 'Paneer', unit: 'kg', qtyMilli: 3000, amount: 105000 }, { name: 'Onion', unit: 'kg', qtyMilli: 10000, amount: 20000 }]);
    assert.deepEqual(x.purchases.daily, [{ date: D, total: 125000, count: 2 }]);
    assert.deepEqual(x.purchases.recent.map((p: any) => [p.supplier, p.billNo, p.total, p.lines]).sort(), [['Fresh Farms', 'FF-101', 90000, 2], ['fresh farms', null, 35000, 1]]);
    assert.deepEqual(x.cost, { used: 30000, waste: 2000, sales: 100000, recorded: true });

    // one outlet: its whole list; an older list arriving late changes nothing; a newer one replaces it
    const one = (await call('GET', `/v1/account/inventory?from=${D}&to=${D}&store=spice-indiranagar`)).json;
    assert.deepEqual(one.stock.list.map((i: any) => [i.name, i.value, i.low]), [['Oil', 0, false], ['Onion', 16000, false], ['Paneer', 52500, true]]);
    assert.equal((await put(a, { at: at - 1000, items: [] })).json.kept, false);
    assert.equal((await put(a, { at: at + 1000, items: [{ id: 's1', name: 'Paneer', unit: 'kg', onHandMilli: 9000, reorderMilli: 2000, unitCostPaise: 35000 }] })).json.kept, true);
    h.clock.t += 31_000;
    const later = (await call('GET', `/v1/account/inventory?from=${D}&to=${D}&store=spice-indiranagar`)).json;
    assert.deepEqual([later.stock.items, later.stock.low, later.stock.value], [1, 0, 315000]);

    // purchases can be built again from the stored sync events
    h.hub.inventory.rebuildPurchases();
    assert.equal((await call('GET', `/v1/account/inventory?from=${D}&to=${D}`)).json.purchases.total, 125000);
  } finally { await h.close(); cleanup(h.dir); }
});

test('inventory: only the account sees it; a POS key is needed to send stock; bad lists are refused', async () => {
  const h = await startHub();
  try {
    const call = await portal(h);
    const a = await outlet(h, 'spice-indiranagar', 'Spice Garden Indiranagar');
    assert.equal((await h.call('PUT', '/v1/pos/inventory', { body: { items: [] } })).status, 401);
    assert.equal((await h.call('PUT', '/v1/pos/inventory', { key: a, body: { items: 'all' } })).status, 400);
    assert.equal((await h.call('PUT', '/v1/pos/inventory', { key: a, body: { items: [{ id: 's1', name: 'A' }, { id: 's1', name: 'B' }] } })).status, 400);
    assert.equal((await h.call('GET', '/v1/account/inventory')).status, 401);
    assert.equal((await call('GET', '/v1/account/inventory?store=nope')).status, 404);
    const other = await portal(h, { ...OWNER, businessName: 'Other Cafe', email: 'other@cafe.in', phone: '91234 56780' });
    const theirs = (await other('GET', '/v1/account/inventory')).json;
    assert.deepEqual([theirs.stock.items, theirs.purchases.count, theirs.filters.stores, theirs.cost.recorded], [0, 0, [], false]);
  } finally { await h.close(); cleanup(h.dir); }
});
