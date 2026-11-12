import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { exec, many, one } from './db.ts';
import { HubError } from './hub.ts';
import type { Hub } from './hub.ts';

/**
 * The instant browser demo (P7-04, ADR-0006). A signed-in portal user (email verified) presses "Try it in your
 * browser": the cloud makes a hosted outlet (P6-04) for them, sets it up with the sample outlet (menu, tables, staff
 * with PINs shown on screen) by sending ordinary commands to that outlet's own server (it stays the only writer),
 * licenses it with a 3-day key signed by this cloud (P7-02), pairs one browser terminal and hands its device token over
 * in the address fragment. The demo ends after 72 hours: its server stops and its data folder is deleted.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';

/** What the demo needs from hosted outlets (src/hosted.ts); tests give a stand-in. */
export interface DemoHost {
  readonly available: boolean;
  enable(slug: string): { port: number };
  ready(storeId: string, timeoutMs?: number): Promise<boolean>;
  call(storeId: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: unknown }>;
  remove(slug: string): Promise<void>;
}

export interface SeedCommand { type: string; payload: Record<string, unknown> }
export interface DemoSeed {
  setup: SeedCommand;
  commands: SeedCommand[];
  owner: { id: string; name: string; pin: string };
  staff: Array<{ id: string; name: string; pin: string }>;
}

export interface DemosOptions {
  host?: DemoHost;
  /** The sample outlet (cloud/outlet-server/demo-seed.json, written by `npm run bundle:cloud`). */
  seed: DemoSeed | string | null;
  /** The address devices use for an outlet (https://<slug>.<cloud>), or null when the cloud has no device domain. */
  outletUrl: (slug: string) => string | null;
  /** Demos running at once (HUB_MAX_DEMOS, default 10). */
  max?: number;
  /** Demos one account may start in all (default 3). */
  perAccount?: number;
  hours?: number;
  log?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
}

interface DemoRow {
  store_id: string; slug: string; account_id: string; user_id: string; state: 'starting' | 'ready' | 'failed' | 'ended';
  created_at: number; expires_at: number; ended_at: number | null; device_token: string | null; error: string | null;
}

export interface DemoView {
  slug: string;
  state: DemoRow['state'];
  /** Opens the billing terminal, already paired (the token is in the fragment: never sent to a server). */
  url: string | null;
  expiresAt: number;
  staff: Array<{ name: string; pin: string }>;
}

function ulidLike(): string {
  let t = Date.now(), time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32]! + time; t = Math.floor(t / 32); }
  let rest = '';
  for (let i = 0; i < 16; i++) rest += CROCKFORD[randomInt(32)];
  return time + rest;
}
const errOf = (r: { json: unknown }) => (r.json as { error?: { code?: string; message?: string } } | null)?.error;

export class Demos {
  private hub: Hub;
  private o: DemosOptions & { max: number; perAccount: number; hours: number };
  private seed: DemoSeed | null;
  private ending = new Set<string>();

  constructor(hub: Hub, o: DemosOptions) {
    this.hub = hub;
    this.o = { ...o, max: o.max ?? 10, perAccount: o.perAccount ?? 3, hours: o.hours ?? 72 };
    this.seed = typeof o.seed === 'string' ? (existsSync(o.seed) ? (JSON.parse(readFileSync(o.seed, 'utf8')) as DemoSeed) : null) : o.seed;
    exec(hub.db, `CREATE TABLE IF NOT EXISTS demo (
      store_id TEXT PRIMARY KEY REFERENCES store(id), slug TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES account(id), user_id TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_at INTEGER, device_token TEXT, error TEXT)`);
    exec(hub.db, 'CREATE INDEX IF NOT EXISTS demo_account ON demo(account_id)');
  }

  /** Why a browser demo cannot start on this cloud, or null. */
  unavailable(): string | null {
    if (!this.o.host?.available) return 'The browser demo is not set up on this cloud (no outlet server).';
    if (!this.hub.licences.ready) return 'The browser demo is not set up on this cloud (no licence signing key).';
    if (!this.seed) return 'The browser demo is not set up on this cloud (no demo-seed.json).';
    if (!this.o.outletUrl('x')) return 'The browser demo is not set up on this cloud (no device domain).';
    return null;
  }

