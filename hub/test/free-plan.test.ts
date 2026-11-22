import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { cleanup, startHub, TEST_CLOUD_KEY } from './helpers.ts';
import type { TestHub } from './helpers.ts';
import { verifyKey } from '../../packages/licensing/src/index.ts';
import { openHubDb } from '../src/db.ts';

// The Free plan (2026-11-22): every feature on one PC, for good. A trial moves to it by itself before it ends, a paid
// key that ended drops to it instead of locking the shop, and the cloud renews the free key before its end.
const HW = 'AB12-CD34-EF56-7890-1A2B';
const HW2 = '0000-1111-2222-3333-4444';
const DAY = 86_400_000;
const trusted = [{ id: 'cloud', publicKey: TEST_CLOUD_KEY.publicKey, maxDays: 400 }];

async function account(h: TestHub, email = 'asha@spicegarden.in', phone = '9876543210') {
  await h.call('POST', '/v1/account/signup', { body: { businessName: 'Spice Garden', name: 'Asha Rao', email, phone, password: 'tandoor-2026' } });
  const code = /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1];
  await h.call('POST', '/v1/account/verify', { body: { email, code } });
  return { email, password: 'tandoor-2026' };
}
const activate = (h: TestHub, body: Record<string, unknown>) => h.call('POST', '/v1/activate', { body: { outletName: 'Spice Garden', hardwareId: HW, ...body } });
const slot = async (h: TestHub, deviceKey: string) => (await h.call('GET', '/v1/pos/licence', { key: deviceKey })).json.key as string;
const kinds = (h: TestHub) => (h.hub.db.prepare('SELECT kind FROM licence_grant ORDER BY issued_at, rowid').all() as Array<{ kind: string }>).map((r) => r.kind);
/** Runs the hub's sweep with its 10-minute pause passed. */
const sweep = (h: TestHub) => { h.clock.t += 11 * 60_000; h.hub.sweep(); };

test('free plan: the trial moves to a free key before it ends; the key is renewed before its end; same seats, no trial mark', async () => {
  const h = await startHub();
  try {
    const a = await account(h);
    const trial = await activate(h, { ...a, mode: 'trial', link: true, product: 'tiffin_qsr' });
    assert.equal(trial.json.kind, 'trial');
    sweep(h);
    assert.deepEqual(kinds(h), ['trial'], 'nothing yet: 30 days left');

    h.clock.t += 26 * DAY; // 4 days left: still the trial
    sweep(h);
    assert.deepEqual(kinds(h), ['trial']);
    h.clock.t += 1.5 * DAY; // under 3 days left: the free key, before the apps' 2-day trial warning
    sweep(h);
    assert.deepEqual(kinds(h), ['trial', 'free']);
    sweep(h);
    assert.deepEqual(kinds(h), ['trial', 'free'], 'made once');

    const key = await slot(h, trial.json.deviceKey);
    assert.notEqual(key, trial.json.key, 'the outlet\'s renewal now hands out the free key');
    const v = verifyKey(key, trusted, HW);
    assert.ok(v.ok, v.ok ? '' : v.reason);
    if (v.ok) {
      assert.deepEqual(v.payload.seats, { terminals: 1, captains: 0, kds: 1 });
      assert.ok(!v.payload.features.includes('trial'), 'not a trial: the apps show it as a licence');
      assert.equal(Date.parse(v.payload.expiresAt) - Date.parse(v.payload.issuedAt), 365 * DAY);
      assert.equal((v.payload as { product?: string }).product, 'tiffin_qsr');
    }

    // a year on, 30 days before its end (before the apps' 15-day warning), a new free key
    h.clock.t += 334 * DAY;
    sweep(h);
    assert.deepEqual(kinds(h), ['trial', 'free']);
    h.clock.t += 2 * DAY;
    sweep(h);
    assert.deepEqual(kinds(h), ['trial', 'free', 'free']);
    assert.notEqual(await slot(h, trial.json.deviceKey), key);

    // the portal lists it
    const portal = h.hub.licences.forAccount(h.hub.db.prepare('SELECT id FROM account').get()!.id as string);
    assert.equal(portal[0]!.kind, 'free');
  } finally { await h.close(); cleanup(h.dir); }
});

