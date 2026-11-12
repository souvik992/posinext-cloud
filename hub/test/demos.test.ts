import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, startHub, TEST_CLOUD_KEY } from './helpers.ts';
import type { TestHub } from './helpers.ts';
import type { DemoHost, DemoSeed } from '../src/demos.ts';
import { verifyKey } from '../../packages/licensing/src/index.ts';

// P7-04: the browser demo. A stand-in for the hosted outlet's DinePOS server records what the cloud sends it and
// checks the licence key with the DinePOS verifier (the real bundle trusts only the embedded keys).
const HW = 'DE30-0000-0000-0000-0001';
const SEED: DemoSeed = {
  setup: { type: 'SetupOutlet', payload: { outletName: 'Spice Garden (demo)', ownerId: 'OWNER', ownerName: 'Asha (Owner)', pin: '1234' } },
  commands: [
    { type: 'UpsertArea', payload: { id: 'A1', name: 'Main' } },
    { type: 'UpsertTable', payload: { id: 'T1', areaId: 'A1', name: 'T1' } },
    { type: 'UpsertUser', payload: { id: 'CASHIER', name: 'Meena (Cashier)', pin: '1111' } },
  ],
  owner: { id: 'OWNER', name: 'Asha (Owner)', pin: '1234' },
  staff: [{ id: 'CASHIER', name: 'Meena (Cashier)', pin: '1111' }],
};
const TOKEN = `dvt_${'x'.repeat(40)}`;
const trusted = [{ id: 'cloud', publicKey: TEST_CLOUD_KEY.publicKey, maxDays: 400 }];

function fakeHost(o: { failOn?: string } = {}) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const removed: string[] = [];
  let installed: string | null = null;
  const ok = (json: unknown) => ({ status: 200, json });
  const host: DemoHost = {
    available: true,
    enable: () => ({ port: 1 }),
    ready: async () => true,
    remove: async (slug) => { removed.push(slug); },
    async call(_storeId, method, path, body, headers = {}) {
      const b = (body ?? {}) as Record<string, unknown>;
      if (method === 'POST' && path === '/v1/commands') {
        const type = String(b.type);
        const payload = b.payload as Record<string, unknown>;
        if (type === o.failOn) return { status: 500, json: { ok: false, error: { code: 'INTERNAL', message: 'boom' } } };
        if (type !== 'SetupOutlet' && headers['x-user-session'] !== 'owner-session') return { status: 401, json: { ok: false, error: { code: 'UNAUTHENTICATED' } } };
        if (type === 'InstallLicence') {
          const v = verifyKey(String(payload.key), trusted, HW);
          if (!v.ok) return { status: 400, json: { ok: false, error: { code: 'VALIDATION', message: v.reason } } };
          installed = String(payload.key);
        }
        if (type !== 'SetupOutlet' && type !== 'InstallLicence' && !installed) return { status: 409, json: { ok: false, error: { code: 'DAY_CLOSED' } } };
        sent.push({ type, payload });
        return ok({ ok: true, result: {} });
      }
      if (method === 'POST' && path === '/v1/sessions') return b.pin === '1234' ? ok({ token: 'owner-session' }) : { status: 401, json: { error: { code: 'WRONG_PIN' } } };
      if (method === 'GET' && path === '/v1/licence') return ok({ hardwareId: HW });
      if (method === 'POST' && path === '/v1/pairing-requests') return ok({ requestId: 'R1', secret: 'S1', code: '123456' });
      if (method === 'POST' && path === '/v1/pairing-requests/R1/collect') return ok(sent.some((c) => c.type === 'PairDevice') ? { status: 'paired', deviceToken: TOKEN } : { status: 'pending' });
      if (method === 'DELETE' && path === '/v1/session') return ok({ ok: true });
      return { status: 404, json: { error: { code: 'NOT_FOUND' } } };
    },
  };
  return { host, sent, removed, installed: () => installed };
}

/** A browser signed in to the portal (its cookie kept). */
async function signedIn(h: TestHub, email = 'asha@spicegarden.in') {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const r = await fetch(h.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = /^((?:__Host-)?dp_account=[^;]*)/.exec(set)![1]!;
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  await call('POST', '/v1/account/signup', { businessName: 'Spice Garden', name: 'Asha Rao', email, phone: '9876543210', password: 'tandoor-2026' });
  const code = /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1];
  await call('POST', '/v1/account/verify', { email, code });
  return call;
}

const start = (fake: ReturnType<typeof fakeHost>, max = 10) =>
  startHub(undefined, undefined, undefined, { deviceDomain: 'cloud.test', publicUrl: 'https://cloud.test', demo: { seed: SEED, max, host: fake.host } });

