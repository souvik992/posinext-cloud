import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { Hub } from '../src/hub.ts';
import { checkTemplates, fullTemplates, MAIL_TEMPLATES, renderMail } from '../src/mail-templates.ts';
import { cleanup, startHub } from './helpers.ts';
import { decodeBody, decodeHtml, decodeSubject, fakeSmtp } from './fake-smtp.ts';

// Email set up from the admin page (Hub settings > Email (SMTP)) and the editable customer emails (Email templates).

const SIGNUP = { businessName: 'Spice Garden', name: 'Asha Rao', email: 'asha@spicegarden.in', phone: '98765 43210', password: 'tandoor-2026' };

test('templates: checked (must keep the code, only known {{names}}), filled in, defaults where not saved', () => {
  const bad = checkTemplates({ verify: { subject: 'Your code', body: 'Hello {{name}}' }, nope: { subject: 'x', body: 'y' } });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.errors['verify.body']!, /\{\{name\}\} is not known/);
    assert.ok(bad.errors.nope);
  }
  const missing = checkTemplates({ verify: { subject: 'Hi', body: 'No code here' } });
  assert.ok(!missing.ok && /must include \{\{code\}\}/.test(missing.errors['verify.body']!));
  // the code in the subject is enough; spaces inside the braces are fine
  const ok = checkTemplates({ verify: { subject: '{{ code }} for Spice', body: 'Welcome!\r\n\r\nThanks.' }, reset: null });
  // no html sent: the default design; "" = plain text only
  assert.deepEqual(ok, { ok: true, value: { verify: { subject: '{{ code }} for Spice', body: 'Welcome!\n\nThanks.', html: MAIL_TEMPLATES.verify.html }, reset: null } });
  const plain = checkTemplates({ verify: { subject: '{{code}}', body: 'x', html: '' } });
  assert.ok(plain.ok && plain.value.verify!.html === '');
  const noCode = checkTemplates({ verify: { subject: 'Hi', body: '{{code}}', html: '<p>Welcome</p>' } });
  assert.ok(!noCode.ok && /HTML must include \{\{code\}\}/.test(noCode.errors['verify.html']!));
  const script = checkTemplates({ verify: { subject: '{{code}}', body: 'x', html: '<p>{{code}}</p><script>alert(1)</script>' } });
  assert.ok(!script.ok && /Scripts/.test(script.errors['verify.html']!));
  // in the HTML, values are escaped and keep their line breaks
  assert.equal(renderMail({ subject: 's', body: 'b', html: '<div>{{reply}}</div>' }, { reply: 'Use <b>A</b>\nthen B' }).html, '<div>Use &lt;b&gt;A&lt;/b&gt;<br>then B</div>');
  // values are not filled in again (a reply that contains {{code}} stays as typed)
  assert.deepEqual(renderMail({ subject: 'Re: {{ticketSubject}}', body: '{{reply}}\n{{missing}}', html: '' }, { reply: 'Use {{code}}', ticketSubject: 'Help\nme' }), { subject: 'Re: Help me', text: 'Use {{code}}\n' });
  assert.equal(fullTemplates({ verify: { subject: 'S' } }).verify.subject, '{{code}} is your PosiNext code', 'a broken saved template is the default');
});

