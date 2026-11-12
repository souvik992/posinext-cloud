import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';
import { createHubServer } from '../src/http.ts';
import { cleanup } from './helpers.ts';

// P6-02: devices reach https://<store>.<cloud>/ and the outlet's main PC answers through its own tunnel.
async function setUp() {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-tunnel-'));
  const hub = new Hub({ dbPath: join(dir, 'hub.db') });
  const server = createHubServer(hub, { adminKey: 'admin-key', deviceDomain: 'cloud.test', publicUrl: 'https://cloud.test' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const store = (await (await fetch(`${base}/v1/admin/stores`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-key' }, body: JSON.stringify({ slug: 'spice-garden', name: 'Spice Garden' }) })).json()) as { storeId: string; pairingCode: string };
  const key = ((await (await fetch(`${base}/v1/pos/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: store.pairingCode, deviceName: 'DinePOS' }) })).json()) as { deviceKey: string }).deviceKey;
  const close = async () => {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    hub.close();
    cleanup(dir);
  };
  return { hub, base, port, key, storeId: store.storeId, close };
}

/** The outlet side: answers each request with `answer`, echoes stream messages back with a prefix. */
async function outlet(base: string, key: string, answer: (m: { method: string; path: string; headers: Record<string, string>; body: string | null }) => { status: number; headers: Record<string, string>; body: string }) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/pos/tunnel`, { headers: { authorization: `Bearer ${key}` } } as never);
  const seen: Array<Record<string, unknown>> = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as { t: string; id: string; method: string; path: string; headers: Record<string, string>; body: string | null; data: string };
    seen.push(m);
    if (m.t === 'req') {
      const a = answer({ ...m, body: m.body ? Buffer.from(m.body, 'base64').toString() : null });
      ws.send(JSON.stringify({ t: 'res', id: m.id, status: a.status, headers: a.headers, body: Buffer.from(a.body).toString('base64') }));
    } else if (m.t === 'ws.msg') ws.send(JSON.stringify({ t: 'ws.msg', id: m.id, data: `outlet got: ${m.data}` }));
  };
  await new Promise<void>((r, j) => {
    ws.onopen = () => r();
    ws.onerror = () => j(new Error('tunnel refused'));
  });
  return { ws, seen };
}

/** A device's request with a Host header (fetch cannot set one). */
function device(port: number, host: string, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { host, ...o.headers }, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

/** A minimal masked WebSocket client on a raw socket (for a Host header). */
function deviceStream(port: number, host: string, headers: Record<string, string> = {}) {
  return new Promise<{ send(t: string): void; next(): Promise<string>; status: number }>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/stream', headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers }, setHost: false });
    req.on('response', (res) => resolve({ send() {}, next: () => Promise.resolve(''), status: res.statusCode ?? 0 }));
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
            len = buf.readUInt16BE(2);
            off = 4;
          }
          if (buf.length < off + len) return;
          const text = buf.subarray(off, off + len).toString();
          const op = buf[0]! & 0x0f;
          buf = buf.subarray(off + len);
          if (op !== 0x1) continue;
          const w = waiters.shift();
          if (w) w(text);
          else queue.push(text);
        }
      });
      resolve({
        status: 101,
        send(t: string) {
          const p = Buffer.from(t);
          const mask = Buffer.from([1, 2, 3, 4]);
          const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
          socket.write(Buffer.concat([head, mask, Buffer.from(p.map((b, i) => b ^ mask[i & 3]!))]));
        },
        next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise<string>((r) => waiters.push(r))),
      });
    });
    req.end();
  });
}

test('tunnel: a device request to <store>.<cloud> reaches the outlet with its own credentials, and the answer comes back', async () => {
  const c = await setUp();
  const o = await outlet(c.base, c.key, (m) => ({ status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'r1', 'set-cookie': 'x=1' }, body: JSON.stringify({ path: m.path, method: m.method, body: m.body, auth: m.headers.authorization ?? null, session: m.headers['x-user-session'] ?? null, cookie: m.headers.cookie ?? null }) }));
  try {
    const r = await device(c.port, 'spice-garden.cloud.test', '/v1/commands?x=1', { method: 'POST', headers: { authorization: 'Device tok', 'x-user-session': 'sess', 'content-type': 'application/json', cookie: 'nope=1' }, body: '{"type":"FireKOT"}' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { path: '/v1/commands?x=1', method: 'POST', body: '{"type":"FireKOT"}', auth: 'Device tok', session: 'sess', cookie: null });
    assert.equal(r.headers['x-request-id'], 'r1');
    assert.equal(r.headers['set-cookie'], undefined); // only the listed answer headers pass
    // the cloud's own pages are not the outlet's
    assert.equal((await device(c.port, 'cloud.test', '/health')).status, 200);
    assert.equal(o.seen.filter((m) => m.t === 'req').length, 1);
    // an unknown store's address
    assert.equal((await device(c.port, 'nobody.cloud.test', '/v1/health')).status, 404);
    // the device address, as the outlet is told
    const info = (await (await fetch(`${c.base}/v1/pos/tunnel-info`, { headers: { authorization: `Bearer ${c.key}` } })).json()) as { deviceUrl: string; connected: boolean };
    assert.deepEqual(info, { deviceUrl: 'https://spice-garden.cloud.test', connected: true });
  } finally {
    o.ws.close();
    await c.close();
  }
});

test('tunnel: a device live stream goes to the outlet and back; foreign pages may not open one', async () => {
  const c = await setUp();
  const o = await outlet(c.base, c.key, () => ({ status: 200, headers: {}, body: '' }));
  try {
    const s = await deviceStream(c.port, 'spice-garden.cloud.test', { origin: 'https://spice-garden.cloud.test' });
    assert.equal(s.status, 101);
    s.send('{"type":"hello"}');
    assert.equal(await s.next(), 'outlet got: {"type":"hello"}');
    const open = o.seen.find((m) => m.t === 'ws.open')!;
    assert.equal((open.headers as Record<string, string>).origin, 'https://spice-garden.cloud.test');
    assert.equal((await deviceStream(c.port, 'spice-garden.cloud.test', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await deviceStream(c.port, 'spice-garden.cloud.test', { origin: 'app://dinepos' })).status, 101);
  } finally {
    o.ws.close();
    await c.close();
  }
});

test('tunnel: outlet offline says so; only a paired outlet may open a tunnel; Caddy may certify only known addresses', async () => {
  const c = await setUp();
  try {
    const r = await device(c.port, 'spice-garden.cloud.test', '/v1/health');
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.body).error.message, /not connected to DinePOS Cloud/);
    assert.equal((await deviceStream(c.port, 'spice-garden.cloud.test')).status, 503);
    await assert.rejects(outlet(c.base, 'wrong-key', () => ({ status: 200, headers: {}, body: '' })));
    assert.equal((await fetch(`${c.base}/v1/tls-ask?domain=spice-garden.cloud.test`)).status, 200);
    assert.equal((await fetch(`${c.base}/v1/tls-ask?domain=cloud.test`)).status, 200);
    assert.equal((await fetch(`${c.base}/v1/tls-ask?domain=nobody.cloud.test`)).status, 404);
    assert.equal((await fetch(`${c.base}/v1/tls-ask?domain=evil.example`)).status, 404);
    // a second connection from the same outlet replaces the first
    const a = await outlet(c.base, c.key, () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'first' }));
    const b = await outlet(c.base, c.key, () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'second' }));
    assert.equal((await device(c.port, 'spice-garden.cloud.test', '/v1/health')).body, 'second');
    a.ws.close();
    b.ws.close();
  } finally {
    await c.close();
  }
});
