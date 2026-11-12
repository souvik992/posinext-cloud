import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { createHubServer } from '../src/http.ts';
import { checkPassword, hashPassword, normalisePhone } from '../src/accounts.ts';
import { logMailer } from '../src/mailer.ts';

/** A browser for the portal: keeps the account cookie between calls. */
function browser(h: TestHub) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const r = await fetch(h.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) { const v = /^dp_account=([^;]*)/.exec(set)?.[1] ?? ''; cookie = v ? `dp_account=${v}` : ''; }
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null, setCookie: set };
  };
  return { call, get cookie() { return cookie; }, set cookie(v: string) { cookie = v; } };
}

const SIGNUP = { businessName: 'Spice Garden', name: 'Asha Rao', email: 'Asha@SpiceGarden.in', phone: '98765 43210', password: 'tandoor-2026' };
const lastCode = (h: TestHub) => /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1]!;

async function signedUp(h: TestHub, b = browser(h), o: Partial<typeof SIGNUP> = {}) {
  const r = await b.call('POST', '/v1/account/signup', { ...SIGNUP, ...o });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const v = await b.call('POST', '/v1/account/verify', { email: r.json.email, code: lastCode(h) });
  assert.equal(v.status, 200, JSON.stringify(v.json));
  return b;
}

test('accounts: sign up → emailed code → verified and signed in; the portal shows the account', async () => {
  const h = await startHub();
  try {
    const b = browser(h);
    const r = await b.call('POST', '/v1/account/signup', SIGNUP);
    assert.deepEqual(r.json, { email: 'asha@spicegarden.in', verify: true });
    assert.equal(h.mail.length, 1);
    assert.equal(h.mail[0]!.to, 'asha@spicegarden.in');
    assert.match(h.mail[0]!.text, /\b\d{6}\b/);
    const v = await b.call('POST', '/v1/account/verify', { email: 'ASHA@spicegarden.in ', code: lastCode(h) });
    assert.equal(v.status, 200);
    assert.match(v.setCookie!, /^dp_account=dpa_[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000$/);
    assert.equal(v.json.token, undefined, 'the token is only in the HttpOnly cookie');
    const me = await b.call('GET', '/v1/account/me');
    assert.equal(me.status, 200);
    assert.deepEqual([me.json.user.email, me.json.user.name, me.json.user.role], ['asha@spicegarden.in', 'Asha Rao', 'owner']);
    assert.deepEqual([me.json.account.name, me.json.account.phone, me.json.account.status], ['Spice Garden', '+919876543210', 'new']);
    // a used code cannot be used again
    const again = await browser(h).call('POST', '/v1/account/verify', { email: SIGNUP.email, code: lastCode(h) });
    assert.equal(again.status, 400);
    // log out ends the session
    assert.equal((await b.call('POST', '/v1/account/logout')).status, 200);
    assert.equal(b.cookie, '');
    assert.equal((await b.call('GET', '/v1/account/me')).status, 401);
    // sign in again; the admin page lists the account
    const li = await b.call('POST', '/v1/account/login', { email: SIGNUP.email, password: SIGNUP.password });
    assert.equal(li.status, 200);
    assert.equal((await b.call('GET', '/v1/account/me')).status, 200);
    const adm = await h.call('GET', '/v1/admin/accounts', { admin: true });
    assert.equal(adm.json.accounts.length, 1);
    assert.deepEqual(adm.json.accounts[0].owner, { email: 'asha@spicegarden.in', name: 'Asha Rao', verified: true });
    assert.equal((await h.call('GET', '/v1/admin/accounts')).status, 403);
  } finally { await h.close(); cleanup(h.dir); }
});

test('accounts: a duplicate email is refused (any letter case)', async () => {
  const h = await startHub();
  try {
    await signedUp(h);
    const dup = await browser(h).call('POST', '/v1/account/signup', { ...SIGNUP, email: 'asha@spicegarden.IN', businessName: 'Another' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'EMAIL_TAKEN');
    // also while the first sign-up is still unverified
    await browser(h).call('POST', '/v1/account/signup', { ...SIGNUP, email: 'new@example.com' });
    const dup2 = await browser(h).call('POST', '/v1/account/signup', { ...SIGNUP, email: 'new@example.com' });
    assert.equal(dup2.status, 409);
    const n = h.hub.db.prepare('SELECT COUNT(*) AS n FROM account').get() as { n: number };
    assert.equal(n.n, 2);
  } finally { await h.close(); cleanup(h.dir); }
});

test('accounts: an unverified person gets no session and cannot reach the portal', async () => {
  const h = await startHub();
  try {
    const b = browser(h);
    await b.call('POST', '/v1/account/signup', SIGNUP);
    assert.equal(b.cookie, '');
    assert.equal((await b.call('GET', '/v1/account/me')).status, 401);
    const li = await b.call('POST', '/v1/account/login', { email: SIGNUP.email, password: SIGNUP.password });
    assert.equal(li.status, 403);
    assert.equal(li.json.error.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(li.setCookie, null);
    assert.equal(h.mail.length, 2, 'signing in sends a fresh code');
    assert.equal((await b.call('GET', '/v1/account/me')).status, 401);
    // a session row for an unverified person (should never exist) is still refused
    const uid = (h.hub.db.prepare('SELECT id FROM account_user').get() as { id: string }).id;
    h.hub.db.prepare("INSERT INTO account_session (token_hash, user_id, expires_at, created_at, last_used_at) VALUES (?,?,?,?,?)").run((await import('../src/db.ts')).hash('dpa_forged'), uid, h.clock.t + 1e9, h.clock.t, h.clock.t);
    b.cookie = 'dp_account=dpa_forged';
    assert.equal((await b.call('GET', '/v1/account/me')).status, 401);
    // wrong password: the same answer as an unknown email
    const wrong = await browser(h).call('POST', '/v1/account/login', { email: SIGNUP.email, password: 'nope-nope' });
    const unknown = await browser(h).call('POST', '/v1/account/login', { email: 'nobody@example.com', password: 'nope-nope' });
    assert.deepEqual([wrong.status, wrong.json.error], [unknown.status, unknown.json.error]);
  } finally { await h.close(); cleanup(h.dir); }
});

test('accounts: 5 wrong codes lock that code; a new code works; codes expire after 10 minutes', async () => {
  const h = await startHub();
  try {
    const b = browser(h);
    await b.call('POST', '/v1/account/signup', SIGNUP);
    const good = lastCode(h);
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      const r = await b.call('POST', '/v1/account/verify', { email: SIGNUP.email, code: bad });
      assert.equal(r.status, 400);
      assert.match(r.json.error.message, new RegExp(`${5 - i} tr`));
    }
    const fifth = await b.call('POST', '/v1/account/verify', { email: SIGNUP.email, code: bad });
    assert.deepEqual([fifth.status, fifth.json.error.code], [429, 'CODE_LOCKED']);
    const locked = await b.call('POST', '/v1/account/verify', { email: SIGNUP.email, code: good });
    assert.deepEqual([locked.status, locked.json.error.code], [429, 'CODE_LOCKED'], 'even the right code is refused once locked');
    // a new code replaces the locked one
    assert.equal((await b.call('POST', '/v1/account/resend', { email: SIGNUP.email })).status, 200);
    const fresh = lastCode(h);
    h.clock.t += 11 * 60_000;
    const late = await b.call('POST', '/v1/account/verify', { email: SIGNUP.email, code: fresh });
    assert.deepEqual([late.status, late.json.error.code], [400, 'CODE_EXPIRED']);
    await b.call('POST', '/v1/account/resend', { email: SIGNUP.email });
    assert.equal((await b.call('POST', '/v1/account/verify', { email: SIGNUP.email, code: lastCode(h) })).status, 200);
    // resend for an unknown email answers the same and sends nothing
    const sent = h.mail.length;
    assert.equal((await b.call('POST', '/v1/account/resend', { email: 'nobody@example.com' })).status, 200);
    assert.equal(h.mail.length, sent);
  } finally { await h.close(); cleanup(h.dir); }
});

test('accounts: a password reset ends all sessions; changing the password keeps only this one', async () => {
  const h = await startHub();
  try {
    const one = await signedUp(h);
    const two = browser(h);
    assert.equal((await two.call('POST', '/v1/account/login', { email: SIGNUP.email, password: SIGNUP.password })).status, 200);
    // forgot: same answer for unknown emails, a code for known ones
    const before = h.mail.length;
    assert.equal((await browser(h).call('POST', '/v1/account/forgot', { email: 'nobody@example.com' })).status, 200);
    assert.equal(h.mail.length, before);
    const third = browser(h);
    assert.equal((await third.call('POST', '/v1/account/forgot', { email: SIGNUP.email })).status, 200);
    assert.match(h.mail.at(-1)!.subject, /Reset/);
    const short = await third.call('POST', '/v1/account/reset', { email: SIGNUP.email, code: lastCode(h), password: 'short' });
    assert.equal(short.status, 400);
    const r = await third.call('POST', '/v1/account/reset', { email: SIGNUP.email, code: lastCode(h), password: 'new-password-9' });
    assert.equal(r.status, 200);
    assert.equal((await one.call('GET', '/v1/account/me')).status, 401);
    assert.equal((await two.call('GET', '/v1/account/me')).status, 401);
    assert.equal((await third.call('GET', '/v1/account/me')).status, 200, 'the reset signs in where it was done');
    assert.equal((await browser(h).call('POST', '/v1/account/login', { email: SIGNUP.email, password: SIGNUP.password })).status, 401);
    // change password: other sign-ins end, this one stays
    const four = browser(h);
    await four.call('POST', '/v1/account/login', { email: SIGNUP.email, password: 'new-password-9' });
    const wrongCurrent = await third.call('POST', '/v1/account/password', { current: 'guess-guess', password: 'another-pass-1' });
    assert.equal(wrongCurrent.status, 401);
    assert.equal((await third.call('POST', '/v1/account/password', { current: 'new-password-9', password: 'another-pass-1' })).status, 200);
    assert.equal((await third.call('GET', '/v1/account/me')).status, 200);
    assert.equal((await four.call('GET', '/v1/account/me')).status, 401);
  } finally { await h.close(); cleanup(h.dir); }
});

test('accounts: the password is never stored or logged in clear', async () => {
  const logs: string[] = [];
  const h = await startHub();
  try {
    await signedUp(h);
    const row = h.hub.db.prepare('SELECT password_hash FROM account_user').get() as { password_hash: string };
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    assert.ok(!row.password_hash.includes(SIGNUP.password));
    assert.equal(await checkPassword(SIGNUP.password, row.password_hash), true);
    assert.equal(await checkPassword('tandoor-2027', row.password_hash), false);
    assert.notEqual(await hashPassword('same'), await hashPassword('same'), 'salted');
    // nothing in the database file holds the password or a session token in clear
    h.hub.db.exec('PRAGMA wal_checkpoint(FULL)');
    const file = readFileSync(join(h.dir, 'hub.db'));
    assert.equal(file.includes(Buffer.from(SIGNUP.password)), false);
    for (const m of h.mail) assert.ok(!m.text.includes(SIGNUP.password));
  } finally { await h.close(); cleanup(h.dir); }
  // the hub's log (here the development mailer and account events) never carries the password
  const hub = new Hub({ dbPath: ':memory:', allowLogMailer: true, log: { info: (m, d) => logs.push(m + JSON.stringify(d ?? '')), warn: (m, d) => logs.push(m + JSON.stringify(d ?? '')) } });
  try {
    await hub.accounts.signup(SIGNUP);
    assert.ok(logs.some((l) => /\d{6}/.test(l)), 'the development mailer logs the code');
    assert.ok(logs.every((l) => !l.includes(SIGNUP.password)));
  } finally { hub.close(); }
});

test('accounts: sign-up is rate limited per IP, checked field by field, and closed without an email provider', async () => {
  const h = await startHub();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await browser(h).call('POST', '/v1/account/signup', { ...SIGNUP, email: `owner${i}@example.com` })).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  } finally { await h.close(); cleanup(h.dir); }
  const h2 = await startHub();
  try {
    const bad = await browser(h2).call('POST', '/v1/account/signup', { ...SIGNUP, email: 'not-an-email' });
    assert.deepEqual([bad.status, Object.keys(bad.json.error.details.fields)], [400, ['email']]);
    const phone = await browser(h2).call('POST', '/v1/account/signup', { ...SIGNUP, phone: '12345' });
    assert.deepEqual(Object.keys(phone.json.error.details.fields), ['phone']);
    const pw = await browser(h2).call('POST', '/v1/account/signup', { ...SIGNUP, password: 'short' });
    assert.deepEqual(Object.keys(pw.json.error.details.fields), ['password']);
    assert.equal(h2.mail.length, 0);
  } finally { await h2.close(); cleanup(h2.dir); }
  assert.equal(normalisePhone('+91 98765-43210'), '+919876543210');
  assert.equal(normalisePhone('09876543210'), '+919876543210');
  assert.equal(normalisePhone('+44 7700 900123'), '+447700900123');
  // production with no email provider: the log mailer is not accepted, sign-up is closed
  const closed = new Hub({ dbPath: ':memory:', mailer: logMailer({ info: () => undefined }) });
  try {
    assert.equal(closed.accounts.open, false);
    await assert.rejects(closed.accounts.signup(SIGNUP), (e: Error & { code?: string }) => e.code === 'SIGNUP_CLOSED');
  } finally { closed.close(); }
});