test('SMTP on the admin page: closed sign-up opens, codes go through it with the edited template, password never shown, removal guarded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-mail-'));
  const smtp = await fakeSmtp();
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), smtpOverrides: { tls: false } }); // no mailer from the server: the log
  try {
    assert.deepEqual(hub.mailSetup(), { source: 'none', configured: false });
    assert.equal(hub.accounts.open, false, 'sign-up is closed without email');
    assert.equal(hub.adminOverview().hub.mailProvider, false);
    await assert.rejects(hub.testMail('me@example.com', 'verify'), { code: 'MAIL_NOT_SET_UP' });

    assert.throws(() => hub.saveMailSetup({ host: 'smtp gmail', port: 'x', user: '' }), (e: { code: string; details: { fields: Record<string, string> } }) =>
      e.code === 'VALIDATION' && ['host', 'port', 'user', 'pass', 'from'].every((k) => Boolean(e.details.fields[k])));
    const saved = hub.saveMailSetup({ host: '127.0.0.1', port: smtp.port, user: 'Support@SpiceGarden.in', pass: 'app-pass', fromName: 'Spice "Garden"' });
    assert.deepEqual(saved, { source: 'admin', configured: true, host: '127.0.0.1', port: smtp.port, security: 'tls', user: 'Support@SpiceGarden.in', from: 'support@spicegarden.in', fromName: 'Spice Garden', passwordEnding: 'pass' });
    assert.equal(hub.saveMailSetup({ host: 'smtp.office365.com', port: 587, user: 'a@b.com', pass: 'app-pass' }).security, 'starttls', 'port 587: STARTTLS');
    hub.saveMailSetup({ host: '127.0.0.1', port: smtp.port, security: 'tls', user: 'support@spicegarden.in', pass: '', from: 'hello@spicegarden.in', fromName: 'Spice Garden' }); // empty: keeps the password
    assert.equal(hub.mailSetup().source === 'admin' && hub.mailSetup().passwordEnding, 'pass');
    assert.equal(hub.accounts.open, true);
    assert.ok(!JSON.stringify(hub.adminOverview()).includes('app-pass'));
    assert.equal(hub.adminOverview().hub.mailProvider, true);

    // the edited verification email is what a new account gets
    hub.saveMailTemplates({ verify: { subject: 'Spice Garden code: {{code}}', body: 'Hi! Your code is {{code}} ({{minutes}} minutes).' } });
    await hub.accounts.signup(SIGNUP);
    const m = smtp.sessions.at(-1)!;
    assert.deepEqual(m.to, ['asha@spicegarden.in']);
    assert.match(m.data, /^From: "Spice Garden" <hello@spicegarden\.in>\r\n/m);
    assert.match(decodeSubject(m.data), /^Spice Garden code: \d{6}$/);
    assert.match(decodeBody(m.data), /^Hi! Your code is \d{6} \(10 minutes\)\.$/);
    // the HTML version goes with it (the default design), with the same code
    const code = /\d{6}/.exec(decodeBody(m.data))![0];
    assert.match(m.data, /Content-Type: multipart\/alternative/);
    assert.ok(decodeHtml(m.data)!.includes(`>${code}</div>`), 'the code is in the HTML');

    // the test email: the saved template with example values
    assert.deepEqual(await hub.testMail('Me@Example.com', 'reset'), { sent: true, to: 'me@example.com', template: 'reset' });
    assert.equal(decodeSubject(smtp.sessions.at(-1)!.data), '[Test] Reset your PosiNext password');
    assert.match(decodeBody(smtp.sessions.at(-1)!.data), /482913/);
    await assert.rejects(hub.testMail('not-an-email', 'verify'), { code: 'VALIDATION' });

    // a mail server that refuses: the reason comes back
    hub.saveMailSetup({ host: '127.0.0.1', port: smtp.port, user: 'support@spicegarden.in', pass: 'wrong' });
    await assert.rejects(hub.testMail('me@example.com', 'verify'), (e: { code: string; message: string }) => e.code === 'MAIL_FAILED' && /535/.test(e.message));

    // email verification is on (the default): removing would close sign-up
    assert.throws(() => hub.removeMailSetup(), { code: 'MAIL_IN_USE' });
    hub.saveSettings({ checks: { emailVerification: { portal: false } } });
    assert.deepEqual(hub.removeMailSetup(), { source: 'none', configured: false });
    assert.equal(hub.mailSender().kind, 'log');
  } finally { hub.close(); await smtp.close(); cleanup(dir); }
});

test('templates: saved changes only, reset to default, support answers use theirs', async () => {
  const h = await startHub(); // the test hub has a mailer from the server
  try {
    const v = hub(h);
    assert.equal(v.templates.every((t) => !t.changed), true);
    await v.save({ ticketReply: { subject: 'Ticket {{ticketNumber}} answered', body: '{{reply}}\n\nThe {{staffName}}' } });
    assert.equal((await v.get()).templates.find((t) => t.id === 'ticketReply')!.changed, true);
    // saving the default text again is the same as no change
    const d = (await v.get()).templates.find((t) => t.id === 'verify')!.default;
    await v.save({ verify: d });
    assert.equal(h.hub.mailTemplatesView().templates.find((t) => t.id === 'verify')!.changed, false);
    const bad = await h.call('PUT', '/v1/admin/mail-templates', { admin: true, body: { reset: { subject: 'Reset', body: 'No code' } } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.details.fields['reset.body'], /\{\{code\}\}/);

    const t = h.hub.mailTemplates().ticketReply;
    assert.equal(t.subject, 'Ticket {{ticketNumber}} answered');
    await v.save({ ticketReply: null });
    assert.equal(h.hub.mailTemplates().ticketReply.subject, 'Re: [Ticket #{{ticketNumber}}] {{ticketSubject}}');
  } finally { await h.close(); cleanup(h.dir); }

  function hub(h: Awaited<ReturnType<typeof startHub>>) {
    const get = async () => (await h.call('GET', '/v1/admin/mail-templates', { admin: true })).json as ReturnType<Hub['mailTemplatesView']>;
    const save = async (body: unknown) => { const r = await h.call('PUT', '/v1/admin/mail-templates', { admin: true, body }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
    return { templates: h.hub.mailTemplatesView().templates, get, save };
  }
});

test('mail routes: admin only; email set on the server cannot be changed here, but can be tested', async () => {
  const h = await startHub();
  try {
    assert.equal((await h.call('GET', '/v1/admin/mail')).status, 403);
    assert.equal((await h.call('GET', '/v1/admin/mail-templates')).status, 403);
    assert.deepEqual((await h.call('GET', '/v1/admin/mail', { admin: true })).json, { source: 'server', configured: true, kind: 'test' });
    const put = await h.call('PUT', '/v1/admin/mail', { admin: true, body: { host: 'smtp.gmail.com', user: 'a@b.com', pass: 'x' } });
    assert.equal(put.status, 409);
    assert.equal(put.json.error.code, 'SET_ON_SERVER');
    assert.equal((await h.call('DELETE', '/v1/admin/mail', { admin: true })).status, 409);
    const sent = await h.call('POST', '/v1/admin/mail/test', { admin: true, body: { to: 'me@example.com', template: 'verify' } });
    assert.equal(sent.status, 200);
    assert.equal(h.mail.at(-1)!.subject, '[Test] 482913 is your PosiNext code');
  } finally { await h.close(); cleanup(h.dir); }
});
