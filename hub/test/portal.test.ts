import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, startHub } from './helpers.ts';
import { Portal } from '../src/portal.ts';

// P8-09: the customer portal served by the hub on its own address, with the API on the same address.
function get(base: string, path: string, host: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function builtPortal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'portal-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'fonts'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>posinext</title><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("portal")');
  writeFileSync(join(dir, 'fonts', 'manrope-latin.woff2'), 'woff2');
  return dir;
}

test('portal: pages and files on the portal address; the browser routes the rest; the API answers there too', async () => {
  const dir = builtPortal();
  const h = await startHub(undefined, undefined, undefined, { portal: new Portal({ dir, hosts: ['portal.posinext.com'] }) });
  try {
    const home = await get(h.base, '/', 'portal.posinext.com');
    assert.deepEqual([home.status, home.headers['content-type'], home.headers['cache-control'], home.headers['x-frame-options']], [200, 'text/html; charset=utf-8', 'no-cache', 'DENY']);
    assert.match(home.body, /posinext/);
    // only the portal's own code runs, never inside another site's frame
    assert.match(String(home.headers['content-security-policy']), /default-src 'self'; script-src 'self';.*frame-ancestors 'none'/);
    assert.equal(home.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=(), payment=()');
    assert.equal(home.headers['strict-transport-security'], undefined, 'plain http: no HSTS');
    const js = await get(h.base, '/assets/index-abc123.js', 'portal.posinext.com');
    assert.deepEqual([js.status, js.headers['content-type'], js.headers['cache-control']], [200, 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable']);
    assert.equal((await get(h.base, '/fonts/manrope-latin.woff2', 'portal.posinext.com')).headers['content-type'], 'font/woff2');
    // a page the browser routes (/app/licences) is index.html; so is a missing file and any way out of the folder
    for (const p of ['/app/licences', '/register?product=fine_dine', '/assets/missing.js', '/../hub.db', '/%2e%2e/%2e%2e/etc/passwd', '/%E0%A4%A']) {
      const r = await get(h.base, p, 'portal.posinext.com');
      assert.deepEqual([r.status, r.body.includes('id="root"')], [200, true], p);
    }
    // the API on the same address
    const status = await get(h.base, '/v1/status', 'portal.posinext.com');
    assert.equal(status.headers['content-type'], 'application/json; charset=utf-8');
    assert.ok(JSON.parse(status.body).components);
    // the hub's own address is unchanged
    const own = await get(h.base, '/', '127.0.0.1');
    assert.equal(own.status, 302);
  } finally { await h.close(); cleanup(h.dir); cleanup(dir); }
});

test('portal: before the first build is fetched it says so; without a list of hosts, portal.<anything> is the portal', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'portal-empty-'));
  const h = await startHub(undefined, undefined, undefined, { portal: new Portal({ dir: empty }) });
  try {
    const r = await get(h.base, '/', 'portal.example.in');
    assert.equal(r.status, 503);
    assert.match(r.body, /being installed/);
    assert.equal((await get(h.base, '/', 'hub.example.in')).status, 302, 'other addresses are not the portal');
  } finally { await h.close(); cleanup(h.dir); cleanup(empty); }
});
