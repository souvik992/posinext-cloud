import { randomUUID } from 'node:crypto';
import { exec, many, one, tx } from './db.ts';
import type { Db } from './db.ts';
import { HubError } from './hub.ts';
import type { Hub } from './hub.ts';
import { productOf, type ProductCode } from './products.ts';

/**
 * Support in the customer portal (P8-08, ADR-0007): tickets with replies (customer and vendor), announcements and a
 * knowledge base the vendor writes on the admin page. Tickets belong to an account; everyone in the account sees them.
 * A vendor reply emails the customer who opened the ticket.
 */

export type TicketStatus = 'open' | 'answered' | 'closed';
export interface TicketMessage { id: string; from: 'customer' | 'staff'; name: string; body: string; at: number }
export interface Ticket {
  id: string; number: number; subject: string; product: ProductCode | null; status: TicketStatus; createdAt: number; updatedAt: number;
  account?: { id: string; name: string }; openedBy?: { name: string; email: string };
  messages?: TicketMessage[];
}
export interface Announcement { id: string; title: string; body: string; product: ProductCode | null; publishedAt: number }
export interface Article { slug: string; title: string; body: string; category: string; product: ProductCode | null; updatedAt: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticket (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES account(id), user_id TEXT NOT NULL REFERENCES account_user(id),
  subject TEXT NOT NULL, product TEXT, status TEXT NOT NULL CHECK (status IN ('open','answered','closed')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_account ON ticket(account_id, updated_at);
CREATE INDEX IF NOT EXISTS ticket_status ON ticket(status, updated_at);
CREATE TABLE IF NOT EXISTS ticket_message (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES ticket(id), author TEXT NOT NULL CHECK (author IN ('customer','staff')),
  author_name TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_message_ticket ON ticket_message(ticket_id, at);
CREATE TABLE IF NOT EXISTS announcement (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, product TEXT, published_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kb_article (
  slug TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL, product TEXT, sort INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
`;

interface TicketRow { id: string; number: number; account_id: string; user_id: string; subject: string; product: ProductCode | null; status: TicketStatus; created_at: number; updated_at: number }

const text = (v: unknown, label: string, field: string, max: number, min = 1): string => {
  const s = String(v ?? '').replace(/\r\n/g, '\n').trim();
  if (s.length < min) throw new HubError('VALIDATION', `Enter ${label}.`, 400, { fields: { [field]: `Enter ${label}.` } });
  if (s.length > max) throw new HubError('VALIDATION', `${label[0]!.toUpperCase()}${label.slice(1)} is too long (at most ${max} characters).`, 400, { fields: { [field]: `At most ${max} characters.` } });
  return s;
};
/** A product, or null for "both / not about one product". */
const optionalProduct = (v: unknown): ProductCode | null => {
  if (v === undefined || v === null || v === '') return null;
  const p = productOf(v);
  if (!p) throw new HubError('VALIDATION', 'Unknown product.', 400, { fields: { product: 'Unknown product.' } });
  return p;
};

export class Support {
  private hub: Hub;
  private notifyTo: string | undefined;
  private log: { warn(m: string): void };
  private get db(): Db { return this.hub.db; }
  /** `notifyTo`: the support inbox that gets each new ticket and each customer reply (HUB_SUPPORT_NOTIFY_TO). Not set: none. */
  constructor(hub: Hub, notifyTo?: string, log: { warn(m: string): void } = console) {
    this.hub = hub;
    this.notifyTo = notifyTo?.trim() || undefined;
    this.log = log;
    hub.db.exec(SCHEMA);
  }

  /** Emails the support inbox about a customer's message; "Reply" there goes to the customer. Saved either way. */
  private async notify(t: Ticket, body: string, isNew: boolean): Promise<void> {
    if (!this.notifyTo) return;
    const account = one<{ name: string; phone: string }>(this.db, 'SELECT a.name, a.phone FROM ticket t JOIN account a ON a.id = t.account_id WHERE t.id = ?', t.id);
    const by = t.openedBy;
    const text = [
      isNew ? `New support ticket #${t.number} from the customer portal` : `New reply on ticket #${t.number}`, '',
      `Business:  ${account?.name ?? '-'}`, `Phone:     ${account?.phone ?? '-'}`,
      `From:      ${by ? `${by.name} <${by.email}>` : '-'}`, `Product:   ${t.product ?? '-'}`, `Subject:   ${t.subject}`, '',
      body, '',
      'Answer on the admin page (Support), so the customer sees it in the portal too.',
    ].join('\n');
    try {
      await this.hub.mailer.send({ to: this.notifyTo, subject: `${isNew ? '' : 'Re: '}[Ticket #${t.number}] ${t.subject}`, text, ...(by ? { replyTo: by.email } : {}) });
    } catch (e) {
      this.log.warn(`ticket #${t.number} saved but the support inbox was not emailed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---------------------------------------------------------------- tickets (customer)

  /** A customer's new ticket: the subject, the product it is about (optional) and the first message. */
  async open(token: string | undefined, input: unknown): Promise<Ticket> {
    const u = this.hub.accounts.session(token);
    const b = (input ?? {}) as Record<string, unknown>;
    const subject = text(b.subject, 'a subject', 'subject', 120);
    const product = optionalProduct(b.product);
    const body = text(b.body, 'your message', 'body', 5000);
    const id = randomUUID(), at = this.hub.now();
    tx(this.db, () => {
      const number = (one<{ n: number | null }>(this.db, 'SELECT MAX(number) AS n FROM ticket')!.n ?? 1000) + 1;
      exec(this.db, "INSERT INTO ticket (id, number, account_id, user_id, subject, product, status, created_at, updated_at) VALUES (?,?,?,?,?,?,'open',?,?)", id, number, u.account_id, u.id, subject, product, at, at);
      exec(this.db, "INSERT INTO ticket_message (id, ticket_id, author, author_name, body, at) VALUES (?,?,'customer',?,?,?)", randomUUID(), id, u.name, body, at);
    });
    const t = this.ticket(id, true);
    await this.notify(t, body, true);
    return t;
  }

  mine(token: string | undefined): Ticket[] {
    const u = this.hub.accounts.session(token);
    return many<TicketRow>(this.db, 'SELECT * FROM ticket WHERE account_id = ? ORDER BY updated_at DESC LIMIT 200', u.account_id).map((r) => this.view(r, false));
  }

  oneOfMine(token: string | undefined, id: string): Ticket {
    const u = this.hub.accounts.session(token);
    const r = one<TicketRow>(this.db, 'SELECT * FROM ticket WHERE id = ? AND account_id = ?', id, u.account_id);
    if (!r) throw new HubError('NOT_FOUND', 'No such ticket.', 404);
    return this.view(r, true);
  }

  /** A customer's reply opens a closed or answered ticket again. */
  async reply(token: string | undefined, id: string, input: unknown): Promise<Ticket> {
    const t = this.oneOfMine(token, id);
    const u = this.hub.accounts.session(token);
    const body = text((input as Record<string, unknown> | null)?.body, 'your message', 'body', 5000);
    const at = this.hub.now();
    tx(this.db, () => {
      exec(this.db, "INSERT INTO ticket_message (id, ticket_id, author, author_name, body, at) VALUES (?,?,'customer',?,?,?)", randomUUID(), t.id, u.name, body, at);
      exec(this.db, "UPDATE ticket SET status = 'open', updated_at = ? WHERE id = ?", at, t.id);
    });
    const after = this.ticket(t.id, true);
    await this.notify(after, body, false);
    return after;
  }

  closeMine(token: string | undefined, id: string): Ticket {
    const t = this.oneOfMine(token, id);
    exec(this.db, "UPDATE ticket SET status = 'closed', updated_at = ? WHERE id = ?", this.hub.now(), t.id);
    return this.ticket(t.id, true);
  }

  // ---------------------------------------------------------------- tickets (vendor, admin page)

  /** Waiting for us first (open), then answered, then closed; newest first in each. */
  adminList(): Ticket[] {
    return many<TicketRow>(this.db, `SELECT * FROM ticket ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END, updated_at DESC LIMIT 300`)
      .map((r) => this.view(r, false, true));
  }

  adminGet(id: string): Ticket { return this.ticket(id, true, true); }

  /** The vendor's answer: the ticket is "answered" and the customer who opened it gets an email. */
  async adminReply(id: string, input: unknown): Promise<Ticket> {
    const t = this.ticket(id, true, true);
    const b = (input ?? {}) as Record<string, unknown>;
    const body = text(b.body, 'the answer', 'body', 5000);
    const name = String(b.name ?? '').trim().slice(0, 60) || 'Support team';
    const at = this.hub.now();
    tx(this.db, () => {
      exec(this.db, "INSERT INTO ticket_message (id, ticket_id, author, author_name, body, at) VALUES (?,?,'staff',?,?,?)", randomUUID(), t.id, name, body, at);
      exec(this.db, "UPDATE ticket SET status = ?, updated_at = ? WHERE id = ?", b.close === true ? 'closed' : 'answered', at, t.id);
    });
    if (t.openedBy) {
      await this.hub.mailer.send({
        to: t.openedBy.email,
        subject: `Re: [Ticket #${t.number}] ${t.subject}`,
        text: `${body}\n\n— ${name}\n\nSee the whole conversation and reply in your client area: Support tickets › #${t.number}.`,
      }).catch(() => undefined); // the answer is saved either way; the portal shows it
    }
    return this.ticket(t.id, true, true);
  }

  adminClose(id: string): Ticket {
    const t = this.ticket(id, false, true);
    exec(this.db, "UPDATE ticket SET status = 'closed', updated_at = ? WHERE id = ?", this.hub.now(), t.id);
    return this.ticket(t.id, true, true);
  }

  private ticket(id: string, withMessages: boolean, forAdmin = false): Ticket {
    const r = one<TicketRow>(this.db, 'SELECT * FROM ticket WHERE id = ?', id);
    if (!r) throw new HubError('NOT_FOUND', 'No such ticket.', 404);
    return this.view(r, withMessages, forAdmin);
  }

  private view(r: TicketRow, withMessages: boolean, forAdmin = false): Ticket {
    const t: Ticket = { id: r.id, number: r.number, subject: r.subject, product: r.product, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
    const opener = one<{ name: string; email: string }>(this.db, 'SELECT name, email FROM account_user WHERE id = ?', r.user_id);
    if (opener) t.openedBy = opener;
    if (forAdmin) t.account = one<{ id: string; name: string }>(this.db, 'SELECT id, name FROM account WHERE id = ?', r.account_id)!;
    if (withMessages) {
      t.messages = many<{ id: string; author: 'customer' | 'staff'; author_name: string; body: string; at: number }>(this.db,
        'SELECT id, author, author_name, body, at FROM ticket_message WHERE ticket_id = ? ORDER BY at, rowid', r.id)
        .map((m) => ({ id: m.id, from: m.author, name: m.author_name, body: m.body, at: m.at }));
    }
    return t;
  }

  // ---------------------------------------------------------------- announcements and the knowledge base

  /** Public: newest first; `product` narrows to one product's news (and news for everyone). */
  announcements(product?: unknown): Announcement[] {
    const p = product === undefined || product === null || product === '' ? null : productOf(product);
    return many<{ id: string; title: string; body: string; product: ProductCode | null; published_at: number }>(this.db,
      'SELECT * FROM announcement WHERE (? IS NULL OR product IS NULL OR product = ?) ORDER BY published_at DESC LIMIT 50', p, p)
      .map((a) => ({ id: a.id, title: a.title, body: a.body, product: a.product, publishedAt: a.published_at }));
  }

  announce(input: unknown): Announcement {
    const b = (input ?? {}) as Record<string, unknown>;
    const title = text(b.title, 'a title', 'title', 140);
    const body = text(b.body, 'the text', 'body', 10_000);
    const product = optionalProduct(b.product);
    const id = randomUUID(), at = this.hub.now();
    exec(this.db, 'INSERT INTO announcement (id, title, body, product, published_at) VALUES (?,?,?,?,?)', id, title, body, product, at);
    return { id, title, body, product, publishedAt: at };
  }

  unannounce(id: string): { ok: true } {
    if (exec(this.db, 'DELETE FROM announcement WHERE id = ?', id).changes === 0) throw new HubError('NOT_FOUND', 'No such announcement.', 404);
    return { ok: true };
  }

  /** Public: every article without its body (the list), by category. */
  articles(): Array<Omit<Article, 'body'>> {
    return many<{ slug: string; title: string; category: string; product: ProductCode | null; updated_at: number }>(this.db,
      'SELECT slug, title, category, product, updated_at FROM kb_article ORDER BY category, sort, title')
      .map((a) => ({ slug: a.slug, title: a.title, category: a.category, product: a.product, updatedAt: a.updated_at }));
  }

  article(slug: string): Article {
    const a = one<{ slug: string; title: string; body: string; category: string; product: ProductCode | null; updated_at: number }>(this.db, 'SELECT * FROM kb_article WHERE slug = ?', slug);
    if (!a) throw new HubError('NOT_FOUND', 'No such article.', 404);
    return { slug: a.slug, title: a.title, body: a.body, category: a.category, product: a.product, updatedAt: a.updated_at };
  }

  /** Writes or replaces an article (by its slug). */
  saveArticle(input: unknown): Article {
    const b = (input ?? {}) as Record<string, unknown>;
    const title = text(b.title, 'a title', 'title', 140);
    const slug = String(b.slug ?? '').trim().toLowerCase() || title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) throw new HubError('VALIDATION', 'The address may have small letters, digits and dashes.', 400, { fields: { slug: 'Letters, digits and dashes.' } });
    const body = text(b.body, 'the text', 'body', 50_000);
    const category = text(b.category ?? 'General', 'a category', 'category', 60);
    const product = optionalProduct(b.product);
    const sort = Number.isInteger(b.sort) ? (b.sort as number) : 0;
    exec(this.db, `INSERT INTO kb_article (slug, title, body, category, product, sort, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(slug) DO UPDATE SET title = excluded.title, body = excluded.body, category = excluded.category, product = excluded.product, sort = excluded.sort, updated_at = excluded.updated_at`,
      slug, title, body, category, product, sort, this.hub.now());
    return this.article(slug);
  }

  deleteArticle(slug: string): { ok: true } {
    if (exec(this.db, 'DELETE FROM kb_article WHERE slug = ?', slug).changes === 0) throw new HubError('NOT_FOUND', 'No such article.', 404);
    return { ok: true };
  }
}
