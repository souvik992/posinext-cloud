import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Hub } from '../src/hub.ts';
import { createHubServer } from '../src/http.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const NAME = (i: number) => `hourly-202610${String(10 + i).padStart(2, '0')}T091500123Z.db.gz`;

async function start(o: { keep?: number; maxBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-backups-'));
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), backupKeep: o.keep, backupMaxBytes: o.maxBytes });
  const server: Server = createHubServer(hub, { adminKey: 'k' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const pair = (slug: string) => hub.pair(hub.createStore(slug, slug).pairingCode, 'POS').deviceKey;
  const put = (key: string, name: string, body: Buffer, hash = sha(body)) => fetch(`${base}/v1/pos/backups/${name}`, { method: 'PUT', body: new Uint8Array(body), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream', 'x-content-sha256': hash } });
  const get = (key: string, path: string) => fetch(base + path, { headers: { authorization: `Bearer ${key}` } });
  const close = () => new Promise<void>((r) => { server.close(() => { hub.close(); rmSync(dir, { recursive: true, force: true }); r(); }); server.closeAllConnections(); });
  return { hub, dir, base, pair, put, get, close };
}

test('backup server: a paired POS uploads, lists and downloads its backups; checked by SHA-256; other stores cannot see them', async () => {
  const h = await start();
  try {
    const key = h.pair('shop-one'), other = h.pair('shop-two');
    const data = Buffer.from('pretend gzipped database '.repeat(1000));
    const up = await h.put(key, NAME(1), data);
    assert.equal(up.status, 200);
    assert.equal((await up.json()).bytes, data.length);

    const list = (await (await h.get(key, '/v1/pos/backups')).json()).backups;
    assert.deepEqual(list.map((b: { name: string }) => b.name), [NAME(1)]);
    const down = await h.get(key, `/v1/pos/backups/${NAME(1)}`);
    assert.equal(down.headers.get('x-content-sha256'), sha(data));
    assert.deepEqual(Buffer.from(await down.arrayBuffer()), data);

    // damaged on the way: refused, nothing kept, no temporary file left behind
    assert.equal((await h.put(key, NAME(2), data, sha(Buffer.from('other')))).status, 400);
    assert.equal((await (await h.get(key, '/v1/pos/backups')).json()).backups.length, 1);
    const storeDir = readdirSync(join(h.dir, 'backups')).map((d) => join(h.dir, 'backups', d)).find((d) => readdirSync(d).includes(NAME(1)))!;
    assert.ok(!readdirSync(storeDir).some((f) => f.endsWith('.tmp')));

    // other stores, unknown keys and odd names
    assert.deepEqual((await (await h.get(other, '/v1/pos/backups')).json()).backups, []);
    assert.equal((await h.get(other, `/v1/pos/backups/${NAME(1)}`)).status, 404);
    assert.equal((await h.get('tpk_wrong', '/v1/pos/backups')).status, 401);
    assert.equal((await h.put('tpk_wrong', NAME(3), data)).status, 401);
    assert.equal((await h.put(key, '..%2Fhub.db', data)).status, 400);
    assert.equal((await h.get(key, '/v1/pos/backups/..%2F..%2Fhub.db')).status, 400);
  } finally { await h.close(); }
});

test('backup server: keeps the newest backups per store, refuses too-large uploads, and stores photos by fingerprint', async () => {
  const h = await start({ keep: 3, maxBytes: 50_000 });
  try {
    const key = h.pair('shop-one');
    for (let i = 1; i <= 5; i++) assert.equal((await h.put(key, NAME(i), Buffer.from(`backup ${i}`))).status, 200);
    assert.deepEqual((await (await h.get(key, '/v1/pos/backups')).json()).backups.map((b: { name: string }) => b.name), [NAME(5), NAME(4), NAME(3)]);
    assert.equal((await h.put(key, NAME(6), Buffer.alloc(60_000, 1))).status, 413);
    assert.equal((await (await h.get(key, '/v1/pos/backups')).json()).backups.length, 3);

    const photo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100, 7)]);
    const name = `${sha(photo)}.png`;
    const putImg = (n: string, b: Buffer) => fetch(`${h.base}/v1/pos/backup-images/${n}`, { method: 'PUT', body: new Uint8Array(b), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/octet-stream' } });
    assert.equal((await putImg(name, photo)).status, 200);
    assert.equal((await putImg(name, Buffer.from('not it'))).status, 400);
    assert.deepEqual((await (await h.get(key, '/v1/pos/backup-images')).json()).names, [name]);
    assert.deepEqual(Buffer.from(await (await h.get(key, `/v1/pos/backup-images/${name}`)).arrayBuffer()), photo);
  } finally { await h.close(); }
});
