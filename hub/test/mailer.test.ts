import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { mailerFromEnv, smtpMailer, smtpMessage } from '../src/mailer.ts';

// The SMTP mailer (e.g. Zoho Mail for support@posinext.com), against a small stand-in SMTP server.
interface Session { lines: string[]; data: string }
function fakeSmtp(o: { password?: string } = {}) {
  const sessions: Session[] = [];
  const server = createServer((sock: Socket) => {
    const s: Session = { lines: [], data: '' };
    sessions.push(s);
    let buf = '', inData = false, step = 0;
    const say = (l: string) => sock.write(l + '\r\n');
    say('220 fake.smtp ready');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        s.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false; say('250 2.0.0 queued');
      }
      for (let i = buf.indexOf('\r\n'); i >= 0 && !inData; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); s.lines.push(line);
        if (/^EHLO/.test(line)) { sock.write('250-fake.smtp\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n'); }
        else if (line === 'AUTH LOGIN') { step = 1; say('334 VXNlcm5hbWU6'); }
        else if (step === 1) { step = 2; say('334 UGFzc3dvcmQ6'); }
        else if (step === 2) { step = 0; Buffer.from(line, 'base64').toString() === (o.password ?? 'app-pass') ? say('235 2.7.0 ok') : say('535 5.7.8 Authentication failed'); }
        else if (/^MAIL FROM|^RCPT TO/.test(line)) say('250 ok');
        else if (line === 'DATA') { inData = true; say('354 go ahead'); if (buf.includes('\r\n.\r\n')) sock.emit('data', Buffer.alloc(0)); }
        else if (line === 'QUIT') { say('221 bye'); sock.end(); }
      }
    });
  });
  return new Promise<{ port: number; sessions: Session[]; close(): Promise<void> }>((res) => server.listen(0, '127.0.0.1', () => res({
    port: (server.address() as { port: number }).port, sessions,
    close: () => new Promise<void>((r) => server.close(() => r())),
  })));
}

const decodeBody = (data: string) => Buffer.from(data.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8');

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
