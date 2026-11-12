import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

const STREAM = '0123456789abcdef0123456789abcdef';

async function paired(h: TestHub, slug = 'spice-garden') {
  const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug, name: 'Spice Garden' } })).json;
  const key = (await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'DinePOS master' } })).json.deviceKey as string;
  return key;
}

const ev = (seq: number, kind: string, payload: unknown) => ({ seq, kind, payload, createdAt: '2026-11-03T08:00:00.000Z' });
const day = '2026-11-03';
const sale = (from: number) => [
  ev(from, 'bill.printed', { billId: 'b1', orderId: 'o1', billNo: 'SG/26-27/000001', totalPaise: 52500, businessDate: day }),
  ev(from + 1, 'bill.settled', { billId: 'b1', orderId: 'o1', totalPaise: 52500, tenders: [{ mode: 'cash', amountPaise: 52500 }], changePaise: 0, businessDate: day }),
  ev(from + 2, 'bill.printed', { billId: 'b2', orderId: 'o2', billNo: 'SG/26-27/000002', totalPaise: 30000, businessDate: day }),
  ev(from + 3, 'bill.voided', { billId: 'b2', orderId: 'o2', billNo: 'SG/26-27/000002', totalPaise: 30000, reason: 'Wrong table', businessDate: day }),
];

test('sync: a batch is stored and acked; sending it again stores nothing twice; the next batch carries on', async () => {
  const h = await startHub();
  try {
    const key = await paired(h);
    const first = await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: STREAM, fromSeq: 1, events: sale(1) } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { ackSeq: 4, stored: 4 });
    const again = await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: STREAM, fromSeq: 1, events: sale(1) } });
    assert.deepEqual(again.json, { ackSeq: 4, stored: 0 });
    const next = await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: STREAM, fromSeq: 4, events: [sale(1)[3], ev(5, 'bill.printed', { billId: 'b3', totalPaise: 100, businessDate: day })] } });
    assert.deepEqual(next.json, { ackSeq: 5, stored: 1 });
    assert.equal(h.hub.db.prepare('SELECT count(*) AS n FROM sync_event').get()!.n, 5);
  } finally { await h.close(); cleanup(h.dir); }
});

test('sync: needs a paired POS; a gap or a different record under a number already held is refused with what the hub holds', async () => {
  const h = await startHub();
  try {
    assert.equal((await h.call('POST', '/v1/pos/sync/batches', { body: { streamId: STREAM, fromSeq: 1, events: sale(1) } })).status, 401);
    const key = await paired(h);
    await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: STREAM, fromSeq: 1, events: sale(1) } });
    const gap = await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: STREAM, fromSeq: 9, events: [ev(9, 'bill.printed', { billId: 'x' })] } });
    assert.equal(gap.status, 409);
    assert.deepEqual([gap.json.error.code, gap.json.error.details.ackSeq], ['SYNC_GAP', 4]);
    const changed = await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: STREAM, fromSeq: 2, events: [ev(2, 'bill.settled', { billId: 'b1', tenders: [{ mode: 'upi', amountPaise: 52500 }] })] } });
    assert.equal(changed.status, 409);
    assert.equal(changed.json.error.code, 'SYNC_CONFLICT');
    // a new stream (the outlet's database was restored or reinstalled) starts wherever its outbox is
    const fresh = await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: 'fedcba9876543210fedcba9876543210', fromSeq: 3, events: [ev(3, 'bill.printed', { billId: 'b9', totalPaise: 100, businessDate: day })] } });
    assert.deepEqual(fresh.json, { ackSeq: 3, stored: 1 });
  } finally { await h.close(); cleanup(h.dir); }
});

test('sync: badly formed batches are refused', async () => {
  const h = await startHub();
  try {
    const key = await paired(h);
    const send = (body: unknown) => h.call('POST', '/v1/pos/sync/batches', { key, body });
    assert.equal((await send({ streamId: 'short', fromSeq: 1, events: sale(1) })).status, 400);
    assert.equal((await send({ streamId: STREAM, fromSeq: 1, events: [] })).status, 400);
    assert.equal((await send({ streamId: STREAM, fromSeq: 1, events: [ev(1, 'a', {}), ev(3, 'a', {})] })).status, 400);
    assert.equal((await send({ streamId: STREAM, fromSeq: 2, events: [ev(1, 'a', {})] })).status, 400);
    assert.equal((await send({ streamId: STREAM, fromSeq: 1, events: [ev(1, 'Bad Kind!', {})] })).status, 400);
    assert.equal(h.hub.db.prepare('SELECT count(*) AS n FROM sync_event').get()!.n, 0);
  } finally { await h.close(); cleanup(h.dir); }
});