  /** The account's live demo, if any. */
  current(token: string | undefined): { demo: DemoView | null; available: boolean; reason: string | null } {
    const u = this.hub.accounts.session(token);
    const r = one<DemoRow>(this.hub.db, "SELECT * FROM demo WHERE account_id = ? AND state IN ('starting','ready') AND expires_at > ? ORDER BY created_at DESC LIMIT 1", u.account_id, this.hub.now());
    const reason = this.unavailable();
    return { demo: r ? this.view(r) : null, available: reason === null, reason };
  }

  /** Starts a demo for the signed-in person's account (or returns the one already running). */
  async start(token: string | undefined): Promise<DemoView> {
    const u = this.hub.accounts.session(token);
    const live = one<DemoRow>(this.hub.db, "SELECT * FROM demo WHERE account_id = ? AND state IN ('starting','ready') AND expires_at > ? ORDER BY created_at DESC LIMIT 1", u.account_id, this.hub.now());
    if (live?.state === 'ready') return this.view(live);
    if (live) throw new HubError('DEMO_STARTING', 'Your demo is being made. Wait a few seconds.', 409);
    const reason = this.unavailable();
    if (reason) throw new HubError('NOT_AVAILABLE', reason, 503);
    const used = one<{ n: number }>(this.hub.db, "SELECT COUNT(*) AS n FROM demo WHERE account_id = ? AND state != 'failed'", u.account_id)!.n;
    if (used >= this.o.perAccount) throw new HubError('DEMO_LIMIT', 'You have used your browser demos. Start the free Windows trial, or contact us for more.', 409);
    const running = one<{ n: number }>(this.hub.db, "SELECT COUNT(*) AS n FROM demo WHERE state IN ('starting','ready') AND expires_at > ?", this.hub.now())!.n;
    if (running >= this.o.max) throw new HubError('DEMO_FULL', 'All browser demos are in use right now. Try again in a while, or start the free Windows trial.', 503);

    const host = this.o.host!, seed = this.seed!;
    const account = one<{ name: string }>(this.hub.db, 'SELECT name FROM account WHERE id = ?', u.account_id)!;
    const slug = this.freeSlug();
    const st = this.hub.createStore(slug, `Demo: ${account.name}`.slice(0, 80));
    const now = this.hub.now();
    exec(this.hub.db, "INSERT INTO demo (store_id, slug, account_id, user_id, state, created_at, expires_at) VALUES (?,?,?,?,'starting',?,?)", st.storeId, slug, u.account_id, u.id, now, now + this.o.hours * 3_600_000);
    this.o.log?.info('browser demo starting', { slug, account: u.account_id });
    try {
      const token = await this.build(host, seed, st.storeId, slug, account.name);
      exec(this.hub.db, "UPDATE demo SET state = 'ready', device_token = ? WHERE store_id = ?", token, st.storeId);
      this.o.log?.info('browser demo ready', { slug });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      exec(this.hub.db, "UPDATE demo SET state = 'failed', error = ?, ended_at = ? WHERE store_id = ?", msg.slice(0, 500), this.hub.now(), st.storeId);
      this.o.log?.warn('browser demo failed', { slug, error: msg });
      await host.remove(slug).catch(() => undefined);
      throw new HubError('DEMO_FAILED', 'The demo could not be made. Please try again in a minute.', 502);
    }
    return this.view(one<DemoRow>(this.hub.db, 'SELECT * FROM demo WHERE store_id = ?', st.storeId)!);
  }

  /** Ends demos past their time: server stopped, data folder deleted. */
  async sweep(): Promise<number> {
    let n = 0;
    for (const r of many<DemoRow>(this.hub.db, "SELECT * FROM demo WHERE state IN ('starting','ready') AND expires_at <= ?", this.hub.now())) {
      if (this.ending.has(r.store_id)) continue;
      this.ending.add(r.store_id);
      try {
        await this.o.host?.remove(r.slug);
        exec(this.hub.db, "UPDATE demo SET state = 'ended', ended_at = ?, device_token = NULL WHERE store_id = ?", this.hub.now(), r.store_id);
        this.hub.pauseStore(r.slug, true, 'This demo has ended.');
        this.o.log?.info('browser demo ended', { slug: r.slug });
        n++;
      } catch (e) {
        this.o.log?.warn('browser demo could not be ended', { slug: r.slug, error: String(e) });
      } finally {
        this.ending.delete(r.store_id);
      }
    }
    return n;
  }

