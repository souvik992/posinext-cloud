import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailerFromEnv, smtpMailer, smtpMessage } from '../src/mailer.ts';
import { decodeBody, fakeSmtp, TEST_TLS } from './fake-smtp.ts';

// The SMTP mailer (e.g. Zoho Mail for support@posinext.com), against a small stand-in SMTP server.

test('smtp: signs in, sends from support@ with a Reply-To, body intact (UTF-8, lines starting with a dot)', async () => {
  const smtp = await fakeSmtp();
  try {
    const mailer = smtpMailer({ host: '127.0.0.1', port: smtp.port, tls: false, user: 'support@posinext.com', pass: 'app-pass', from: 'support@posinext.com', fromName: 'POSINEXT' });
    assert.equal(mailer.kind, 'smtp');
    await mailer.send({ to: 'sales@example.com', subject: 'Demo request: Café Spice (Asha)', text: 'Line one\n.starts with a dot\n₹ 1,200', replyTo: 'asha@spice.in' });
    const s = smtp.sessions[0]!;
    assert.deepEqual(s.lines.filter((l) => /^(MAIL|RCPT)/.test(l)), ['MAIL FROM:<support@posinext.com>', 'RCPT TO:<sales@example.com>']);
    assert.equal(Buffer.from(s.lines[2]!, 'base64').toString(), 'support@posinext.com');
    assert.match(s.data, /^From: "POSINEXT" <support@posinext\.com>\r\n/m);
    assert.match(s.data, /\r\nReply-To: <asha@spice\.in>\r\n/);
    assert.match(s.data, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
    assert.equal(decodeBody(s.data), 'Line one\r\n.starts with a dot\r\n₹ 1,200');
  } finally { await smtp.close(); }
});

test('smtp: a wrong password is an error naming the sign-in; bad addresses and header injection are refused', async () => {
  const smtp = await fakeSmtp({ password: 'right' });
  try {
    const mailer = smtpMailer({ host: '127.0.0.1', port: smtp.port, tls: false, user: 'support@posinext.com', pass: 'wrong', from: 'support@posinext.com' });
    await assert.rejects(mailer.send({ to: 'a@b.com', subject: 'x', text: 'y' }), /sign-in.*535/);
    await assert.rejects(mailer.send({ to: 'a@b.com>\r\nBcc: x@y.com', subject: 'x', text: 'y' }), /Not an email address/);
    const msg = smtpMessage({ from: 'support@posinext.com' }, { to: 'a@b.com', subject: 'Hi\r\nBcc: evil@x.com', text: 'y' });
    assert.ok(!/\r\nBcc:/.test(msg));
  } finally { await smtp.close(); }
  // nothing listening: fails rather than hangs
  await assert.rejects(smtpMailer({ host: '127.0.0.1', port: smtp.port, tls: false, user: 'u@x.com', pass: 'p', from: 'u@x.com', timeoutMs: 2000 }).send({ to: 'a@b.com', subject: 'x', text: 'y' }));
});

test('mailerFromEnv: Brevo first, then SMTP (port 465, from = the user), else the log', () => {
  const log = { info: () => undefined };
  assert.equal(mailerFromEnv({ HUB_BREVO_API_KEY: 'k', HUB_MAIL_FROM: 'a@b.com', HUB_SMTP_HOST: 'h', HUB_SMTP_USER: 'u@b.com', HUB_SMTP_PASS: 'p' }, log).kind, 'brevo');
  assert.equal(mailerFromEnv({ HUB_SMTP_HOST: 'smtppro.zoho.in', HUB_SMTP_USER: 'support@posinext.com', HUB_SMTP_PASS: 'p' }, log).kind, 'smtp');
  assert.equal(mailerFromEnv({ HUB_SMTP_HOST: 'smtppro.zoho.in', HUB_SMTP_USER: 'support@posinext.com' }, log).kind, 'log');
  assert.equal(mailerFromEnv({}, log).kind, 'log');
});

test('smtp: STARTTLS (port 587): plain hello, then TLS before the password; a server without it is an error', async () => {
  const smtp = await fakeSmtp({ starttls: true });
  try {
    const mailer = smtpMailer({ host: '127.0.0.1', port: smtp.port, security: 'starttls', ca: TEST_TLS.cert, user: 'support@posinext.com', pass: 'app-pass', from: 'support@posinext.com' });
    await mailer.send({ to: 'asha@spice.in', subject: 'Hello', text: 'Over TLS' });
    const s = smtp.sessions[0]!;
    assert.equal(s.tls, true);
    assert.deepEqual(s.lines.slice(0, 3).map((l) => l.split(' ')[0]), ['EHLO', 'STARTTLS', 'EHLO']);
    assert.deepEqual(s.to, ['asha@spice.in']);
    assert.equal(decodeBody(s.data), 'Over TLS');
    // a certificate that is not trusted is refused (no ca: the self-signed test certificate)
    await assert.rejects(smtpMailer({ host: '127.0.0.1', port: smtp.port, security: 'starttls', user: 'u@x.com', pass: 'p', from: 'u@x.com', timeoutMs: 3000 }).send({ to: 'a@b.com', subject: 'x', text: 'y' }), /certificate/i);
  } finally { await smtp.close(); }
  const plain = await fakeSmtp();
  try {
    await assert.rejects(smtpMailer({ host: '127.0.0.1', port: plain.port, security: 'starttls', user: 'u@x.com', pass: 'p', from: 'u@x.com', timeoutMs: 3000 }).send({ to: 'a@b.com', subject: 'x', text: 'y' }), /STARTTLS/);
  } finally { await plain.close(); }
});

