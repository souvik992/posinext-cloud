import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';

// A small stand-in SMTP server for the mailer tests (plain TCP; with starttls, it offers STARTTLS and needs it).

/** A self-signed certificate for 127.0.0.1, for the STARTTLS tests only (trusted by passing it as `ca`). */
export const TEST_TLS = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgzcCOVHKZ5BS5ObmY
/+sRS2cxWUeGKVjpDx8m87bMtnShRANCAAS4ZyEj6/fqi7c8P8VMTPK1LobK8acr
FF3GfJOb4VM4Co5ihz9B93eghHJBXrIXNVafhb1hQawGqbYuxTkKuDOd
-----END PRIVATE KEY-----
`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBjzCCATagAwIBAgIUHUiLm+KnCt3RCKUZe1pFoAUYduwwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJZmFrZS5zbXRwMCAXDTI2MTEyMTA4MTQyM1oYDzIxMjYxMDI4
MDgxNDIzWjAUMRIwEAYDVQQDDAlmYWtlLnNtdHAwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAS4ZyEj6/fqi7c8P8VMTPK1LobK8acrFF3GfJOb4VM4Co5ihz9B93eg
hHJBXrIXNVafhb1hQawGqbYuxTkKuDOdo2QwYjAdBgNVHQ4EFgQU6C3s0esd1xUm
QhaqkSQiObpKOzwwHwYDVR0jBBgwFoAU6C3s0esd1xUmQhaqkSQiObpKOzwwDwYD
VR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0cAMEQC
IHH+/iFaNVpjFVZ154wakzoTC0NRSuMyf7Jgs9g4gO4oAiB+DCY2xQamzkKqRrap
x0CVg5HlU2ml0/0qr+bTj/yumg==
-----END CERTIFICATE-----
`,
};

export interface Session { lines: string[]; data: string; tls: boolean; to: string[] }

export function fakeSmtp(o: { password?: string; starttls?: boolean } = {}) {
  const sessions: Session[] = [];
  const server = createServer((raw: Socket) => {
    const s: Session = { lines: [], data: '', tls: false, to: [] };
    sessions.push(s);
    let buf = '', inData = false, step = 0;
    let io: Duplex = raw;
    const say = (l: string) => io.write(l + '\r\n');
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        s.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false; say('250 2.0.0 queued');
      }
      for (let i = buf.indexOf('\r\n'); i >= 0 && !inData; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); s.lines.push(line);
        if (/^EHLO/.test(line)) io.write(`250-fake.smtp\r\n${o.starttls && !s.tls ? '250-STARTTLS\r\n' : ''}250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n`);
        else if (line === 'STARTTLS' && o.starttls && !s.tls) {
          say('220 2.0.0 ready for TLS');
          raw.removeListener('data', onData);
          const secure = new TLSSocket(raw, { isServer: true, key: TEST_TLS.key, cert: TEST_TLS.cert });
          secure.on('error', () => undefined);
          secure.on('data', onData);
          io = secure; s.tls = true; buf = '';
          return;
        }
        else if (o.starttls && !s.tls && line !== 'QUIT') say('530 5.7.0 Must issue a STARTTLS command first');
        else if (line === 'AUTH LOGIN') { step = 1; say('334 VXNlcm5hbWU6'); }
        else if (step === 1) { step = 2; say('334 UGFzc3dvcmQ6'); }
        else if (step === 2) { step = 0; Buffer.from(line, 'base64').toString() === (o.password ?? 'app-pass') ? say('235 2.7.0 ok') : say('535 5.7.8 Authentication failed'); }
        else if (/^MAIL FROM/.test(line)) say('250 ok');
        else if (/^RCPT TO/.test(line)) { s.to.push(line.replace(/^RCPT TO:<(.*)>$/, '$1')); say('250 ok'); }
        else if (line === 'DATA') { inData = true; say('354 go ahead'); if (buf.includes('\r\n.\r\n')) onData(Buffer.alloc(0)); }
        else if (line === 'QUIT') { say('221 bye'); io.end(); }
        else say('502 5.5.2 Command not recognised');
      }
    };
    raw.on('error', () => undefined);
    raw.on('data', onData);
    say('220 fake.smtp ready');
  });
  return new Promise<{ port: number; sessions: Session[]; close(): Promise<void> }>((res) => server.listen(0, '127.0.0.1', () => res({
    port: (server.address() as { port: number }).port, sessions,
    close: () => new Promise<void>((r) => server.close(() => r())),
  })));
}

/** One part of a message as the mailer sends it (text/plain or text/html, base64), decoded; a plain message is its own text part. */
const part = (data: string, type: string) => {
  const at = data.indexOf(`Content-Type: ${type}`);
  if (at < 0) return undefined;
  const rest = data.slice(data.indexOf('\r\n\r\n', at) + 4);
  return Buffer.from(rest.split('\r\n--')[0]!.replace(/\r\n/g, ''), 'base64').toString('utf8');
};
/** The text of a message. */
export const decodeBody = (data: string) => part(data, 'text/plain')!;
/** The HTML version of a message, if it has one. */
export const decodeHtml = (data: string) => part(data, 'text/html');
/** The Subject header, decoded when it is an RFC 2047 word. */
export const decodeSubject = (data: string) => {
  const v = /\r\nSubject: (.*)\r\n/.exec(data)?.[1] ?? '';
  const w = /^=\?UTF-8\?B\?(.*)\?=$/.exec(v);
  return w ? Buffer.from(w[1]!, 'base64').toString('utf8') : v;
};
