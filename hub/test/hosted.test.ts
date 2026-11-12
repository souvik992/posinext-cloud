import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { Hub } from '../src/hub.ts';
import { createHubServer } from '../src/http.ts';
import { HostedOutlets } from '../src/hosted.ts';
import { one } from '../src/db.ts';
import { cleanup } from './helpers.ts';

// P6-04: a hosted outlet. Its DinePOS server runs under the cloud; devices reach it at https://<store>.<cloud>.
// The bundle in outlet-server/ is built for Linux (the cloud server); on Windows, point HUB_TEST_OUTLET_SERVER at a
// Windows build (fine-dine: npm run bundle -w @dinepos/server -> apps/server/dist-bundle/server.mjs).
const repo = join(import.meta.dirname, '..', '..');
const entry = process.env.HUB_TEST_OUTLET_SERVER ?? (process.platform === 'win32' ? '' : join(repo, 'outlet-server', 'server.mjs'));
const HOST = 'spice-garden.cloud.test';

function device(port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const text = o.body === undefined ? undefined : JSON.stringify(o.body);
    const req = http.request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', setHost: false, headers: { host: HOST, ...(text ? { 'content-type': 'application/json' } : {}), ...o.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const s = Buffer.concat(chunks).toString();
        let json: unknown = s;
        try {
          json = JSON.parse(s);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

function stream(port: number) {
  return new Promise<{ send(t: string): void; next(): Promise<any> }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/stream', setHost: false, headers: { host: HOST, origin: `https://${HOST}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') } });
    req.on('response', (r) => reject(new Error(`refused ${r.statusCode}`)));
    req.on('upgrade', (_res, socket: Duplex) => {
      const queue: string[] = [];
      const waiters: Array<(s: string) => void> = [];
      let buf = Buffer.alloc(0);
      socket.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1]! & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          }
          if (buf.length < off + len) return;
          const op = buf[0]! & 0x0f;
          const text = buf.subarray(off, off + len).toString();
          buf = buf.subarray(off + len);
          if (op !== 1) continue;
          const w = waiters.shift();
          if (w) w(text);
          else queue.push(text);
        }
      });
      resolve({
        send(t) {
          const p = Buffer.from(t);
          const mask = randomBytes(4);
          const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0xfe, p.length >> 8, p.length & 255]);
          socket.write(Buffer.concat([head, mask, Buffer.from(p.map((b, i) => b ^ mask[i & 3]!))]));
        },
        next: async () => JSON.parse(queue.length ? queue.shift()! : await new Promise<string>((r) => waiters.push(r))),
      });
    });
    req.end();
  });
}

test('hosted outlet: set up and first terminal from the admin page; devices pair and work; the proxy never makes them the master', { skip: !entry || !existsSync(entry) ? `no DinePOS server bundle (${entry || 'set HUB_TEST_OUTLET_SERVER on Windows'})` : false, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-hosted-'));
  const hub = new Hub({ dbPath: join(dir, 'hub.db') });
  const hosted = new HostedOutlets(hub, { serverEntry: entry, dataRoot: join(dir, 'outlets'), basePort: 5600 + Math.floor(Math.random() * 300) });
  const server = createHubServer(hub, { adminKey: 'admin-key', deviceDomain: 'cloud.test', publicUrl: 'https://cloud.test', hosted });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const admin = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-key' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  try {
    assert.equal((await admin('POST', '/v1/admin/stores', { slug: 'spice-garden', name: 'Spice Garden' })).status, 200);
    const on = await admin('PUT', '/v1/admin/stores/spice-garden/hosted', { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.running, true);
    assert.equal(on.json.deviceUrl, 'https://spice-garden.cloud.test');
    assert.equal(on.json.setup.setupNeeded, true);

    // the owner's first step, from the admin page
    const set = await admin('POST', '/v1/admin/stores/spice-garden/hosted/setup', { outletName: 'Spice Garden', ownerName: 'Asha', pin: '4321' });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    assert.equal(set.json.setup.setupNeeded, false);
    assert.equal(set.json.setup.users[0].name, 'Asha');

    // a device through the cloud is never the master, not even with the real host key in hand
    assert.equal((await device(port, '/v1/health')).status, 200);
    assert.equal((await device(port, '/v1/floor')).status, 401);
    const key = one<{ host_key: string }>(hub.db, 'SELECT host_key FROM hosted_outlet')!.host_key;
    assert.equal((await device(port, '/v1/floor', { headers: { 'x-dinepos-host-key': key } })).status, 401);
    // nor can anyone set the outlet up again
    const again = await device(port, '/v1/commands', { method: 'POST', body: { commandId: '01JD0000000000000000000000', type: 'SetupOutlet', payload: { outletName: 'X', ownerId: '01JD0000000000000000000001', ownerName: 'Evil', pin: '1111' }, createdAt: new Date().toISOString() } });
    assert.notEqual(again.status, 200);

    // the first terminal pairs: its code is approved on the admin page with the owner's PIN
    const ticket = (await device(port, '/v1/pairing-requests', { method: 'POST', body: { name: 'Counter 1', kind: 'terminal' } })).json as { requestId: string; secret: string; code: string };
    assert.equal((await admin('POST', '/v1/admin/stores/spice-garden/hosted/approve', { code: ticket.code, pin: '9999' })).status, 401);
    const ok = await admin('POST', '/v1/admin/stores/spice-garden/hosted/approve', { code: ticket.code, pin: '4321' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const paired = (await device(port, `/v1/pairing-requests/${ticket.requestId}/collect`, { method: 'POST', body: { secret: ticket.secret } })).json as { status: string; deviceToken: string };
    assert.equal(paired.status, 'paired');
    const auth = { authorization: `Device ${paired.deviceToken}` };
    assert.equal((await device(port, '/v1/floor', { headers: auth })).status, 200);
    // the owner signs in on that terminal as on any outlet
    const users = (await device(port, '/v1/setup-state', { headers: auth })).json as { users: Array<{ id: string }> };
    assert.equal((await device(port, '/v1/sessions', { method: 'POST', headers: auth, body: { userId: users.users[0]!.id, pin: '4321' } })).status, 200);

    // the live stream, through the cloud's proxy, for the paired terminal
    const s = await stream(port);
    s.send(JSON.stringify({ type: 'hello', deviceToken: paired.deviceToken, resumeFrom: null, topics: ['floor'] }));
    assert.equal((await s.next()).type, 'ready');

    // switched off: its server stops; its data stays for later
    const off = await admin('PUT', '/v1/admin/stores/spice-garden/hosted', { enabled: false });
    assert.equal(off.json.hosted, false);
    assert.equal((await device(port, '/v1/health')).status, 503);
    assert.ok(existsSync(join(dir, 'outlets')));
  } finally {
    await hosted.stop();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    hub.close();
    cleanup(dir);
  }
});
