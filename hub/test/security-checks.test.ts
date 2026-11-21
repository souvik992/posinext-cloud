import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { Hub } from '../src/hub.ts';
import { Portal } from '../src/portal.ts';
import { fullChecks, checkSettings } from '../src/settings.ts';
import { msg91, msg91Number } from '../src/sms.ts';
import { cleanup, menu, onHost, posStream, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

// Security checks (src/settings.ts): captcha, OTP, email and mobile verification, each per channel (portal, food
// ordering app, food ordering website), set on the admin page.

const PORTAL = 'portal.posinext.com';
const SIGNUP = { businessName: 'Spice Garden', name: 'Asha Rao', email: 'asha@spicegarden.in', phone: '98765 43210', password: 'tandoor-2026' };
const withPortal = (extra = {}) => startHub(undefined, undefined, undefined, { portal: new Portal({ dir: tmpdir(), hosts: [PORTAL] }), ...extra });
const setChecks = async (h: TestHub, checks: unknown) => h.call('PUT', '/v1/admin/settings', { admin: true, body: { checks } });

test('checks: defaults keep today\'s behaviour; partial changes merge; boxes that do not apply are refused', async () => {
  const h = await startHub();
  try {
    const s = (await h.call('GET', '/v1/admin/overview', { admin: true })).json.settings;
    assert.deepEqual(s.checks, {
      captcha: { portal: false, orderingApp: false, orderingSite: false },
      otp: { portal: false, orderingApp: true, orderingSite: true },
      emailVerification: { portal: true, orderingApp: false, orderingSite: false },
      mobileVerification: { portal: false, orderingApp: false, orderingSite: false },
      demoMode: { portal: false, orderingApp: false, orderingSite: false },
    });
    const r = await setChecks(h, { captcha: { orderingApp: true }, otp: { orderingSite: false } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.settings.checks.captcha.orderingApp, true);
    assert.equal(r.json.settings.checks.otp.orderingSite, false);
    assert.equal(r.json.settings.checks.otp.orderingApp, true, 'boxes not sent stay as they were');
    assert.equal(r.json.settings.offlineAfterSec, 60, 'other settings untouched');

    const bad = await setChecks(h, { emailVerification: { orderingApp: true }, nope: { portal: true }, captcha: { kiosk: true, portal: 'yes' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.json.error.details.fields).sort(), ['checks.captcha.kiosk', 'checks.captcha.portal', 'checks.emailVerification.orderingApp', 'checks.nope']);

    // what each channel asks for (public, for the apps and pages)
    assert.deepEqual((await h.call('GET', '/v1/checks?channel=app')).json, { channel: 'orderingApp', captcha: true, otp: true, emailVerification: false, mobileVerification: false, demoMode: false });
    assert.equal((await h.call('GET', '/v1/checks?channel=website')).json.otp, false);
    // kept across a restart
    const h2 = await h.restart();
    assert.equal(h2.hub.settings().checks.captcha.orderingApp, true);
    await h2.close();
  } finally { cleanup(h.dir); }
  assert.equal(checkSettings({ checks: [] }).ok, false);
  assert.equal(fullChecks({ mobileVerification: { orderingSite: true } }).mobileVerification.orderingSite, false);
});

test('checks: HUB_SKIP_EMAIL_VERIFY is the default for email verification; SMS checks need an SMS provider', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-checks-'));
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), skipEmailVerify: true });
  try {
    assert.equal(hub.settings().checks.emailVerification.portal, false);
    assert.throws(() => hub.saveSettings({ checks: { mobileVerification: { portal: true } } }), { code: 'SMS_NOT_SET_UP' });
    assert.throws(() => hub.saveSettings({ checks: { otp: { portal: true } } }), { code: 'SMS_NOT_SET_UP' });
    assert.equal(hub.saveSettings({ checks: { emailVerification: { portal: true } } }).checks.emailVerification.portal, true);
  } finally { hub.close(); cleanup(dir); }
});

