import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { Captchas, CAPTCHA_LENGTH, normaliseAnswer } from '../src/captcha.ts';
import { Portal } from '../src/portal.ts';
import { cleanup, onHost, startHub } from './helpers.ts';

const SIGNUP = { businessName: 'Spice Garden', name: 'Asha Rao', email: 'asha@spicegarden.in', phone: '98765 43210', password: 'tandoor-2026' };

test('captcha: a PNG picture; the answer is checked once, without case or spaces, and expires after 10 minutes', () => {
  const clock = { t: 1_000_000 };
  const c = new Captchas(() => clock.t);
  const a = c.issue();
  assert.equal(a.answer.length, CAPTCHA_LENGTH);
  assert.match(a.answer, /^[ACDEFHJKMNPRTUVWXY2-9]+$/);
  const png = Buffer.from(a.image.replace(/^data:image\/png;base64,/, ''), 'base64');
  assert.deepEqual([...png.subarray(1, 4)].map((b) => String.fromCharCode(b)).join(''), 'PNG');
  assert.equal(png.readUInt32BE(16), 180); // IHDR width
  // the picture holds no text: the answer is not in the file in any form
  assert.ok(!a.image.includes(a.answer) && !png.includes(a.answer));

  c.check(a.id, ` ${a.answer.toLowerCase().split('').join(' ')} `);
  assert.throws(() => c.check(a.id, a.answer), { code: 'CAPTCHA_WRONG' }); // used up

  const b = c.issue();
  assert.throws(() => c.check(b.id, 'WRONG'), { code: 'CAPTCHA_WRONG' });
  assert.throws(() => c.check(b.id, b.answer), { code: 'CAPTCHA_WRONG' }); // a wrong try uses it up too

  const d = c.issue();
  clock.t += 10 * 60_000;
  assert.throws(() => c.check(d.id, d.answer), (e: any) => e.code === 'CAPTCHA_WRONG' && /expired/.test(e.message) && !!e.details.fields.captcha);
  assert.throws(() => c.check(undefined, ''), { code: 'CAPTCHA_WRONG' });
  assert.equal(normaliseAnswer(' ab c '), 'ABC');
});

test('captcha: the drawn PNG is valid (the image data inflates to 60 rows)', () => {
  const png = Buffer.from(new Captchas().issue().image.split(',')[1]!, 'base64');
  const idatLen = png.readUInt32BE(33), idat = png.subarray(41, 41 + idatLen);
  assert.equal(png.subarray(37, 41).toString('ascii'), 'IDAT');
  assert.equal(inflateSync(idat).length, (180 * 3 + 1) * 60);
});

const PORTAL = 'portal.posinext.com';
const withPortal = () => startHub(undefined, undefined, undefined, { portal: new Portal({ dir: tmpdir(), hosts: [PORTAL] }) });

test('captcha: off until the admin switches it on for a channel', async () => {
  const off = await withPortal();
  try {
    const site = onHost(off.base, PORTAL);
    assert.deepEqual((await site('GET', '/v1/account/captcha')).json, { enabled: false });
    assert.deepEqual((await off.call('GET', '/v1/captcha?channel=app')).json, { enabled: false });
    assert.equal((await site('POST', '/v1/account/signup', SIGNUP)).status, 200);
  } finally { await off.close(); cleanup(off.dir); }
});

test("captcha: on the website (portal address) sign-up and sign-in need a right answer first; never on the hub's own pages or in the apps", async () => {
  const h = await withPortal();
  const captchas = h.hub.captchas;
  try {
    assert.equal((await h.call('PUT', '/v1/admin/settings', { admin: true, body: { checks: { captcha: { portal: true } } } })).status, 200);
    const site = onHost(h.base, PORTAL);
    const got = (await site('GET', '/v1/account/captcha')).json;
    assert.equal(got.enabled, true);
    assert.match(got.image, /^data:image\/png;base64,/);
    assert.equal(got.answer, undefined, 'the answer never leaves the hub');

    const none = await site('POST', '/v1/account/signup', SIGNUP);
    assert.equal(none.status, 400);
    assert.equal(none.json.error.code, 'CAPTCHA_WRONG');
    assert.match(none.json.error.details.fields.captcha, /Type the characters/);
    assert.equal(h.mail.length, 0, 'nothing is sent before the captcha is right');

    const wrong = captchas.issue();
    assert.equal((await site('POST', '/v1/account/signup', { ...SIGNUP, captchaId: wrong.id, captcha: 'XXXXX' })).json.error.code, 'CAPTCHA_WRONG');

    const ok = captchas.issue();
    const r = await site('POST', '/v1/account/signup', { ...SIGNUP, captchaId: ok.id, captcha: ok.answer });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    // sign-in: a wrong captcha is refused before the password is looked at (it does not count as a wrong password)
    assert.equal((await site('POST', '/v1/account/login', { email: SIGNUP.email, password: 'nope-nope' })).json.error.code, 'CAPTCHA_WRONG');
    const c2 = captchas.issue();
    const li2 = await site('POST', '/v1/account/login', { email: SIGNUP.email, password: 'nope-nope', captchaId: c2.id, captcha: c2.answer });
    assert.equal(li2.json.error.code, 'BAD_LOGIN');

    // the hub's own address (its /login and /signup pages): no captcha offered or needed
    assert.deepEqual((await h.call('GET', '/v1/account/captcha')).json, { enabled: false });
    assert.equal((await h.call('POST', '/v1/account/login', { body: { email: SIGNUP.email, password: 'nope-nope' } })).json.error.code, 'BAD_LOGIN');
    assert.equal((await h.call('POST', '/v1/account/signup', { body: { ...SIGNUP, email: 'other@example.com', phone: '9123456780' } })).status, 200);

    // the Windows apps' sign-in (/v1/activate) never asks for one
    const act = await h.call('POST', '/v1/activate', { body: { email: SIGNUP.email, password: 'nope-nope' } });
    assert.notEqual(act.json?.error?.code, 'CAPTCHA_WRONG');
  } finally { await h.close(); cleanup(h.dir); }
});