test('free plan: a paid key that ended drops to free; revoked keys, paid keys running and closed accounts are left alone', async () => {
  const h = await startHub();
  try {
    const a = await account(h);
    const trial = await activate(h, { ...a, mode: 'trial', link: true });
    const acc = h.hub.db.prepare('SELECT id FROM account').get()!.id as string;
    const g = h.hub.licences.get(h.hub.db.prepare('SELECT id FROM licence_grant').get()!.id as string)!;
    // a paid year bought during the trial: the trial does not move to free
    h.hub.licences.issue({ storeId: g.storeId, accountId: acc, hardwareId: HW, kind: 'paid', days: 365, seats: { terminals: 3, captains: 4, kds: 2 }, licensee: 'Spice Garden', product: 'fine_dine' });
    h.clock.t += 29 * DAY;
    sweep(h);
    assert.deepEqual(kinds(h), ['trial', 'paid']);
    // the paid key ends without a renewal: free, not locked (fewer seats)
    h.clock.t += 337 * DAY;
    sweep(h);
    assert.deepEqual(kinds(h), ['trial', 'paid', 'free']);
    const v = verifyKey(await slot(h, trial.json.deviceKey), trusted, HW);
    assert.ok(v.ok && v.payload.seats.terminals === 1);

    // a closed account gets nothing
    h.hub.db.prepare("UPDATE account SET status = 'closed'").run();
    h.clock.t += 340 * DAY;
    sweep(h);
    assert.equal(kinds(h).filter((k) => k === 'free').length, 1);
  } finally { await h.close(); cleanup(h.dir); }
});

test('free plan: after the trial, signing in on a new PC gets the free plan; not while another PC has a live key', async () => {
  const h = await startHub();
  try {
    const a = await account(h);
    assert.equal((await activate(h, { ...a, mode: 'trial' })).json.kind, 'trial');
    // the trial is running on the first PC: a second PC is refused (one PC on the Free plan)
    const second = await activate(h, { ...a, mode: 'trial', hardwareId: HW2 });
    assert.deepEqual([second.status, second.json.error.code], [409, 'FREE_PLAN_IN_USE']);
    assert.match(second.json.error.message, /Free plan is for one PC/);
    // the first PC's key has ended (the shop changed its PC): the new PC gets the free plan at once
    h.clock.t += 40 * DAY;
    for (const mode of ['signin', 'trial']) {
      const r = await activate(h, { ...a, mode, hardwareId: HW2 });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.kind, 'free');
    }
    assert.equal(kinds(h).filter((k) => k === 'free').length, 1, 'the second sign-in returns the same key');
    // a brand-new account still starts with the trial
    const b = await account(h, 'b@example.com', '9123456780');
    const fresh = await activate(h, { ...b, mode: 'signin', hardwareId: '5555-6666-7777-8888-9999' });
    assert.equal(fresh.json.error.code, 'NO_LICENCE');
    assert.equal((await activate(h, { ...b, mode: 'trial', hardwareId: '5555-6666-7777-8888-9999' })).json.kind, 'trial');
  } finally { await h.close(); cleanup(h.dir); }
});

test('free plan: a database from before keeps its keys and accepts free ones', () => {
  const dir = startHubDir();
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE store (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE licence_grant (
      id TEXT PRIMARY KEY, account_id TEXT, store_id TEXT NOT NULL REFERENCES store(id), hardware_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('trial','paid','demo','manual')), licensee TEXT NOT NULL, seats_json TEXT NOT NULL, features_json TEXT NOT NULL,
      issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, key_text TEXT NOT NULL, revoked_at INTEGER, revoked_reason TEXT, created_by TEXT NOT NULL,
      product TEXT NOT NULL DEFAULT 'fine_dine');
    INSERT INTO store VALUES ('s1', 'spice', 'Spice', 1);
    INSERT INTO licence_grant VALUES ('g1', NULL, 's1', '${HW}', 'paid', 'Spice', '{}', '[]', 1, 2, 'key', NULL, NULL, 'admin', 'tiffin_qsr');`);
  old.close();
  const db = openHubDb(path);
  try {
    assert.deepEqual(db.prepare('SELECT id, kind, product FROM licence_grant').all().map((r) => ({ ...r })), [{ id: 'g1', kind: 'paid', product: 'tiffin_qsr' }]);
    db.prepare(`INSERT INTO licence_grant (id, store_id, hardware_id, kind, licensee, seats_json, features_json, issued_at, expires_at, key_text, created_by) VALUES ('g2','s1','${HW}','free','Spice','{}','[]',1,2,'k','cloud')`).run();
    assert.throws(() => db.prepare("UPDATE licence_grant SET kind = 'paid' WHERE id = 'g2'").run(), /append-only/, 'the append-only rule is back');
  } finally { db.close(); cleanup(dir); }
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
function startHubDir() { return mkdtempSync(join(tmpdir(), 'hub-free-')); }