/** A store taking orders on both channels (its POS connected: close the stream at the end). */
async function readyStore(h: TestHub) {
  const store = (await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'demo-burger', name: 'Demo Burger Hub' } })).json;
  const key = (await h.call('POST', '/v1/pos/pair', { body: { code: store.pairingCode, deviceName: 'Counter 1' } })).json.deviceKey as string;
  assert.equal((await h.call('PUT', '/v1/pos/menu', { key, body: menu() })).status, 200);
  const pos = posStream(h.base, key);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await h.call('PUT', '/v1/pos/status', { key, body: { accepting: true } })).status, 200);
  return pos;
}
const order = async (h: TestHub, channel: 'app' | 'website', extra: Record<string, unknown> = {}) => {
  const lines = [{ itemId: 'burger', qtyMilli: 1000 }];
  const q = (await h.call('POST', '/v1/stores/demo-burger/quote', { body: { fulfilment: 'PICKUP', lines, channel } })).json;
  return h.call('POST', '/v1/stores/demo-burger/orders', { body: { fulfilment: 'PICKUP', payment: 'COD', customer: { name: 'Asha', mobile: '9876543210' }, location: null, address: null, lines, menuVersion: 1, expectedTotal: q.total, channel, ...extra } });
};

test('ordering: OTP and captcha follow the boxes for the app and the website separately', async () => {
  const h = await startHub();
  let pos: Awaited<ReturnType<typeof readyStore>> | undefined;
  try {
    pos = await readyStore(h);
    // default: cash on delivery needs the OTP on both
    assert.equal((await order(h, 'website')).json.error.code, 'OTP_REQUIRED');
    assert.equal((await h.call('GET', '/v1/stores/demo-burger')).json.checks.otp, true);

    // OTP off for the website only
    await setChecks(h, { otp: { orderingSite: false } });
    assert.deepEqual((await h.call('GET', '/v1/stores/demo-burger')).json.checks, { otp: false, captcha: false, demoMode: false });
    assert.equal((await order(h, 'website')).status, 201);
    assert.equal((await order(h, 'app')).json.error.code, 'OTP_REQUIRED');

    // captcha on for the app: asked before the SMS code is sent
    await setChecks(h, { captcha: { orderingApp: true } });
    assert.equal((await h.call('GET', '/v1/captcha?channel=website')).json.enabled, false);
    assert.equal((await h.call('GET', '/v1/captcha?channel=app')).json.enabled, true);
    assert.equal((await h.call('POST', '/v1/otp/send', { body: { mobile: '9876543210', channel: 'app' } })).json.error.code, 'CAPTCHA_WRONG');
    assert.equal(h.sms.length, 0, 'no SMS before the captcha is right');
    const c = h.hub.captchas.issue();
    const sent = await h.call('POST', '/v1/otp/send', { body: { mobile: '9876543210', channel: 'app', captchaId: c.id, captcha: c.answer } });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(h.sms.length, 1);
    assert.equal(h.sms[0]!.code, sent.json.devCode, 'the SMS sender gets the code itself (MSG91 templates take only the code)');
    const { otpToken } = (await h.call('POST', '/v1/otp/verify', { body: { mobile: '9876543210', otp: sent.json.devCode } })).json;
    // an order confirmed by the OTP needs no second captcha
    assert.equal((await order(h, 'app', { otpToken })).status, 201);

    // captcha on for the website, where the OTP is off: the order itself needs the captcha
    await setChecks(h, { captcha: { orderingSite: true } });
    assert.equal((await order(h, 'website')).json.error.code, 'CAPTCHA_WRONG');
    const c2 = h.hub.captchas.issue();
    assert.equal((await order(h, 'website', { captchaId: c2.id, captcha: c2.answer })).status, 201);
  } finally { await pos?.close(); await h.close(); cleanup(h.dir); }
});

