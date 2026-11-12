import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hub } from '../src/hub.ts';
import { importHub, ImportConflict } from '../src/importHub.ts';
import { startHub, menu } from './helpers.ts';
import { TOKEN_HEADER } from '../src/urbanpiper.ts';

const upRow = (db: DatabaseSync, biz: string, token: string) => db.prepare("INSERT INTO up_account (id, base_url, username, api_key, biz_id, webhook_token, updated_at) VALUES (1, 'https://pos-int.urbanpiper.com', 'u', 'k', ?, ?, 1)").run(biz, token);

test('importing the Tiffin hub: stores, paired POS PCs, menus and orders come across; a taken address is renamed; the POS keeps working with its device key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-'));
  try {
    // the Tiffin hub (same code and tables): three stores, one paired POS with a menu
    const tiffin = new Hub({ dbPath: join(dir, 'tiffin.db'), devOtp: true });
    const contai = tiffin.createStore('contai', 'Contai QSR');
    tiffin.createStore('demo-store', 'Tiffin Demo');
    tiffin.db.prepare("UPDATE store SET slug = 'demo' WHERE slug = 'demo-store'").run(); // the Tiffin hub allowed 'demo'; the cloud keeps it
    tiffin.createStore('shared', 'Tiffin Shared'); // also taken in the cloud below
    const dev = tiffin.pair(contai.pairingCode, 'Counter PC');
    tiffin.publishMenu(tiffin.device(dev.deviceKey), menu({ storeName: 'Contai QSR' }));
    upRow(tiffin.db, '324255', 'upt_tiffin');
    tiffin.close();

    // PosiNext Cloud already has its own "demo" store and the same UrbanPiper business
    mkdirSync(join(dir, 'cloud'));
    const cloud = await startHub(join(dir, 'cloud'));
    cloud.hub.createStore('shared', 'Cloud Shared');
    upRow(cloud.hub.db, '324255', 'upt_cloud');

    const src = new DatabaseSync(join(dir, 'tiffin.db'), { readOnly: true });
    const r = importHub(cloud.hub.db, src, { posType: 'tiffin_qsr' });
    src.close();
    assert.equal(r.tables.store!.copied, 3);
    assert.equal(r.tables.device!.copied, 1);
    assert.deepEqual(r.renamed.map((x) => [x.from, x.to]).sort(), [['demo', 'demo-qsr'], ['shared', 'shared-qsr']], 'a reserved address and one taken here');
    assert.equal(r.urbanpiper, 'same-business');
    assert.equal(r.legacyWebhookToken, 'upt_tiffin');

    // the Tiffin POS, now pointed at PosiNext Cloud, is still recognised by its device key and its menu is served
    const shop = await cloud.call('GET', '/v1/stores/contai');
    assert.equal(shop.status, 200);
    assert.equal(shop.json.name, 'Contai QSR');
    assert.equal((await cloud.call('GET', '/v1/pos/orders', { headers: { authorization: `Bearer ${dev.deviceKey}` } })).status, 200);
    assert.equal((await cloud.call('GET', '/v1/stores/demo-qsr')).json.name, 'Tiffin Demo');
    assert.equal((await cloud.call('GET', '/v1/stores/shared')).json.name, 'Cloud Shared', 'the store already here keeps its address');
    // the imported stores are QSR; the cloud's own store keeps what it had
    const types = Object.fromEntries(((await cloud.call('GET', '/v1/admin/overview', { admin: true })).json.stores as Array<{ slug: string; posType: string | null }>).map((s) => [s.slug, s.posType]));
    assert.deepEqual(types, { contai: 'tiffin_qsr', 'demo-qsr': 'tiffin_qsr', 'shared-qsr': 'tiffin_qsr', shared: null });

    // UrbanPiper webhooks registered by the Tiffin hub (old header, old token) still get in; a wrong token does not
    const hook = (headers: Record<string, string>) => cloud.call('POST', '/v1/urbanpiper/324255', { body: {}, headers: { ...headers, 'x-upr-event-type': '60015' } });
    assert.notEqual((await hook({ 'x-tiffin-token': 'upt_tiffin' })).status, 401);
    assert.notEqual((await hook({ [TOKEN_HEADER]: 'upt_cloud' })).status, 401);
    assert.equal((await hook({ 'x-tiffin-token': 'upt_wrong' })).status, 401);

    // running it again copies nothing twice
    const again = new DatabaseSync(join(dir, 'tiffin.db'), { readOnly: true });
    const r2 = importHub(cloud.hub.db, again);
    again.close();
    assert.equal(r2.tables.store!.copied, 0);
    assert.deepEqual(r2.renamed, []);
    await cloud.close();
  } finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may hold a closed database for a moment */ } }
});

test('two different UrbanPiper businesses stop the import before anything is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-'));
  try {
    const tiffin = new Hub({ dbPath: join(dir, 'tiffin.db') });
    tiffin.createStore('contai', 'Contai QSR');
    upRow(tiffin.db, '111', 'a');
    tiffin.close();
    const cloud = new Hub({ dbPath: join(dir, 'cloud.db') });
    upRow(cloud.db, '222', 'b');
    const src = new DatabaseSync(join(dir, 'tiffin.db'), { readOnly: true });
    assert.throws(() => importHub(cloud.db, src), ImportConflict);
    src.close();
    assert.equal((cloud.db.prepare('SELECT count(*) n FROM store').get() as { n: number }).n, 0);
    cloud.close();
  } finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may hold a closed database for a moment */ } }
});
