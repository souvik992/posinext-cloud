import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec, many, one } from '../src/db.ts';
import { cleanup, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

// The admin page: deleting a customer account, and the UrbanPiper activity log a page at a time.

const HW = 'AB12-CD34-EF56-7890-1A2B';
async function account(h: TestHub, email = 'asha@spicegarden.in', phone = '9876543210') {
  await h.call('POST', '/v1/account/signup', { body: { businessName: 'Spice Garden', name: 'Asha Rao', email, phone, password: 'tandoor-2026' } });
  const code = /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1];
  await h.call('POST', '/v1/account/verify', { body: { email, code } });
  return { email, password: 'tandoor-2026' };
}

test('delete account: people and sign-ins go; outlets are unlinked; keys are kept unless asked; no second trial', async () => {
  const h = await startHub();
  try {
    const a = await account(h);
    const act = await h.call('POST', '/v1/activate', { body: { ...a, outletName: 'Spice Garden Salt Lake', hardwareId: HW, mode: 'trial', link: true } });
    assert.equal(act.status, 200, JSON.stringify(act.json));
    const listed = (await h.call('GET', '/v1/admin/accounts', { admin: true })).json.accounts;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].activeKeys, 1);
    assert.equal(listed[0].stores, 1);
    const id = listed[0].id as string;
    const user = one<{ id: string }>(h.hub.db, 'SELECT id FROM account_user WHERE account_id = ?', id)!;
    exec(h.hub.db, "INSERT INTO account_session (token_hash, user_id, expires_at, created_at, last_used_at) VALUES ('x', ?, ?, 0, 0)", user.id, Date.now() * 2);

    assert.equal((await h.call('POST', `/v1/admin/accounts/${id}/delete`, { body: {} })).status, 403, 'admin key needed');
    const r = await h.call('POST', `/v1/admin/accounts/${id}/delete`, { admin: true, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { deleted: true, people: 1, outlets: 1, revokedKeys: 0 });

    assert.equal((await h.call('GET', '/v1/admin/accounts', { admin: true })).json.accounts.length, 0, 'not listed any more');
    assert.equal(one(h.hub.db, 'SELECT 1 FROM account_user WHERE account_id = ?', id), undefined);
    assert.equal(one(h.hub.db, 'SELECT 1 FROM account_session WHERE user_id = ?', user.id), undefined);
    assert.deepEqual({ ...one<{ name: string; phone: string; status: string }>(h.hub.db, 'SELECT name, phone, status FROM account WHERE id = ?', id) }, { name: 'Deleted account', phone: '', status: 'deleted' });
    assert.equal(many(h.hub.db, 'SELECT 1 FROM licence_grant WHERE account_id = ? AND revoked_at IS NULL', id).length, 1, 'the key still works');
    assert.equal((await h.call('POST', '/v1/account/login', { body: a })).json.error.code, 'BAD_LOGIN');
    assert.equal((await h.call('POST', `/v1/admin/accounts/${id}/delete`, { admin: true, body: {} })).status, 404, 'once only');

    // the email can sign up again, but the free trial was used: the Free plan instead (2026-11-22)
    await account(h);
    const again = await h.call('POST', '/v1/activate', { body: { ...a, outletName: 'Spice Garden Salt Lake', hardwareId: HW, mode: 'trial' } });
    assert.deepEqual([again.status, again.json.kind], [200, 'free']);

    // revokeKeys: the keys in use stop working
    const second = (await h.call('GET', '/v1/admin/accounts', { admin: true })).json.accounts[0];
    const b = await account(h, 'other@example.com', '9123456780');
    const act2 = await h.call('POST', '/v1/activate', { body: { ...b, outletName: 'Other Cafe', hardwareId: '0000-1111-2222-3333-4444', mode: 'trial', link: true } });
    assert.equal(act2.status, 200, JSON.stringify(act2.json));
    const other = (await h.call('GET', '/v1/admin/accounts', { admin: true })).json.accounts.find((x: { owner: { email: string } }) => x.owner.email === 'other@example.com');
    const r2 = await h.call('POST', `/v1/admin/accounts/${other.id}/delete`, { admin: true, body: { revokeKeys: true } });
    assert.equal(r2.json.revokedKeys, 1);
    assert.equal(many(h.hub.db, 'SELECT 1 FROM licence_grant WHERE account_id = ? AND revoked_at IS NULL', other.id).length, 0);
    assert.ok(second, 'the re-signed-up account is listed');
  } finally { await h.close(); cleanup(h.dir); }
});

test('UrbanPiper log: the views show the newest 20 and the total; the admin pages through the rest', async () => {
  const h = await startHub();
  try {
    for (let i = 1; i <= 45; i++) exec(h.hub.db, "INSERT INTO up_log (store_id, at, dir, kind, ok, text) VALUES (NULL, ?, 'out', 'test', 1, ?)", i, `line ${i}`);
    const view = (await h.call('GET', '/v1/admin/urbanpiper', { admin: true })).json;
    assert.equal(view.log.length, 20);
    assert.equal(view.logTotal, 45);
    assert.equal(view.log[0].text, 'line 45', 'newest first');
    const p3 = (await h.call('GET', '/v1/admin/urbanpiper/log?page=3&size=20', { admin: true })).json;
    assert.deepEqual([p3.page, p3.pages, p3.total, p3.log.length, p3.log[0].text, p3.log.at(-1).text], [3, 3, 45, 5, 'line 5', 'line 1']);
    assert.equal((await h.call('GET', '/v1/admin/urbanpiper/log?page=99', { admin: true })).json.page, 3, 'past the end: the last page');
    assert.equal((await h.call('GET', '/v1/admin/urbanpiper/log?store=nope', { admin: true })).status, 404);
    assert.equal((await h.call('GET', '/v1/admin/urbanpiper/log')).status, 403);
  } finally { await h.close(); cleanup(h.dir); }
});