test('portal: mobile verification sends an SMS code before the first sign-in; only on the portal address', async () => {
  const h = await withPortal();
  try {
    await setChecks(h, { mobileVerification: { portal: true } });
    const site = onHost(h.base, PORTAL);
    assert.equal((await site('POST', '/v1/account/signup', SIGNUP)).status, 200);
    // the emailed code is right, but the mobile is not confirmed yet: no sign-in, an SMS code instead
    const emailCode = /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1];
    const v = await site('POST', '/v1/account/verify', { email: SIGNUP.email, code: emailCode });
    assert.equal(v.status, 403);
    assert.equal(v.json.error.code, 'PHONE_NOT_VERIFIED');
    assert.equal(v.json.error.details.phone, '+91******3210');
    assert.equal(site.cookie, '', 'no session yet');
    assert.equal(h.sms.length, 1);
    assert.equal(h.sms[0]!.mobile, '+919876543210');
    const pending = v.json.error.details.pending as string;

    assert.equal((await site('POST', '/v1/account/verify-phone', { pending, code: '000000' === h.sms[0]!.code ? '111111' : '000000' })).json.error.code, 'WRONG_CODE');
    assert.equal((await site('POST', '/v1/account/verify-phone', { pending: 'pv_made-up', code: h.sms[0]!.code })).json.error.code, 'PENDING_EXPIRED');
    const ok = await site('POST', '/v1/account/verify-phone', { pending, code: h.sms[0]!.code });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.notEqual(site.cookie, '');
    assert.equal((await site('GET', '/v1/account/me')).status, 200);

    // confirmed once: later sign-ins need only the password
    const again = onHost(h.base, PORTAL);
    assert.equal((await again('POST', '/v1/account/login', { email: SIGNUP.email, password: SIGNUP.password })).status, 200);

    // the hub's own pages: never asked (a second account, not confirmed)
    await h.call('POST', '/v1/account/signup', { body: { ...SIGNUP, email: 'two@example.com', phone: '9123456780' } });
    const code2 = /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1];
    assert.equal((await h.call('POST', '/v1/account/verify', { body: { email: 'two@example.com', code: code2 } })).status, 200);
    assert.equal((await h.call('POST', '/v1/account/login', { body: { email: 'two@example.com', password: SIGNUP.password } })).status, 200);
    // ...but on the portal it is
    assert.equal((await onHost(h.base, PORTAL)('POST', '/v1/account/login', { email: 'two@example.com', password: SIGNUP.password })).json.error.code, 'PHONE_NOT_VERIFIED');
  } finally { await h.close(); cleanup(h.dir); }
});

test('portal: sign in with an SMS code (otp), for an account whose mobile is confirmed; off: refused', async () => {
  const h = await withPortal();
  try {
    const site = onHost(h.base, PORTAL);
    await site('POST', '/v1/account/signup', SIGNUP);
    const emailCode = /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1];
    assert.equal((await site('POST', '/v1/account/verify', { email: SIGNUP.email, code: emailCode })).status, 200);

    assert.equal((await site('POST', '/v1/account/code/send', { phone: SIGNUP.phone })).json.error.code, 'NOT_AVAILABLE', 'off by default');
    await setChecks(h, { otp: { portal: true } });
    // the mobile is not confirmed yet: answered the same, but no SMS
    assert.equal((await site('POST', '/v1/account/code/send', { phone: SIGNUP.phone })).status, 200);
    assert.equal(h.sms.length, 0);
    // confirm it (mobile verification), then a code signs in
    await setChecks(h, { mobileVerification: { portal: true } });
    const p = (await onHost(h.base, PORTAL)('POST', '/v1/account/login', { email: SIGNUP.email, password: SIGNUP.password })).json.error.details.pending;
    assert.equal((await site('POST', '/v1/account/verify-phone', { pending: p, code: h.sms.at(-1)!.code })).status, 200);

    const phone = onHost(h.base, PORTAL);
    assert.equal((await phone('POST', '/v1/account/code/send', { phone: '+91 98765 43210' })).status, 200);
    const code = h.sms.at(-1)!.code;
    assert.equal((await phone('POST', '/v1/account/code/login', { phone: '9876543210', code: code === '123456' ? '654321' : '123456' })).json.error.code, 'WRONG_CODE');
    const li = await phone('POST', '/v1/account/code/login', { phone: '9876543210', code });
    assert.equal(li.status, 200, JSON.stringify(li.json));
    assert.equal((await phone('GET', '/v1/account/me')).json.user.email, SIGNUP.email);
    assert.equal((await phone('POST', '/v1/account/code/login', { phone: '9876543210', code })).json.error.code, 'CODE_EXPIRED', 'a code works once');
    // an unknown number: same answer, no SMS
    const before = h.sms.length;
    assert.equal((await phone('POST', '/v1/account/code/send', { phone: '9000000009' })).status, 200);
    assert.equal(h.sms.length, before);
    // not on the hub's own address
    assert.equal((await h.call('POST', '/v1/account/code/send', { body: { phone: SIGNUP.phone } })).json.error.code, 'NOT_AVAILABLE');
  } finally { await h.close(); cleanup(h.dir); }
});

