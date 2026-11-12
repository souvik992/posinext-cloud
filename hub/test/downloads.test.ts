import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

// P8-04: the portal's Windows downloads, from the newest GitHub Release of each product.
const asset = (name: string, size = 1000) => ({ name, size, browser_download_url: `https://github.com/dl/${name}`, state: 'uploaded' });
const release = (tag: string, at: string, names: string[], o: { draft?: boolean } = {}) => ({ tag_name: tag, draft: o.draft ?? false, prerelease: false, published_at: at, assets: names.map((n) => asset(n)) });

function fakeGitHub() {
  const state = {
    calls: 0,
    down: false,
    releases: {
      'souvik992/fine-dine': [
        // newest build: no Table QR (its signing secret was not set) -> Table QR comes from the build before
        release('dinepos-build-12', '2026-11-08T10:00:00Z', ['DinePOS-Setup-0.1.7.exe']),
        release('dinepos-build-11', '2026-11-07T10:00:00Z', ['DinePOS-Setup-0.1.6.exe', 'DinePOS-TableQR-Setup-1.2.0.exe']),
        release('dinepos-build-13', '2026-11-09T10:00:00Z', ['DinePOS-Setup-9.9.9.exe'], { draft: true }),
        release('something-else', '2026-11-10T10:00:00Z', ['DinePOS-Setup-0.0.1.exe']),
      ],
      'souvik992/tiffin': [release('tiffin-build-40', '2026-11-08T09:00:00Z', ['TiffinPOS-Setup-0.3.12.exe', 'TiffinPOS-ODS-Setup-1.0.13.exe', 'TiffinDataManager-Setup-0.1.0.exe'])],
    } as Record<string, unknown[]>,
  };
  const f = (async (url: string | URL) => {
    state.calls++;
    if (state.down) throw new Error('offline');
    const repo = /repos\/([^/]+\/[^/]+)\/releases/.exec(String(url))![1]!;
    return new Response(JSON.stringify(state.releases[repo] ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { state, f };
}

async function signedIn(h: TestHub) {
  const email = 'asha@spicegarden.in';
  await h.call('POST', '/v1/account/signup', { body: { businessName: 'Spice Garden', name: 'Asha Rao', email, phone: '9876543210', password: 'tandoor-2026' } });
  const code = /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1];
  const res = await fetch(`${h.base}/v1/account/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
  return String(res.headers.get('set-cookie')).split(';')[0]!;
}

test('downloads: the newest build of each app and add-on, per product; an add-on missing from the newest build comes from the one before', async () => {
  const gh = fakeGitHub();
  const h = await startHub(undefined, undefined, undefined, { githubFetch: gh.f });
  try {
    const r = await h.call('GET', '/v1/downloads');
    assert.equal(r.status, 200);
    const by = Object.fromEntries((r.json.downloads as Array<{ id: string }>).map((d) => [d.id, d])) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(by), ['dinepos', 'dinepos-tableqr', 'dinepos-kitchen', 'dinepos-captain', 'tiffin', 'tiffin-ods', 'posinext-grocery', 'posinext-grocery-edc', 'posinext-apparel', 'posinext-apparel-edc', 'posinext-pharmacy', 'posinext-pharmacy-edc']);
    assert.deepEqual([by['dinepos-kitchen']!.kind, by['dinepos-kitchen']!.product, by['dinepos-kitchen']!.available], ['addon', 'fine_dine', false], 'KDS: listed, not built yet');
    assert.deepEqual([by['dinepos-captain']!.kind, by['dinepos-captain']!.product, by['dinepos-captain']!.available], ['addon', 'fine_dine', false], 'Captain APK: listed, not built yet');
    assert.deepEqual([by.dinepos!.version, by.dinepos!.build, by.dinepos!.product, by.dinepos!.app], ['0.1.7', '12', 'fine_dine', 'DinePOS']);
    assert.deepEqual([by['dinepos-tableqr']!.version, by['dinepos-tableqr']!.build, by['dinepos-tableqr']!.kind], ['1.2.0', '11', 'addon']);
    assert.deepEqual([by.tiffin!.version, by.tiffin!.productName, by['tiffin-ods']!.version], ['0.3.12', 'QSR', '1.0.13']);
    assert.equal('url' in by.dinepos!, false, 'the list does not hand out GitHub addresses; downloads go through the account');
    // cached: a second look does not ask GitHub again
    const calls = gh.state.calls;
    await h.call('GET', '/v1/downloads');
    assert.equal(gh.state.calls, calls);
  } finally { await h.close(); cleanup(h.dir); }
});

test('downloads: GitHub down keeps the last list (also after a restart); nothing published yet shows as not available', async () => {
  const gh = fakeGitHub();
  const h = await startHub(undefined, undefined, undefined, { githubFetch: gh.f });
  try {
    await h.call('GET', '/v1/downloads');
    gh.state.down = true;
    h.clock.t += 11 * 60_000; // past the cache time
    const later = await h.call('GET', '/v1/downloads');
    assert.equal(later.json.downloads[0].version, '0.1.7');
    const h2 = await startHub(h.dir, h.clock, undefined, { githubFetch: gh.f });
    try {
      const afterRestart = await h2.call('GET', '/v1/downloads');
      assert.equal(afterRestart.json.downloads[0].version, '0.1.7', 'the saved list is used while GitHub is down');
    } finally { await h2.close(); }
  } finally { await h.close(); cleanup(h.dir); }

  const empty = fakeGitHub();
  empty.state.releases = {};
  const e = await startHub(undefined, undefined, undefined, { githubFetch: empty.f });
  try {
    const r = await e.call('GET', '/v1/downloads');
    assert.deepEqual((r.json.downloads as Array<{ available: boolean; version: unknown }>).map((d) => [d.available, d.version]), Array.from({ length: 12 }, () => [false, null]));
  } finally { await e.close(); cleanup(e.dir); }
});

test('downloads: a signed-in account gets the installer (recorded); without signing in, or an unknown file, it does not', async () => {
  const gh = fakeGitHub();
  const h = await startHub(undefined, undefined, undefined, { githubFetch: gh.f });
  try {
    const anon = await fetch(`${h.base}/v1/account/downloads/dinepos`, { redirect: 'manual' });
    assert.equal(anon.status, 401);
    const cookie = await signedIn(h);
    const ok = await fetch(`${h.base}/v1/account/downloads/dinepos`, { redirect: 'manual', headers: { cookie } });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), 'https://github.com/dl/DinePOS-Setup-0.1.7.exe');
    await fetch(`${h.base}/v1/account/downloads/tiffin-ods`, { redirect: 'manual', headers: { cookie } });
    const unknown = await fetch(`${h.base}/v1/account/downloads/pizza`, { redirect: 'manual', headers: { cookie } });
    assert.equal(unknown.status, 404);
    const stats = await h.call('GET', '/v1/admin/downloads', { admin: true });
    assert.deepEqual((stats.json.stats as Array<{ item: string; version: string; downloads: number }>).map((s) => [s.item, s.version, s.downloads]).sort(), [['dinepos', '0.1.7', 1], ['tiffin-ods', '1.0.13', 1]]);
    assert.equal((await h.call('GET', '/v1/admin/downloads')).status, 403);
  } finally { await h.close(); cleanup(h.dir); }
});

// ---- P8-11: installers built on the vendor's PC and uploaded to the cloud
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const upload = (h: TestHub, item: string, name: string, bytes: Buffer, o: { admin?: boolean; sha?: string } = {}) =>
  fetch(`${h.base}/v1/admin/downloads/${item}/${encodeURIComponent(name)}`, {
    method: 'PUT', body: new Uint8Array(bytes),
    headers: { 'content-type': 'application/octet-stream', 'x-content-sha256': o.sha ?? sha(bytes), ...(o.admin === false ? {} : { 'x-admin-key': 'admin-test-key' }) },
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));

test('P8-11: an uploaded installer is offered instead of GitHub and streamed from the cloud (byte for byte, recorded)', async () => {
  const gh = fakeGitHub();
  const files = mkdtempSync(join(tmpdir(), 'hub-dl-'));
  const h = await startHub(undefined, undefined, undefined, { githubFetch: gh.f, downloadsDir: files });
  try {
    const exe = randomBytes(300_000);
    const up = await upload(h, 'dinepos', 'DinePOS-Setup-0.1.8.exe', exe);
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.deepEqual([up.json.file.item, up.json.file.version, up.json.file.size, up.json.file.sha256], ['dinepos', '0.1.8', exe.length, sha(exe)]);
    const list = (await h.call('GET', '/v1/downloads')).json.downloads as Array<Record<string, unknown>>;
    const d = list.find((x) => x.id === 'dinepos')!;
    assert.deepEqual([d.available, d.version, d.fileName, d.size, d.build], [true, '0.1.8', 'DinePOS-Setup-0.1.8.exe', exe.length, null]);
    assert.equal(list.find((x) => x.id === 'tiffin')!.version, '0.3.12', 'an item with no upload still comes from GitHub');

    const cookie = await signedIn(h);
    const res = await fetch(`${h.base}/v1/account/downloads/dinepos`, { redirect: 'manual', headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="DinePOS-Setup-0.1.8.exe"');
    assert.equal(res.headers.get('x-content-sha256'), sha(exe));
    assert.equal(res.headers.get('content-type'), 'application/vnd.microsoft.portable-executable');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(exe));
    // the captain app is an Android APK: a phone's browser offers to install it
    const apk = randomBytes(5_000);
    assert.equal((await upload(h, 'dinepos-captain', 'DinePOS-Captain-0.1.0.apk', apk)).status, 200);
    assert.equal((await upload(h, 'dinepos-captain', 'DinePOS-Captain-0.1.0.exe', apk)).status, 400, 'only the APK');
    const a = await fetch(`${h.base}/v1/account/downloads/dinepos-captain`, { headers: { cookie } });
    assert.equal(a.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.ok(Buffer.from(await a.arrayBuffer()).equals(apk));
    const stats = await h.call('GET', '/v1/admin/downloads', { admin: true });
    assert.deepEqual((stats.json.stats as Array<{ item: string; version: string }>).map((s) => [s.item, s.version]).sort(), [['dinepos', '0.1.8'], ['dinepos-captain', '0.1.0']]);
    assert.deepEqual((stats.json.files as Array<{ fileName: string }>).map((f) => f.fileName).sort(), ['DinePOS-Captain-0.1.0.apk', 'DinePOS-Setup-0.1.8.exe']);

    // the file gone from the disk: a clear answer, not a broken download
    rmSync(join(files, 'dinepos', 'DinePOS-Setup-0.1.8.exe'));
    const gone = await fetch(`${h.base}/v1/account/downloads/dinepos`, { headers: { cookie } });
    assert.equal(gone.status, 503);
  } finally { await h.close(); cleanup(h.dir); cleanup(files); }
});

test('P8-11: uploads need the admin key, the right file name and an intact file; nothing is kept otherwise', async () => {
  const files = mkdtempSync(join(tmpdir(), 'hub-dl-'));
  const h = await startHub(undefined, undefined, undefined, { githubFetch: fakeGitHub().f, downloadsDir: files });
  try {
    const exe = randomBytes(10_000);
    assert.equal((await upload(h, 'dinepos', 'DinePOS-Setup-0.1.8.exe', exe, { admin: false })).status, 403);
    assert.equal((await upload(h, 'dinepos', 'TiffinPOS-Setup-0.3.13.exe', exe)).status, 400, 'another product\'s installer');
    assert.equal((await upload(h, 'dinepos', 'DinePOS-Setup-../x.exe', exe)).status, 400, 'a path in the version');
    assert.equal((await upload(h, 'pizza', 'DinePOS-Setup-0.1.8.exe', exe)).status, 404);
    const bad = await upload(h, 'dinepos', 'DinePOS-Setup-0.1.8.exe', exe, { sha: sha(randomBytes(8)) });
    assert.equal(bad.status, 400);
    assert.match(String(bad.json.error.message), /damaged/);
    assert.deepEqual(readdirSync(join(files, 'dinepos')), [], 'a damaged upload leaves nothing behind');
    assert.equal(((await h.call('GET', '/v1/admin/downloads', { admin: true })).json.files as unknown[]).length, 0);
  } finally { await h.close(); cleanup(h.dir); cleanup(files); }
});

test('P8-11: the newest 3 versions are kept; deleting the newest offers the one before; the same version again replaces it', async () => {
  const files = mkdtempSync(join(tmpdir(), 'hub-dl-'));
  const h = await startHub(undefined, undefined, undefined, { githubFetch: fakeGitHub().f, downloadsDir: files });
  try {
    for (const v of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) {
      h.clock.t += 60_000;
      assert.equal((await upload(h, 'tiffin-ods', `TiffinPOS-ODS-Setup-${v}.exe`, randomBytes(1000))).status, 200);
    }
    assert.deepEqual(readdirSync(join(files, 'tiffin-ods')).sort(), ['TiffinPOS-ODS-Setup-1.0.1.exe', 'TiffinPOS-ODS-Setup-1.0.2.exe', 'TiffinPOS-ODS-Setup-1.0.3.exe']);
    const version = async () => ((await h.call('GET', '/v1/downloads')).json.downloads as Array<{ id: string; version: string }>).find((d) => d.id === 'tiffin-ods')!.version;
    assert.equal(await version(), '1.0.3');
    assert.equal((await h.call('DELETE', '/v1/admin/downloads/tiffin-ods/1.0.3')).status, 403);
    assert.equal((await h.call('DELETE', '/v1/admin/downloads/tiffin-ods/1.0.3', { admin: true })).status, 200);
    assert.equal(await version(), '1.0.2');
    assert.equal(existsSync(join(files, 'tiffin-ods', 'TiffinPOS-ODS-Setup-1.0.3.exe')), false);
    // a rebuilt 1.0.1 uploaded again replaces the file and becomes the newest
    h.clock.t += 60_000;
    const again = randomBytes(2000);
    assert.equal((await upload(h, 'tiffin-ods', 'TiffinPOS-ODS-Setup-1.0.1.exe', again)).status, 200);
    assert.equal(await version(), '1.0.1');
    assert.ok(readFileSync(join(files, 'tiffin-ods', 'TiffinPOS-ODS-Setup-1.0.1.exe')).equals(again));
  } finally { await h.close(); cleanup(h.dir); cleanup(files); }
});

test('P8-05: no browser demo unless the cloud is started with one; the answer points to the Windows trial', async () => {
  const gh = fakeGitHub();
  const h = await startHub(undefined, undefined, undefined, { githubFetch: gh.f });
  try {
    const cookie = await signedIn(h);
    const look = await fetch(`${h.base}/v1/account/demo`, { headers: { cookie } });
    const j = (await look.json()) as { available: boolean; reason: string };
    assert.equal(j.available, false);
    assert.match(j.reason, /Windows app .* 30-day free trial/);
    const start = await fetch(`${h.base}/v1/account/demo`, { method: 'POST', headers: { cookie } });
    assert.equal(start.status, 503);
  } finally { await h.close(); cleanup(h.dir); }
});