  adminList() {
    return many<DemoRow & { account_name: string; email: string | null }>(this.hub.db, `SELECT d.*, a.name AS account_name, u.email FROM demo d JOIN account a ON a.id = d.account_id
      LEFT JOIN account_user u ON u.id = d.user_id ORDER BY d.created_at DESC LIMIT 200`).map((r) => ({
      slug: r.slug, state: r.state, account: r.account_name, email: r.email, createdAt: r.created_at, expiresAt: r.expires_at, endedAt: r.ended_at, error: r.error,
    }));
  }

  // ---------------------------------------------------------------- helpers

  /** Setup, licence, sample data, one paired terminal: everything through the outlet server's own API. */
  private async build(host: DemoHost, seed: DemoSeed, storeId: string, slug: string, accountName: string): Promise<string> {
    host.enable(slug);
    if (!(await host.ready(storeId, 45_000))) throw new Error('the outlet server did not start');
    const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
      const r = await host.call(storeId, method, path, body, headers);
      if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${errOf(r)?.code ?? ''} ${errOf(r)?.message ?? ''}`.trim());
      return r.json as Record<string, unknown>;
    };
    const command = (type: string, payload: Record<string, unknown>, session?: string) =>
      call('POST', '/v1/commands', { commandId: ulidLike(), type, payload, createdAt: new Date(this.hub.now()).toISOString() }, session ? { 'x-user-session': session, 'x-manager-pin': seed.owner.pin } : {});

    await command(seed.setup.type, { ...seed.setup.payload, outletName: `${accountName} (demo)`.slice(0, 80) });
    const session = String((await call('POST', '/v1/sessions', { userId: seed.owner.id, pin: seed.owner.pin })).token);
    try {
      // licence first: without one no business day opens
      const hw = String((await call('GET', '/v1/licence')).hardwareId);
      const days = Math.ceil(this.o.hours / 24);
      const grant = this.hub.licences.issue({ storeId, accountId: one<{ account_id: string }>(this.hub.db, 'SELECT account_id FROM demo WHERE store_id = ?', storeId)!.account_id, hardwareId: hw, kind: 'demo', days, seats: { terminals: 3, captains: 3, kds: 2 }, licensee: `${accountName} (demo)`, putInSlot: false, by: 'demo' });
      await command('InstallLicence', { key: grant.key }, session);
      for (const c of seed.commands) await command(c.type, c.payload, session);
      // one browser terminal, paired with the owner's PIN; its token goes to the visitor only
      const req = await call('POST', '/v1/pairing-requests', { name: 'Browser demo', kind: 'terminal' });
      await command('PairDevice', { code: String(req.code) }, session);
      const got = await call('POST', `/v1/pairing-requests/${encodeURIComponent(String(req.requestId))}/collect`, { secret: req.secret });
      if (got.status !== 'paired' || typeof got.deviceToken !== 'string') throw new Error('the browser terminal was not paired');
      return got.deviceToken;
    } finally {
      await host.call(storeId, 'DELETE', '/v1/session', undefined, { 'x-user-session': session }).catch(() => undefined);
    }
  }

  private freeSlug(): string {
    for (let i = 0; i < 20; i++) {
      const slug = `demo-${Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join('')}`;
      if (!one(this.hub.db, 'SELECT 1 FROM store WHERE slug = ? UNION ALL SELECT 1 FROM brand WHERE slug = ?', slug, slug)) return slug;
    }
    return `demo-${randomUUID().slice(0, 8)}`;
  }

  private view(r: DemoRow): DemoView {
    const base = this.o.outletUrl(r.slug);
    const seed = this.seed;
    return {
      slug: r.slug, state: r.state, expiresAt: r.expires_at,
      url: base && r.device_token ? `${base}/pos/#device=${r.device_token}` : null,
      staff: seed ? [{ name: seed.owner.name, pin: seed.owner.pin }, ...seed.staff.map((s) => ({ name: s.name, pin: s.pin }))] : [],
    };
  }
}
