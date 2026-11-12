import { randomUUID } from 'node:crypto';
import { exec, many } from './db.ts';
import type { Db } from './db.ts';
import { HubError } from './hub.ts';
import type { Hub } from './hub.ts';

/**
 * "Book a Demo" requests from the posinext.com website (a static site, so it posts here, CORS open, rate limited).
 * Each request is saved, then emailed to the sales address set on the server only (HUB_DEMO_REQUEST_TO): the address
 * never appears in the website or in any response. A request is kept even when the email cannot be sent; the admin can
 * list them (GET /v1/admin/demo-requests).
 */

export interface DemoRequest {
  id: string; name: string; phone: string; email: string; restaurant: string; city: string; outlets: string;
  message: string; source: string; at: number; mailed: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS demo_request (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL, restaurant TEXT NOT NULL,
  city TEXT NOT NULL, outlets TEXT NOT NULL, message TEXT NOT NULL, source TEXT NOT NULL, ip TEXT NOT NULL,
  at INTEGER NOT NULL, mailed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS demo_request_at ON demo_request(at);
`;

const bad = (field: string, msg: string) => new HubError('VALIDATION', msg, 400, { fields: { [field]: msg } });
const field = (b: Record<string, unknown>, k: string, max: number, required?: string): string => {
  const s = String(b[k] ?? '').replace(/\s+/g, ' ').trim();
  if (required && !s) throw bad(k, required);
  if (s.length > max) throw bad(k, `At most ${max} characters.`);
  return s;
};

export class DemoRequests {
  private hub: Hub;
  private to: string | undefined;
  private log: { warn(m: string): void };
  private get db(): Db { return this.hub.db; }
  /** `to`: where requests are emailed (HUB_DEMO_REQUEST_TO). Not set: they are only saved. */
  constructor(hub: Hub, to?: string, log: { warn(m: string): void } = console) {
    this.hub = hub;
    this.to = to?.trim() || undefined;
    this.log = log;
    hub.db.exec(SCHEMA);
  }

  /** A request from the website's demo form. Returns only { ok }: nothing about where it went. */
  async submit(input: unknown, ip: string): Promise<{ ok: true }> {
    const b = (input ?? {}) as Record<string, unknown>;
    // a field people never see: bots fill it in. Answer as if it worked, keep nothing.
    if (String(b.website ?? '').trim()) return { ok: true };
    const name = field(b, 'name', 100, 'Please enter your name');
    const phone = field(b, 'phone', 20, 'Please enter a valid phone number');
    if (!/^[+\d\s()-]{7,20}$/.test(phone)) throw bad('phone', 'Please enter a valid phone number');
    const email = field(b, 'email', 255);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('email', 'Please enter a valid email');
    const restaurant = field(b, 'restaurant', 150, 'Please enter your restaurant name');
    const city = field(b, 'city', 100), outlets = field(b, 'outlets', 20), source = field(b, 'source', 60);
    const message = String(b.message ?? '').replace(/\r\n/g, '\n').trim();
    if (message.length > 1000) throw bad('message', 'At most 1000 characters.');

    const id = randomUUID(), at = this.hub.now();
    exec(this.db, 'INSERT INTO demo_request (id, name, phone, email, restaurant, city, outlets, message, source, ip, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, name, phone, email, restaurant, city, outlets, message, source, ip, at);
    if (this.to) {
      const when = new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
      const text = [
        `New demo request from posinext.com (${when} IST)`, '',
        `Name:        ${name}`, `Phone:       ${phone}`, `Email:       ${email || '-'}`, `Restaurant:  ${restaurant}`,
        `City:        ${city || '-'}`, `Outlets:     ${outlets || '-'}`, `Button:      ${source || '-'}`, '',
        'What they are looking for:', message || '-',
      ].join('\n');
      try {
        await this.hub.mailer.send({ to: this.to, subject: `Demo request: ${restaurant} (${name})`, text, ...(email ? { replyTo: email } : {}) });
        exec(this.db, 'UPDATE demo_request SET mailed = 1 WHERE id = ?', id);
      } catch (e) {
        this.log.warn(`demo request ${id} saved but not emailed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { ok: true };
  }

  /** Newest first (the admin page). */
  list(limit = 200): DemoRequest[] {
    return many<Omit<DemoRequest, 'mailed'> & { mailed: number }>(this.db,
      'SELECT id, name, phone, email, restaurant, city, outlets, message, source, at, mailed FROM demo_request ORDER BY at DESC LIMIT ?', limit)
      .map((r) => ({ ...r, mailed: r.mailed === 1 }));
  }
}