test('demos: a signed-in visitor gets a ready, licensed, seeded demo with a paired terminal; asking again returns the same one', async () => {
  const fake = fakeHost();
  const h = await start(fake);
  try {
    const call = await signedIn(h);
    const before = await call('GET', '/v1/account/demo');
    assert.deepEqual([before.json.demo, before.json.available], [null, true]);
    const r = await call('POST', '/v1/account/demo');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.state, 'ready');
    assert.match(r.json.slug, /^demo-[a-z0-9]{6}$/);
    assert.equal(r.json.url, `https://${r.json.slug}.cloud.test/pos/#device=${TOKEN}`);
    assert.deepEqual(r.json.staff, [{ name: 'Asha (Owner)', pin: '1234' }, { name: 'Meena (Cashier)', pin: '1111' }]);
    assert.equal(r.json.expiresAt - h.clock.t, 72 * 3_600_000);
    // setup (named after the business), licence, the sample outlet, then the terminal paired with the owner's PIN
    assert.deepEqual(fake.sent.map((c) => c.type), ['SetupOutlet', 'InstallLicence', 'UpsertArea', 'UpsertTable', 'UpsertUser', 'PairDevice']);
    assert.equal(fake.sent[0]!.payload.outletName, 'Spice Garden (demo)');
    // the licence: signed by this cloud (3 days), recorded as a demo grant, accepted by the DinePOS verifier
    const v = verifyKey(fake.installed()!, trusted, HW);
    assert.ok(v.ok);
    if (v.ok) assert.equal(Date.parse(v.payload.expiresAt) - Date.parse(v.payload.issuedAt), 3 * 86_400_000);
    const grants = h.hub.db.prepare('SELECT kind FROM licence_grant').all() as Array<{ kind: string }>;
    assert.deepEqual(grants.map((x) => x.kind), ['demo']);
    // the same demo again (no second outlet), and the portal shows it
    const again = await call('POST', '/v1/account/demo');
    assert.equal(again.json.slug, r.json.slug);
    assert.equal((await call('GET', '/v1/account/demo')).json.demo.slug, r.json.slug);
    assert.equal(fake.sent.filter((c) => c.type === 'SetupOutlet').length, 1);
    // the admin page lists it
    const adm = await h.call('GET', '/v1/admin/demos', { admin: true });
    assert.deepEqual([adm.json.demos.length, adm.json.demos[0].state, adm.json.demos[0].email], [1, 'ready', 'asha@spicegarden.in']);
  } finally { await h.close(); cleanup(h.dir); }
});

test('demos: only for a signed-in person; ends after 72 hours with its data; a failed build is cleaned up', async () => {
  const fake = fakeHost();
  const h = await start(fake);
  try {
    assert.equal((await fetch(`${h.base}/v1/account/demo`, { method: 'POST' })).status, 401);
    const call = await signedIn(h);
    const r = (await call('POST', '/v1/account/demo')).json;
    h.clock.t += 71 * 3_600_000;
    assert.equal(await h.demos!.sweep(), 0);
    h.clock.t += 2 * 3_600_000;
    assert.equal(await h.demos!.sweep(), 1);
    assert.deepEqual(fake.removed, [r.slug]);
    assert.equal((await call('GET', '/v1/account/demo')).json.demo, null);
    const row = h.hub.db.prepare('SELECT state, device_token FROM demo').get() as { state: string; device_token: string | null };
    assert.deepEqual([row.state, row.device_token], ['ended', null]);
  } finally { await h.close(); cleanup(h.dir); }
  const broken = fakeHost({ failOn: 'UpsertTable' });
  const h2 = await start(broken);
  try {
    const call = await signedIn(h2);
    const r = await call('POST', '/v1/account/demo');
    assert.deepEqual([r.status, r.json.error.code], [502, 'DEMO_FAILED']);
    assert.equal(broken.removed.length, 1, 'the half-made outlet is removed');
    assert.equal((h2.hub.db.prepare('SELECT state FROM demo').get() as { state: string }).state, 'failed');
  } finally { await h2.close(); cleanup(h2.dir); }
});

test('demos: at the cap the visitor is pointed to the Windows trial; 3 per account; not set up gives a clear reason', async () => {
  const fake = fakeHost();
  const h = await start(fake, 1);
  try {
    const a = await signedIn(h, 'a@example.com');
    const b = await signedIn(h, 'b@example.com');
    assert.equal((await a('POST', '/v1/account/demo')).status, 200);
    const full = await b('POST', '/v1/account/demo');
    assert.deepEqual([full.status, full.json.error.code], [503, 'DEMO_FULL']);
    assert.match(full.json.error.message, /Windows trial/);
    // per account: after 3 demos (each ended), no more
    for (let i = 0; i < 2; i++) {
      h.clock.t += 73 * 3_600_000;
      await h.demos!.sweep();
      assert.equal((await a('POST', '/v1/account/demo')).status, 200);
    }
    h.clock.t += 73 * 3_600_000;
    await h.demos!.sweep();
    const limit = await a('POST', '/v1/account/demo');
    assert.deepEqual([limit.status, limit.json.error.code], [409, 'DEMO_LIMIT']);
  } finally { await h.close(); cleanup(h.dir); }
  const h2 = await startHub(undefined, undefined, undefined, { deviceDomain: 'cloud.test', demo: { seed: null, host: fakeHost().host } });
  try {
    const call = await signedIn(h2);
    const r = await call('GET', '/v1/account/demo');
    assert.deepEqual([r.json.available, r.json.reason], [false, 'The browser demo is not set up on this cloud (no demo-seed.json).']);
    assert.equal((await call('POST', '/v1/account/demo')).status, 503);
  } finally { await h2.close(); cleanup(h2.dir); }
});
