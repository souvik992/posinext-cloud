import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, startHub, TEST_CLOUD_KEY } from './helpers.ts';
import type { TestHub } from './helpers.ts';
import { verifyKey } from '../../packages/licensing/src/index.ts';

// P7-03, P8-02: the Windows app (DinePOS or Tiffin POS) activating on a PC with the account's email and password.
const HW = 'AB12-CD34-EF56-7890-1A2B';
const HW2 = '0000-1111-2222-3333-4444';
const trusted = [{ id: 'cloud', publicKey: TEST_CLOUD_KEY.publicKey, maxDays: 400 }];

async function account(h: TestHub, email = 'asha@spicegarden.in', phone = '9876543210') {
  await h.call('POST', '/v1/account/signup', { body: { businessName: 'Spice Garden', name: 'Asha Rao', email, phone, password: 'tandoor-2026' } });
  const code = /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1];
  await h.call('POST', '/v1/account/verify', { body: { email, code } });
  return { email, password: 'tandoor-2026' };
}
const activate = (h: TestHub, body: Record<string, unknown>) => h.call('POST', '/v1/activate', { body: { outletName: 'Spice Garden Salt Lake', hardwareId: HW, ...body } });

test('activation: a trial gives a 30-day cloud key for this PC, makes the account’s outlet and links it to the cloud', async () => {
  const h = await startHub();
  try {
    const a = await account(h);
    const r = await activate(h, { ...a, mode: 'trial', link: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.kind, 'trial');
    assert.match(r.json.store.slug, /^spice-garden-salt-lake-\d{4}$/);
    assert.equal(r.json.store.name, 'Spice Garden Salt Lake');
    const v = verifyKey(r.json.key, trusted, HW);
    assert.ok(v.ok, v.ok ? '' : v.reason);
    if (v.ok) {
      assert.deepEqual(v.payload.seats, { terminals: 1, captains: 1, kds: 1 });
      assert.equal(Date.parse(v.payload.expiresAt) - Date.parse(v.payload.issuedAt), 30 * 86_400_000);
      assert.equal((v.payload as { product?: string }).product, 'fine_dine', 'an app that does not say is DinePOS');
      assert.equal(v.payload.licensee, 'Spice Garden');
    }
    // the device key works for this cloud (renewals come down the licence slot)
    const slot = await h.call('GET', '/v1/pos/licence', { key: r.json.deviceKey });
    assert.equal(slot.json.key, r.json.key);
    // the portal shows the outlet; the account is now on trial
    const st = h.hub.db.prepare('SELECT a.status, COUNT(s.store_id) AS n FROM account a LEFT JOIN account_store s ON s.account_id = a.id').get() as { status: string; n: number };
    assert.deepEqual([st.status, st.n], ['trial', 1]);
    // signing in again on the same PC (after a reinstall) returns the same key and outlet, without a second trial
    const again = await activate(h, { ...a, mode: 'signin' });
    assert.deepEqual([again.status, again.json.key, again.json.store.slug, again.json.deviceKey], [200, r.json.key, r.json.store.slug, null]);
    const trialAgain = await activate(h, { ...a, mode: 'trial' });
    assert.equal(trialAgain.json.key, r.json.key, 'asking for a trial again on the same PC gives the key it has');
  } finally { await h.close(); cleanup(h.dir); }
});

test('activation: one trial per PC, per email and per mobile', async () => {
  const h = await startHub();
  try {
    const a = await account(h);
    assert.equal((await activate(h, { ...a, mode: 'trial' })).status, 200);
    // same account, another PC: the email has had its trial
    const otherPc = await activate(h, { ...a, mode: 'trial', hardwareId: HW2 });
    assert.deepEqual([otherPc.status, otherPc.json.error.code, otherPc.json.error.details.claim], [409, 'TRIAL_USED', 'email']);
    assert.match(otherPc.json.error.message, /This email has already had a free DinePOS trial/);
    // another account on the same PC
    const b = await account(h, 'b@example.com', '9123456780');
    const samePc = await activate(h, { ...b, mode: 'trial' });
    assert.deepEqual([samePc.json.error.code, samePc.json.error.details.claim], ['TRIAL_USED', 'hardware']);
    // another account, another PC, the same mobile
    const c = await account(h, 'c@example.com', '+91 98765 43210');
    const samePhone = await activate(h, { ...c, mode: 'trial', hardwareId: HW2 });
    assert.deepEqual([samePhone.json.error.code, samePhone.json.error.details.claim], ['TRIAL_USED', 'phone']);
    // a fresh account, PC and mobile still can
    const d = await account(h, 'd@example.com', '9000000001');
    assert.equal((await activate(h, { ...d, mode: 'trial', hardwareId: '5555-6666-7777-8888-9999' })).status, 200);
  } finally { await h.close(); cleanup(h.dir); }
});

test('activation: each product has its own trial; keys say their product; a Tiffin POS key is not a DinePOS key', async () => {
  const h = await startHub();
  try {
    const a = await account(h);
    const dine = await activate(h, { ...a, mode: 'trial', product: 'fine_dine' });
    assert.equal(dine.status, 200, JSON.stringify(dine.json));
    // the same account, PC and mobile can still try the other product
    const qsr = await activate(h, { ...a, mode: 'trial', product: 'tiffin_qsr', outletName: 'Spice Garden Express' });
    assert.equal(qsr.status, 200, JSON.stringify(qsr.json));
    assert.equal(qsr.json.product, 'tiffin_qsr');
    assert.notEqual(qsr.json.key, dine.json.key);
    assert.notEqual(qsr.json.store.slug, dine.json.store.slug, 'each product has its own outlet for the PC');
    const parse = (k: string) => JSON.parse(Buffer.from(k.split('.')[0]!, 'base64url').toString()) as { product: string; seats: unknown; expiresAt: string; issuedAt: string };
    assert.deepEqual([parse(qsr.json.key).product, parse(qsr.json.key).seats], ['tiffin_qsr', { terminals: 1, captains: 0, kds: 1 }]);
    assert.equal(Date.parse(parse(qsr.json.key).expiresAt) - Date.parse(parse(qsr.json.key).issuedAt), 30 * 86_400_000);
    // signing in returns each product's own key
    assert.equal((await activate(h, { ...a, mode: 'signin', product: 'tiffin_qsr' })).json.key, qsr.json.key);
    assert.equal((await activate(h, { ...a, mode: 'signin' })).json.key, dine.json.key);
    // a second Tiffin trial is refused, naming the product
    const again = await activate(h, { ...a, mode: 'trial', product: 'tiffin_qsr', hardwareId: HW2 });
    assert.deepEqual([again.status, again.json.error.code], [409, 'TRIAL_USED']);
    assert.match(again.json.error.message, /free Tiffin POS trial/);
    // an unknown product is refused before anything is claimed
    assert.equal((await activate(h, { ...a, mode: 'trial', product: 'pizza_pos' })).status, 400);
    const claims = h.hub.db.prepare('SELECT product, COUNT(*) AS n FROM trial_claim GROUP BY product ORDER BY product').all();
    assert.deepEqual(claims.map((r) => [r.product, r.n]), [['fine_dine', 3], ['tiffin_qsr', 3]]);
    const grants = h.hub.db.prepare('SELECT product FROM licence_grant ORDER BY product').all();
    assert.deepEqual(grants.map((r) => r.product), ['fine_dine', 'tiffin_qsr']);
    // P8-07: the portal lists the account's keys (newest first), with the outlet, seats and end date
    const login = await fetch(`${h.base}/v1/account/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a) });
    const cookie = String(login.headers.get('set-cookie')).split(';')[0]!;
    const list = (await (await fetch(`${h.base}/v1/account/licences`, { headers: { cookie } })).json()) as { licences: Array<Record<string, unknown>> };
    assert.deepEqual(list.licences.map((l) => [l.product, l.kind, l.hardwareId, l.revoked]).sort(), [['fine_dine', 'trial', HW, false], ['tiffin_qsr', 'trial', HW, false]]);
    const q = list.licences.find((l) => l.product === 'tiffin_qsr')!;
    assert.deepEqual([q.outlet, q.key, q.seats], ['Spice Garden Express', qsr.json.key, { terminals: 1, captains: 0, kds: 1 }]);
    assert.equal((await fetch(`${h.base}/v1/account/licences`)).status, 401);
  } finally { await h.close(); cleanup(h.dir); }
});

test('activation: wrong password, unverified email, no licence yet, bad hardware id', async () => {
  const h = await startHub();
  try {
    const a = await account(h);
    const wrong = await activate(h, { email: a.email, password: 'nope-nope', mode: 'trial' });
    assert.deepEqual([wrong.status, wrong.json.error.code], [401, 'BAD_LOGIN']);
    await h.call('POST', '/v1/account/signup', { body: { businessName: 'X', name: 'X', email: 'new@example.com', phone: '9111111111', password: 'tandoor-2026' } });
    const unverified = await activate(h, { email: 'new@example.com', password: 'tandoor-2026', mode: 'trial' });
    assert.deepEqual([unverified.status, unverified.json.error.code], [403, 'EMAIL_NOT_VERIFIED']);
    const none = await activate(h, { ...a, mode: 'signin' });
    assert.deepEqual([none.status, none.json.error.code], [404, 'NO_LICENCE']);
    assert.match(none.json.error.message, /Start the free trial/);
    assert.equal((await activate(h, { ...a, mode: 'trial', hardwareId: 'my-pc' })).status, 400);
    assert.equal(h.hub.db.prepare('SELECT COUNT(*) AS n FROM trial_claim').get()!.n, 0, 'nothing claimed by refused tries');
  } finally { await h.close(); cleanup(h.dir); }
});

test('activation: an admin trial reset lets the 30-day trial start again (the old trial key revoked; paid keys and other products untouched)', async () => {
  const h = await startHub();
  try {
    const a = await account(h);
    const first = await activate(h, { ...a, mode: 'trial' });
    assert.equal(first.status, 200);
    const tiffin = await activate(h, { ...a, mode: 'trial', product: 'tiffin_qsr' });
    assert.equal(tiffin.status, 200);
    assert.equal((await activate(h, { ...a, mode: 'trial' })).status, 200, 'same PC: the same trial key comes back');
    assert.equal((await activate(h, { ...a, mode: 'trial', hardwareId: HW2 })).json.error.code, 'TRIAL_USED');

    // admin key needed; unknown email refused
    assert.equal((await h.call('POST', '/v1/admin/trials/reset', { body: { email: a.email } })).status, 403);
    assert.equal((await h.call('POST', '/v1/admin/trials/reset', { admin: true, body: { email: 'nobody@example.com' } })).status, 404);
    assert.equal((await h.call('POST', '/v1/admin/trials/reset', { admin: true, body: {} })).status, 400);

    // reset DinePOS only
    h.clock.t += 5 * 86_400_000;
    const r = await h.call('POST', '/v1/admin/trials/reset', { admin: true, body: { email: a.email, product: 'fine_dine' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.revokedKeys, r.json.products], [1, ['fine_dine']]);
    assert.ok(r.json.clearedClaims >= 3, 'hardware, email and mobile');
    // the app's sign-in no longer finds the old key; a new trial starts with a fresh 30 days
    assert.equal((await activate(h, { ...a, mode: 'signin' })).json.error.code, 'NO_LICENCE');
    const again = await activate(h, { ...a, mode: 'trial' });
    assert.equal(again.status, 200);
    assert.notEqual(again.json.key, first.json.key);
    assert.equal(again.json.expiresAt, h.clock.t + 30 * 86_400_000);
    const lic = (await h.call('GET', '/v1/admin/stores/' + first.json.store.slug + '/grants', { admin: true })).json.grants as Array<{ key: string; revokedReason: string | null }>;
    assert.equal(lic.find((g) => g.key === first.json.key)!.revokedReason, 'trial reset by admin');
    // Tiffin POS was not reset: its trial is still used
    assert.equal((await activate(h, { ...a, mode: 'trial', product: 'tiffin_qsr', hardwareId: HW2 })).json.error.code, 'TRIAL_USED');

    // a PC on its own (another account used it): only that PC's record goes
    const b = await account(h, 'ravi@chaipoint.in', '9811122233');
    assert.equal((await activate(h, { ...b, mode: 'trial', product: 'tiffin_qsr', hardwareId: HW })).json.error.code, 'TRIAL_USED', 'this PC had a Tiffin trial');
    const pc = await h.call('POST', '/v1/admin/trials/reset', { admin: true, body: { hardwareId: HW, product: 'tiffin_qsr' } });
    assert.equal(pc.status, 200);
    assert.equal((await activate(h, { ...b, mode: 'trial', product: 'tiffin_qsr', hardwareId: HW })).status, 200);
    assert.equal((await h.call('POST', '/v1/admin/trials/reset', { admin: true, body: { hardwareId: 'not-an-id' } })).status, 400);
  } finally { await h.close(); cleanup(h.dir); }
});