test('portal: email verification off signs in at once (as HUB_SKIP_EMAIL_VERIFY did)', async () => {
  const h = await withPortal();
  try {
    await setChecks(h, { emailVerification: { portal: false } });
    const site = onHost(h.base, PORTAL);
    const r = await site('POST', '/v1/account/signup', SIGNUP);
    assert.equal(r.json.verify, false);
    assert.equal(h.mail.length, 0);
    assert.equal((await site('GET', '/v1/account/me')).status, 200);
  } finally { await h.close(); cleanup(h.dir); }
});

test('MSG91: one flow template, the code in its variable, numbers with the country code; errors are raised', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let answer = { status: 200, body: '{"type":"success","message":"3463"}' };
  const send = msg91({ authKey: 'k-123', templateId: 't-9', fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(answer.body, { status: answer.status }); }) as typeof fetch });
  await send('+919876543210', '123456 is your code', '123456');
  assert.equal(calls[0]!.url, 'https://control.msg91.com/api/v5/flow');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authkey, 'k-123');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { template_id: 't-9', short_url: '0', recipients: [{ mobiles: '919876543210', otp: '123456' }] });
  assert.equal(msg91Number('9876543210'), '919876543210');
  assert.equal(msg91Number('+447700900123'), '447700900123');
  answer = { status: 200, body: '{"type":"error","message":"Invalid template"}' };
  await assert.rejects(send('9876543210', 'x', '111111'), /Invalid template/);
  answer = { status: 401, body: 'unauthorised' };
  await assert.rejects(send('9876543210', 'x', '111111'), /401/);
});

test('demo mode: per ordering channel, the OTP code is shown on screen (as HUB_DEV_OTP); off by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-demo-'));
  const sent: string[] = [];
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), sendSms: async (_m, _t, code) => { sent.push(code); } });
  try {
    assert.equal((await hub.otpSend('9876543210', { channel: 'website' })).devCode, undefined);
    hub.saveSettings({ checks: { demoMode: { orderingSite: true } } });
    const site = await hub.otpSend('9876543210', { channel: 'website' });
    assert.equal(site.devCode, sent.at(-1), 'the code on screen is the one sent');
    assert.equal((await hub.otpSend('9876543211', { channel: 'app' })).devCode, undefined, 'the app is a separate box');
    assert.equal(hub.checksFor('orderingSite').demoMode, true);
    assert.throws(() => hub.saveSettings({ checks: { demoMode: { portal: true } } }), { code: 'VALIDATION' });
  } finally { hub.close(); cleanup(dir); }
});

test('show OTP codes on screen: the admin switch works like HUB_DEV_OTP on every ordering channel; HUB_DEV_OTP keeps it on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-devotp-'));
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), sendSms: async () => undefined });
  try {
    assert.equal((await hub.otpSend('9876543210', { channel: 'website' })).devCode, undefined);
    assert.deepEqual([hub.adminOverview().hub.devOtp, hub.adminOverview().hub.devOtpEnv], [false, false]);
    assert.throws(() => hub.saveSettings({ showOtpCodes: 'yes' }), { code: 'VALIDATION' });
    hub.saveSettings({ showOtpCodes: true });
    assert.match(String((await hub.otpSend('9876543211', { channel: 'website' })).devCode), /^\d{6}$/);
    assert.match(String((await hub.otpSend('9876543212', { channel: 'app' })).devCode), /^\d{6}$/);
    assert.equal(hub.adminOverview().hub.devOtp, true);
    hub.saveSettings({ showOtpCodes: false });
    assert.equal((await hub.otpSend('9876543213', { channel: 'app' })).devCode, undefined);
  } finally { hub.close(); cleanup(dir); }
  const dir2 = mkdtempSync(join(tmpdir(), 'hub-devotp-'));
  const env = new Hub({ dbPath: join(dir2, 'hub.db'), devOtp: true });
  try {
    env.saveSettings({ showOtpCodes: false });
    assert.deepEqual([env.adminOverview().hub.devOtp, env.adminOverview().hub.devOtpEnv], [true, true]);
    assert.ok((await env.otpSend('9876543210', { channel: 'website' })).devCode);
  } finally { env.close(); cleanup(dir2); }
});
