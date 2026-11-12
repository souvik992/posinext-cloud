import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, posStream, startHub } from './helpers.ts';

// P5-03 (DinePOS Table QR through the hub): a guest's request to <hub>/s/<store>/a/<addon>/... goes down the store's
// own event stream; the POS answers; the hub sends the answer back. Nothing is stored on the hub.
async function storeWithPos() {
  const h = await startHub();
  const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'spice-garden', name: 'Spice Garden' } })).json;
  const key = (await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'DinePOS' } })).json.deviceKey as string;
  return { h, key };
}
const b64 = (s: string) => Buffer.from(s).toString('base64');

test('relay: a guest request reaches the POS on its stream and the POS answer comes back, with the guest page policy', async () => {
  const { h, key } = await storeWithPos();
  const pos = posStream(h.base, key);
  try {
    await pos.waitFor(() => h.hub.connected(h.hub.store({ slug: 'spice-garden' }).id));
    const guest = fetch(`${h.base}/s/spice-garden/a/tableqr/api/table?t=abcdefghijklmnopqrst`);
    await pos.waitFor((e) => e.some((x) => x.type === 'guest.request'));
    const req = pos.events.find((x) => x.type === 'guest.request')!;
    assert.deepEqual({ method: req.method, path: req.path, query: req.query, body: req.body }, { method: 'GET', path: '/a/tableqr/api/table', query: 't=abcdefghijklmnopqrst', body: null });
    assert.equal(req.seq, undefined); // never numbered or stored: a reconnect does not replay it
    const ans = await h.call('POST', `/v1/pos/relay/${String(req.id)}`, { key, body: { status: 200, contentType: 'application/json; charset=utf-8', cacheControl: 'no-store', bodyBase64: b64('{"table":"T2"}') } });
    assert.equal(ans.status, 200);
    const res = await guest;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { table: 'T2' });
    assert.match(res.headers.get('content-security-policy')!, /connect-src 'self'/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    // answering twice, or for another store, is refused
    assert.equal((await h.call('POST', `/v1/pos/relay/${String(req.id)}`, { key, body: { status: 200, contentType: 'application/json', bodyBase64: '' } })).status, 404);
  } finally {
    await pos.close();
    await h.close();
    cleanup(h.dir);
  }
});

test('relay: POST bodies go through; the page and its files are kept a minute; unsafe answers are refused', async () => {
  const { h, key } = await storeWithPos();
  const pos = posStream(h.base, key);
  try {
    await pos.waitFor(() => h.hub.connected(h.hub.store({ slug: 'spice-garden' }).id));
    const answerNext = async (body: Record<string, unknown>) => {
      const n = pos.events.filter((x) => x.type === 'guest.request').length;
      await pos.waitFor((e) => e.filter((x) => x.type === 'guest.request').length > n);
      const req = pos.events.filter((x) => x.type === 'guest.request').at(-1)!;
      return { req, res: await h.call('POST', `/v1/pos/relay/${String(req.id)}`, { key, body }) };
    };
    const order = fetch(`${h.base}/s/spice-garden/a/tableqr/api/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: 'tok', lines: [{ qty: 1 }] }) });
    const { req } = await answerNext({ status: 422, contentType: 'application/json', bodyBase64: b64('{"error":{"message":"Your bill is already printed."}}') });
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(String(req.body)), { t: 'tok', lines: [{ qty: 1 }] });
    assert.equal((await order).status, 422);

    const page = fetch(`${h.base}/s/spice-garden/a/tableqr/app.js`);
    await answerNext({ status: 200, contentType: 'text/javascript; charset=utf-8', cacheControl: 'no-cache', bodyBase64: b64('console.log(1)') });
    assert.equal(await (await page).text(), 'console.log(1)');
    const before = pos.events.length;
    assert.equal(await (await fetch(`${h.base}/s/spice-garden/a/tableqr/app.js`)).text(), 'console.log(1)'); // from the hub's minute cache
    assert.equal(pos.events.length, before);

    const bad = fetch(`${h.base}/s/spice-garden/a/tableqr/api/x`);
    const { res } = await answerNext({ status: 200, contentType: 'application/x-msdownload', bodyBase64: b64('MZ') });
    assert.equal(res.status, 400);
    void bad.catch(() => undefined);
  } finally {
    await pos.close();
    await h.close();
    cleanup(h.dir);
  }
});

test('relay: a store whose POS is not connected says so; only add-on paths are relayed', async () => {
  const { h } = await storeWithPos();
  try {
    const page = await fetch(`${h.base}/s/spice-garden/a/tableqr/?t=x`);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /not connected right now/);
    const api = await h.call('GET', '/s/spice-garden/a/tableqr/api/menu');
    assert.equal(api.status, 503);
    assert.equal(api.json.error.code, 'STORE_OFFLINE');
    assert.equal((await h.call('GET', '/s/nope-store/a/tableqr/api/menu')).status, 404);
    assert.equal((await fetch(`${h.base}/s/spice-garden/a/tableqr`, { redirect: 'manual' })).headers.get('location'), '/s/spice-garden/a/tableqr/');
    assert.equal((await fetch(`${h.base}/s/spice-garden/a/Bad_Addon/x`)).status, 404);
  } finally {
    await h.close();
    cleanup(h.dir);
  }
});