test('sync: the admin sales view adds up an open day from its bills and shows a closed day from its Z report', async () => {
  const h = await startHub();
  try {
    const key = await paired(h);
    await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: STREAM, fromSeq: 1, events: sale(1) } });
    let v = (await h.call('GET', '/v1/admin/stores/spice-garden/sales', { admin: true })).json;
    assert.equal(v.days.length, 1);
    assert.deepEqual(v.days[0], { businessDate: day, closed: false, closedAt: null, bills: 1, covers: null, netSalesPaise: 52500, taxPaise: null, discountPaise: null, byMode: [{ mode: 'cash', amountPaise: 52500 }], voids: 1, voidPaise: 30000, cashDifferencePaise: null });
    assert.equal(v.events, 4);
    assert.equal(typeof v.lastSyncAt, 'number');
    const z = { bills: 1, covers: 4, netSalesPaise: 50000, grossSalesPaise: 50000, discountPaise: 0, cgstPaise: 1250, sgstPaise: 1250, igstPaise: 0, byMode: [{ mode: 'cash', amountPaise: 52500 }], cashExpectedPaise: 52500, cashCountedPaise: 52000, closedAt: '03-11-26 23:40', voids: [{ billNo: 'SG/26-27/000002', amountPaise: 30000, reason: 'Wrong table' }] };
    await h.call('POST', '/v1/pos/sync/batches', { key, body: { streamId: STREAM, fromSeq: 5, events: [ev(5, 'day.closed', { businessDate: day, zReport: z })] } });
    v = (await h.call('GET', '/v1/admin/stores/spice-garden/sales', { admin: true })).json;
    assert.deepEqual(v.days[0], { businessDate: day, closed: true, closedAt: '03-11-26 23:40', bills: 1, covers: 4, netSalesPaise: 50000, taxPaise: 2500, discountPaise: 0, byMode: [{ mode: 'cash', amountPaise: 52500 }], voids: 1, voidPaise: 30000, cashDifferencePaise: -500 });
    assert.equal((await h.call('GET', '/v1/admin/stores/spice-garden/sales')).status, 403);
  } finally { await h.close(); cleanup(h.dir); }
});

test('sync: the vendor puts a licence key on the hub and the outlet POS fetches it; only its own', async () => {
  const h = await startHub();
  try {
    const key = await paired(h);
    const other = await paired(h, 'other-shop');
    assert.deepEqual((await h.call('GET', '/v1/pos/licence', { key })).json, { key: null, updatedAt: null });
    const payload = Buffer.from(JSON.stringify({ licensee: 'Spice Garden', expiresAt: '2027-11-03T00:00:00.000Z', hardwareId: '2015-26E2-FE7D-7DEA-DF7B' })).toString('base64url');
    const lic = `${payload}.${'s'.repeat(86)}`;
    assert.equal((await h.call('PUT', '/v1/admin/stores/spice-garden/licence', { admin: true, body: { key: 'not a key' } })).status, 400);
    const put = await h.call('PUT', '/v1/admin/stores/spice-garden/licence', { admin: true, body: { key: `${lic.slice(0, 20)}\n${lic.slice(20)}` } });
    assert.equal(put.status, 200);
    assert.deepEqual([put.json.set, put.json.licensee, put.json.expiresAt, put.json.hardwareId], [true, 'Spice Garden', '2027-11-03T00:00:00.000Z', '2015-26E2-FE7D-7DEA-DF7B']);
    assert.equal((await h.call('GET', '/v1/pos/licence', { key })).json.key, lic);
    assert.equal((await h.call('GET', '/v1/pos/licence', { key: other })).json.key, null);
    assert.equal((await h.call('PUT', '/v1/admin/stores/spice-garden/licence', { admin: true, body: { key: '' } })).json.set, false);
    assert.equal((await h.call('GET', '/v1/pos/licence', { key })).json.key, null);
  } finally { await h.close(); cleanup(h.dir); }
});
