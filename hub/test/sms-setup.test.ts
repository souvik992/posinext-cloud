import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { Hub } from '../src/hub.ts';
import { cleanup, startHub } from './helpers.ts';

// MSG91 set up from the admin page (Hub settings > SMS codes) when the server has no HUB_MSG91_* settings.

test('SMS setup on the admin page: saved, used at once, key never shown, test SMS, removal guarded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sms-'));
  const calls: { url: string; key: string; body: Record<string, unknown> }[] = [];
  let answer = { status: 200, body: '{"type":"success"}' };
  const smsFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, key: (init.headers as Record<string, string>).authkey!, body: JSON.parse(String(init.body)) });
    return new Response(answer.body, { status: answer.status });
  }) as unknown as typeof fetch;
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), smsFetch });
  try {
    assert.deepEqual(hub.smsSetup(), { source: 'none', configured: false });
    assert.equal(hub.adminOverview().hub.smsProvider, false);
    await assert.rejects(hub.testSms('9876543210'), { code: 'SMS_NOT_SET_UP' });
    assert.throws(() => hub.saveSettings({ checks: { otp: { portal: true } } }), { code: 'SMS_NOT_SET_UP' });

    assert.throws(() => hub.saveSmsSetup({ templateId: 'x' }), (e: { code: string; details: { fields: Record<string, string> } }) =>
      e.code === 'VALIDATION' && Boolean(e.details.fields.authKey) && Boolean(e.details.fields.templateId));
    const saved = hub.saveSmsSetup({ authKey: 'abcDEF1234567890', templateId: '6650a1b2c3d4', otpVar: '##code##' });
    assert.deepEqual(saved, { source: 'admin', configured: true, templateId: '6650a1b2c3d4', otpVar: 'code', authKeyEnding: '7890' });
    assert.ok(!JSON.stringify(hub.adminOverview()).includes('abcDEF1234567890'), 'the key is not in the overview');
    assert.equal(hub.adminOverview().hub.smsProvider, true);

    // used at once: order OTP goes through MSG91 with the saved details
    await hub.otpSend('9876543210', { channel: 'website' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.key, 'abcDEF1234567890');
    assert.equal((calls[0]!.body.recipients as Record<string, string>[])[0]!.mobiles, '919876543210');
    assert.match(String((calls[0]!.body.recipients as Record<string, string>[])[0]!.code), /^\d{6}$/);

    // an empty key keeps the saved one
    hub.saveSmsSetup({ authKey: '', templateId: 'newtemplate1', otpVar: '' });
    assert.equal(hub.smsSetup().authKeyEnding, '7890');
    const t = await hub.testSms('98765 43210');
    assert.equal(t.sent, true);
    assert.equal(calls.at(-1)!.body.template_id, 'newtemplate1');
    assert.equal((calls.at(-1)!.body.recipients as Record<string, string>[])[0]!.otp, t.code);
    answer = { status: 200, body: '{"type":"error","message":"Invalid template"}' };
    await assert.rejects(hub.testSms('9876543210'), (e: { code: string; message: string }) => e.code === 'SMS_FAILED' && /Invalid template/.test(e.message));

    // with a website SMS check on, it cannot be removed
    hub.saveSettings({ checks: { otp: { portal: true } } });
    assert.throws(() => hub.removeSmsSetup(), { code: 'SMS_IN_USE' });
    hub.saveSettings({ checks: { otp: { portal: false } } });
    assert.deepEqual(hub.removeSmsSetup(), { source: 'none', configured: false });
    assert.equal(hub.smsSender(), undefined);
  } finally { hub.close(); cleanup(dir); }
});

test('SMS setup routes: admin only; set on the server, the page cannot change it', async () => {
  const h = await startHub(); // the test hub has a server SMS sender, as HUB_MSG91_* would give
  try {
    assert.equal((await h.call('GET', '/v1/admin/sms')).status, 403);
    assert.deepEqual((await h.call('GET', '/v1/admin/sms', { admin: true })).json, { source: 'server', configured: true });
    const put = await h.call('PUT', '/v1/admin/sms', { admin: true, body: { authKey: 'abcDEF1234567890', templateId: 'tmpl1234' } });
    assert.equal(put.status, 409);
    assert.equal(put.json.error.code, 'SET_ON_SERVER');
    assert.equal((await h.call('DELETE', '/v1/admin/sms', { admin: true })).status, 409);
    const sent = await h.call('POST', '/v1/admin/sms/test', { admin: true, body: { mobile: '9876543210' } });
    assert.equal(sent.status, 200);
    assert.equal(h.sms.at(-1)!.code, sent.json.code);
  } finally { await h.close(); cleanup(h.dir); }
});