test('accounts: HUB_SKIP_EMAIL_VERIFY: sign-up without email is open and signs in at once; older unconfirmed accounts sign in with their password', async () => {
  const sent: string[] = [];
  const hub = new Hub({ dbPath: ':memory:', mailer: logMailer({ info: (m: string) => { sent.push(m); } }), skipEmailVerify: true });
  const server = createHubServer(hub, {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal(hub.accounts.open, true);
    const r = await fetch(`${base}/v1/account/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(SIGNUP) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { email: 'asha@spicegarden.in', verify: false });
    const cookie = String(r.headers.get('set-cookie')).split(';')[0]!;
    assert.match(cookie, /^dp_account=dpa_/);
    const me = await fetch(`${base}/v1/account/me`, { headers: { cookie } });
    assert.equal(me.status, 200, 'signed in straight after sign-up');
    assert.equal(sent.filter((m) => /code/i.test(m)).length, 0, 'no code was sent');
    // an account made earlier, never confirmed: the right password signs in (no code asked), a wrong one does not
    hub.db.prepare("INSERT INTO account (id, name, phone, status, created_at, products_json) VALUES ('a2','Chai Point','+919811122233','new',0,'[\"tiffin_qsr\"]')").run();
    hub.db.prepare("INSERT INTO account_user (id, account_id, email, name, password_hash, role, created_at) VALUES ('u2','a2','ravi@chaipoint.in','Ravi',?,'owner',0)").run(await hashPassword('chai-point-2026'));
    await assert.rejects(hub.accounts.login('ravi@chaipoint.in', 'wrong-password'), (e: Error & { code?: string }) => e.code === 'BAD_LOGIN');
    const s = await hub.accounts.login('ravi@chaipoint.in', 'chai-point-2026');
    assert.equal(hub.accounts.me(s.token).user.email, 'ravi@chaipoint.in');
  } finally { server.close(); server.closeAllConnections(); hub.close(); }
});

test('accounts: a sign-in stays while used (400 days idle ends it), the cookie is renewed; the portal pages are served; portal.<cloud> is never an outlet', async () => {
  const h = await startHub();
  try {
    const b = await signedUp(h);
    for (let i = 0; i < 4; i++) {
      h.clock.t += 390 * 86_400_000;
      const r = await b.call('GET', '/v1/account/me');
      assert.equal(r.status, 200, `visit ${i + 1}, 390 days after the last: still signed in (${(i + 1) * 390} days in all)`);
      assert.match(String(r.setCookie), /^dp_account=dpa_[^;]+;.*HttpOnly; SameSite=Lax; Max-Age=345600\d{2}/, 'the cookie is renewed for 400 days');
    }
    h.clock.t += 401 * 86_400_000;
    assert.equal((await b.call('GET', '/v1/account/me')).status, 401, '401 days without a visit: signed out');
    for (const p of ['/signup', '/login', '/forgot', '/app']) {
      const r = await fetch(h.base + p);
      assert.equal(r.status, 200);
      assert.match(await r.text(), /PosiNext account/);
      assert.match(r.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    }
    const reserved = await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'portal', name: 'Portal' } });
    assert.equal(reserved.status, 409);
  } finally { await h.close(); cleanup(h.dir); }
});

test('accounts: signed-in devices are listed; one can be signed out, or all the others', async () => {
  const h = await startHub();
  try {
    const phone = await signedUp(h);
    const laptop = browser(h), tablet = browser(h);
    for (const b of [laptop, tablet]) assert.equal((await b.call('POST', '/v1/account/login', { email: SIGNUP.email, password: SIGNUP.password })).status, 200);
    const list = await laptop.call('GET', '/v1/account/sessions');
    assert.equal(list.status, 200);
    const sessions = list.json.sessions as Array<{ id: string; current: boolean }>;
    assert.equal(sessions.length, 3);
    assert.equal(sessions.filter((s) => s.current).length, 1);
    assert.ok(sessions.every((s) => /^[0-9a-f]{16}$/.test(s.id)));
    assert.ok(!JSON.stringify(list.json).includes(laptop.cookie.split('=')[1]!), 'the list never shows a sign-in token');
    // the tablet signs the phone out: only the phone is signed out
    const phoneId = ((await phone.call('GET', '/v1/account/sessions')).json.sessions as Array<{ id: string; current: boolean }>).find((s) => s.current)!.id;
    assert.equal((await tablet.call('POST', `/v1/account/sessions/${phoneId}/revoke`)).status, 200);
    assert.equal((await phone.call('GET', '/v1/account/me')).status, 401);
    assert.equal((await laptop.call('GET', '/v1/account/me')).status, 200);
    assert.equal((await tablet.call('POST', '/v1/account/sessions/0123456789abcdef/revoke')).status, 404);
    // another account cannot sign this one's devices out
    const other = await signedUp(h, browser(h), { email: 'ravi@chaipoint.in', phone: '9811122233' });
    const laptopId = ((await laptop.call('GET', '/v1/account/sessions')).json.sessions as Array<{ id: string; current: boolean }>).find((s) => s.current)!.id;
    assert.equal((await other.call('POST', `/v1/account/sessions/${laptopId}/revoke`)).status, 404);
    // the laptop signs out everything else
    const r = await laptop.call('POST', '/v1/account/sessions/revoke-others');
    assert.deepEqual(r.json, { ok: true, signedOut: 1 });
    assert.equal((await tablet.call('GET', '/v1/account/me')).status, 401);
    assert.equal((await laptop.call('GET', '/v1/account/me')).status, 200);
    assert.equal((await browser(h).call('GET', '/v1/account/sessions')).status, 401);
  } finally { await h.close(); cleanup(h.dir); }
});

test('accounts: over https the cookie is __Host- and Secure; changes from another website are refused', async () => {
  const h = await startHub();
  try {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(h.base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    await signedUp(h);
    const login = { email: SIGNUP.email, password: SIGNUP.password };
    // https (behind Caddy): the cookie only this exact host can have; an old plain cookie is cleared
    const r = await post('/v1/account/login', login, { 'x-forwarded-proto': 'https' });
    assert.equal(r.status, 200);
    const set = r.headers.getSetCookie();
    assert.match(set[0]!, /^__Host-dp_account=dpa_[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/);
    assert.ok(!/Domain=/i.test(set[0]!));
    assert.match(set[1]!, /^dp_account=; .*Max-Age=0$/);
    const cookie = set[0]!.split(';')[0]!;
    assert.equal((await fetch(h.base + '/v1/account/me', { headers: { cookie } })).status, 200);
    // another website's page posting with the visitor's cookie (CSRF): refused, whatever the route
    const host = new URL(h.base).host;
    for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null']) {
      const x = await post('/v1/account/sessions/revoke-others', {}, { cookie, origin, host });
      assert.equal(x.status, 403, origin);
    }
    assert.equal((await post('/v1/account/login', login, { origin: 'https://evil.example' })).status, 403);
    // the portal's own pages (same host), and callers that are not browsers (no Origin), work
    assert.equal((await post('/v1/account/login', login, { origin: `http://${host}` })).status, 200);
    assert.equal((await post('/v1/account/login', login)).status, 200);
    assert.equal((await post('/v1/account/login', login, { origin: 'https://portal.posinext.com', 'x-forwarded-host': 'portal.posinext.com' })).status, 200);
  } finally { await h.close(); cleanup(h.dir); }
});

test('accounts (P8-06): the products chosen at sign-up (QSR, Fine Dine or both) are in the account and can be changed', async () => {
  const h = await startHub();
  try {
    const both = await signedUp(h, browser(h), { products: ['tiffin_qsr', 'fine_dine'] } as Partial<typeof SIGNUP>);
    assert.deepEqual((await both.call('GET', '/v1/account/me')).json.account.products, ['fine_dine', 'tiffin_qsr']);
    const changed = await both.call('POST', '/v1/account/products', { products: ['tiffin_qsr'] });
    assert.deepEqual(changed.json, { products: ['tiffin_qsr'] });
    assert.deepEqual((await both.call('GET', '/v1/account/me')).json.account.products, ['tiffin_qsr']);
    for (const bad of [[], ['pizza_pos'], ['fine_dine', 'fine_dine'], 'fine_dine']) {
      const r = await both.call('POST', '/v1/account/products', { products: bad });
      assert.deepEqual([r.status, r.json.error.code], [400, 'VALIDATION'], JSON.stringify(bad));
    }
    assert.equal((await browser(h).call('POST', '/v1/account/products', { products: ['fine_dine'] })).status, 401);
    // not saying (older sign-up forms) means Fine Dine; an unknown product is refused before anything is made
    const plain = await signedUp(h, browser(h), { email: 'b@example.com', phone: '9123456780' });
    assert.deepEqual((await plain.call('GET', '/v1/account/me')).json.account.products, ['fine_dine']);
    const r = await browser(h).call('POST', '/v1/account/signup', { ...SIGNUP, email: 'c@example.com', phone: '9000000001', products: ['pizza_pos'] });
    assert.deepEqual([r.status, r.json.error.details.fields.products], [400, 'Choose at least one product.']);
  } finally { await h.close(); cleanup(h.dir); }
});
