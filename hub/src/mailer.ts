/**
 * Email for customer accounts (P7-01, ADR-0006). One small interface so the provider can change:
 *   brevoMailer  Brevo's transactional email API (free plan: 300 emails a day), called with fetch
 *   smtpMailer   any mailbox's SMTP server over TLS (e.g. Zoho Mail: support@posinext.com via smtppro.zoho.in:465)
 *   logMailer    development: the message (and its code) goes to the server log; never use in production
 */

import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

/** replyTo: where a reply goes (e.g. the restaurant that asked for a demo). */
export interface Mail { to: string; subject: string; text: string; replyTo?: string }
export interface Mailer {
  /** 'log' is development only: sign-up is refused in production with it. */
  kind: 'brevo' | 'smtp' | 'log' | 'test';
  send(mail: Mail): Promise<void>;
}

export function logMailer(log: { info(m: string, d?: unknown): void }): Mailer {
  return { kind: 'log', send: async (m) => log.info(`email to ${m.to}: ${m.subject}`, m.text) };
}

export function brevoMailer(o: { apiKey: string; from: string; fromName?: string; fetch?: typeof fetch }): Mailer {
  const f = o.fetch ?? fetch;
  return {
    kind: 'brevo',
    async send(m) {
      const r = await f('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': o.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { email: o.from, name: o.fromName ?? 'DinePOS' }, to: [{ email: m.to }], ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}), subject: m.subject, textContent: m.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`Brevo refused the email (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
    },
  };
}

export interface SmtpOptions {
  host: string; port?: number; user: string; pass: string; from: string; fromName?: string;
  /** false: plain TCP (tests only). Default: TLS from the first byte (port 465). */
  tls?: boolean;
  timeoutMs?: number;
}

const CRLF = '\r\n';
const ADDRESS = /^[^\s<>@,;:"]+@[^\s<>@,;:"]+$/;
/** A header value on one line: plain ASCII as is, anything else as an RFC 2047 encoded word. */
const header = (v: string): string => {
  const one = v.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(one) ? one : `=?UTF-8?B?${Buffer.from(one, 'utf8').toString('base64')}?=`;
};

/** The message sent after DATA: CRLF lines, the body in base64 (so no line starts with a dot). */
export function smtpMessage(o: { from: string; fromName?: string }, m: Mail, now = new Date()): string {
  const domain = o.from.split('@')[1] ?? 'localhost';
  const name = o.fromName ? header(o.fromName.replace(/["\\]/g, '')) : '';
  const body = Buffer.from(m.text.replace(/\r?\n/g, CRLF), 'utf8').toString('base64').match(/.{1,76}/g) ?? [];
  return [
    `From: ${name ? `"${name}" ` : ''}<${o.from}>`,
    `To: <${m.to}>`,
    ...(m.replyTo ? [`Reply-To: <${m.replyTo}>`] : []),
    `Subject: ${header(m.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...body,
  ].join(CRLF);
}

interface Reply { code: number; text: string }

/** Reads SMTP replies from a socket (a multi-line reply ends with "NNN " on its last line). */
function replyReader(sock: Socket) {
  let buf = '';
  let lines: string[] = [];
  const ready: Reply[] = [];
  const waiting: Array<(r: Reply) => void> = [];
  let ended: string | null = null;
  const push = (r: Reply) => { const w = waiting.shift(); if (w) w(r); else ready.push(r); };
  sock.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (!/^\d{3}-/.test(line)) { push({ code: Number(line.slice(0, 3)) || 0, text: lines.join(' | ') }); lines = []; }
    }
  });
  const end = (why: string) => { ended ??= why; for (const w of waiting.splice(0)) w({ code: 0, text: ended }); };
  sock.on('error', (e) => end(e.message));
  sock.on('close', () => end('The mail server closed the connection.'));
  sock.on('timeout', () => { end('The mail server did not answer in time.'); sock.destroy(); });
  return () => new Promise<Reply>((res) => {
    const r = ready.shift();
    if (r) res(r); else if (ended) res({ code: 0, text: ended }); else waiting.push(res);
  });
}

async function smtpSend(o: SmtpOptions, m: Mail): Promise<void> {
  for (const a of [m.to, o.from, ...(m.replyTo ? [m.replyTo] : [])]) if (!ADDRESS.test(a)) throw new Error(`Not an email address: ${a}`);
  const port = o.port ?? 465;
  const sock: Socket = o.tls === false ? netConnect({ host: o.host, port }) : tlsConnect({ host: o.host, port, servername: o.host });
  sock.setTimeout(o.timeoutMs ?? 20_000);
  const next = replyReader(sock);
  const expect = async (want: number, what: string) => {
    const r = await next();
    if (r.code !== want) throw new Error(`Mail server refused ${what}: ${r.text.slice(0, 200)}`);
  };
  const send = async (line: string, want: number, what: string) => { sock.write(line + CRLF); await expect(want, what); };
  try {
    await expect(220, 'the connection');
    await send(`EHLO ${o.from.split('@')[1] ?? 'localhost'}`, 250, 'EHLO');
    await send('AUTH LOGIN', 334, 'AUTH LOGIN');
    await send(Buffer.from(o.user, 'utf8').toString('base64'), 334, 'the user name');
    await send(Buffer.from(o.pass, 'utf8').toString('base64'), 235, 'the sign-in (check HUB_SMTP_USER and HUB_SMTP_PASS)');
    await send(`MAIL FROM:<${o.from}>`, 250, 'the sender');
    await send(`RCPT TO:<${m.to}>`, 250, 'the recipient');
    await send('DATA', 354, 'DATA');
    await send(smtpMessage(o, m) + CRLF + '.', 250, 'the message');
    sock.write('QUIT' + CRLF);
  } finally {
    sock.end();
    setTimeout(() => sock.destroy(), 1000).unref();
  }
}

/** Sends through a mailbox's own SMTP server (TLS on port 465, AUTH LOGIN). */
export function smtpMailer(o: SmtpOptions): Mailer {
  return { kind: 'smtp', send: (m) => smtpSend(o, m) };
}

/**
 * The mailer from the environment: HUB_BREVO_API_KEY + HUB_MAIL_FROM (Brevo); else HUB_SMTP_HOST + HUB_SMTP_USER +
 * HUB_SMTP_PASS (HUB_SMTP_PORT default 465; HUB_MAIL_FROM default the user); else the log (development).
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv, log: { info(m: string, d?: unknown): void }): Mailer {
  if (env.HUB_BREVO_API_KEY && env.HUB_MAIL_FROM) return brevoMailer({ apiKey: env.HUB_BREVO_API_KEY, from: env.HUB_MAIL_FROM, fromName: env.HUB_MAIL_FROM_NAME || undefined });
  if (env.HUB_SMTP_HOST && env.HUB_SMTP_USER && env.HUB_SMTP_PASS) {
    return smtpMailer({
      host: env.HUB_SMTP_HOST, port: Number(env.HUB_SMTP_PORT) || 465, user: env.HUB_SMTP_USER, pass: env.HUB_SMTP_PASS,
      from: env.HUB_MAIL_FROM || env.HUB_SMTP_USER, fromName: env.HUB_MAIL_FROM_NAME || undefined,
    });
  }
  return logMailer(log);
}
