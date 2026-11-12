import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Hub, HubError, RESERVED_SLUGS } from './hub.ts';
import { UrbanPiper } from './urbanpiper.ts';
import { Brands } from './brands.ts';
import { GuestRelay, GUEST_CSP } from './relay.ts';
import { REQUEST_HEADERS, Tunnels } from './tunnel.ts';
import type { HostedOutlets } from './hosted.ts';
import type { Monitor } from './monitor.ts';
import { randomUUID } from 'node:crypto';
import { acceptUpgrade, refuseUpgrade } from './ws.ts';
import { one } from './db.ts';
import { Demos } from './demos.ts';
import { Activations } from './activation.ts';
import type { ActivateInput } from './activation.ts';
import { productOf } from './products.ts';
import { Downloads } from './downloads.ts';
import { DemoRequests } from './demo-requests.ts';
import { Support } from './support.ts';
import type { Portal } from './portal.ts';
import type { DemoHost, DemoSeed } from './demos.ts';
import type { PublishedMenu } from '../../contract/src/menu.ts';

/**
 * The hub's HTTP API (contract/openapi.yaml). Three kinds of callers:
 *   admin    X-Admin-Key header          stores, pairing codes, devices, pause, hub settings (the /admin page)
 *   POS      Authorization: Bearer <device key>   publish menu/status, event stream (SSE), order actions
 *   customer open (CORS), rate limited   store page, quote, OTP, place/track/cancel orders, demo page
 *   UrbanPiper  x-dinepos-token header   Swiggy / Zomato orders and callbacks (src/urbanpiper.ts)
 */

export interface HttpOptions {
  adminKey?: string; heartbeatMs?: number; publicDir?: string;
  /** The hub's address as shops reach it (HUB_PUBLIC_URL), for connection links. Not set: taken from the admin's request. */
  publicUrl?: string;
  /** Swiggy / Zomato through UrbanPiper. Not given: one is made here (it listens to the hub; make only one per hub). */
  urbanpiper?: UrbanPiper;
  /** DinePOS add-on guest pages relayed to the store's POS (P5-03). Not given: one is made here. */
  relay?: GuestRelay;
  /**
   * P6-02: devices reach an outlet at https://<store>.<deviceDomain>/ (default: the host of publicUrl). Each outlet's
   * main PC keeps a tunnel open to /v1/pos/tunnel; requests and live streams for its address go through it.
   */
  deviceDomain?: string;
  tunnels?: Tunnels;
  /** P6-04: outlets whose DinePOS server runs here (no main PC at the outlet). */
  hosted?: HostedOutlets;
  /** Hosted outlets down, backups failing (GET /health/deep, the admin page). */
  monitor?: Monitor;
  /** P7-04: the browser demo: the sample outlet (demo-seed.json path or data), how many at once; host defaults to `hosted`. */
  demo?: { seed: string | DemoSeed | null; max?: number; hours?: number; host?: DemoHost };
  /** P8-04: the Windows downloads (uploaded installers, else the newest GitHub Release). Not given: one is made here. */
  downloads?: Downloads;
  /** P8-04: the GitHub API client for the downloads made here (tests). */
  githubFetch?: typeof fetch;
  /** P8-11: where the downloads made here keep uploaded installers (tests). */
  downloadsDir?: string;
  /** P8-09: the customer portal, served on its own address (src/portal.ts). */
  portal?: Portal;
  /** posinext.com "Book a Demo" requests are emailed here (HUB_DEMO_REQUEST_TO; never shown anywhere). Not set: only saved. */
  demoRequestTo?: string;
  /** New support tickets and customer replies are emailed here (HUB_SUPPORT_NOTIFY_TO, e.g. support@posinext.com). Not set: none. */
  supportNotifyTo?: string;
  /** Warnings from the demo requests (an email that could not be sent). */
  log?: { warn(m: string): void };
}

interface Ctx { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; query: URLSearchParams; body: unknown; ip: string }
type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; cors: boolean; maxBody: number; raw: boolean; handler: Handler }

const json = (res: ServerResponse, status: number, body: unknown, cors = false) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(cors ? CORS : {}) });
  res.end(text);
};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Order-Token, X-Site-Token', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Max-Age': '600' };

/** Requests per minute per IP and kind (simple fixed window). The limit is read on each request (admin settings). */
function limiter(perMinute: () => number) {
  const seen = new Map<string, { n: number; start: number }>();
  return (ip: string) => {
    const now = Date.now(), s = seen.get(ip);
    if (!s || now - s.start > 60_000) { seen.set(ip, { n: 1, start: now }); return; }
    if (++s.n > perMinute()) throw new HubError('TOO_MANY_REQUESTS', 'Too many requests. Wait a minute and try again.', 429);
  };
}

const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };

export function createHubServer(hub: Hub, o: HttpOptions = {}): http.Server & { demos: Demos | null } {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, opt: { cors?: boolean; maxBody?: number; raw?: boolean } = {}) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, cors: opt.cors ?? false, maxBody: opt.maxBody ?? 64 * 1024, raw: opt.raw ?? false, handler });
  };
  // wrong admin keys: 10 per minute per IP, then refused for the rest of the minute (guessing is slowed down)
  const adminFails = new Map<string, { n: number; start: number }>();
  const admin = (c: Ctx) => {
    const now = Date.now(), f = adminFails.get(c.ip);
    if (f && now - f.start <= 60_000 && f.n >= 10) throw new HubError('TOO_MANY_REQUESTS', 'Too many wrong admin keys. Wait a minute and try again.', 429);
    const got = Buffer.from(String(c.req.headers['x-admin-key'] ?? ''));
    const want = Buffer.from(o.adminKey ?? '');
    if (!o.adminKey || got.length !== want.length || !timingSafeEqual(got, want)) {
      if (!f || now - f.start > 60_000) adminFails.set(c.ip, { n: 1, start: now }); else f.n++;
      throw new HubError('FORBIDDEN', o.adminKey ? 'Admin key required.' : 'Admin over the internet is off: start the hub with HUB_ADMIN_KEY set.', 403);
    }
  };
  const device = (c: Ctx) => hub.device(/^Bearer (.+)$/.exec(String(c.req.headers.authorization ?? ''))?.[1]);
  const idem = (c: Ctx) => (typeof c.req.headers['idempotency-key'] === 'string' ? c.req.headers['idempotency-key'] : undefined);
  const orderToken = (c: Ctx) => (typeof c.req.headers['x-order-token'] === 'string' ? c.req.headers['x-order-token'] : c.query.get('token') ?? undefined);
  const otpLimit = limiter(() => hub.settings().otpPerMinute), orderLimit = limiter(() => hub.settings().ordersPerMinute), pairLimit = limiter(() => hub.settings().pairPerMinute);
  const heartbeat = o.heartbeatMs ?? 15_000;

  const up = o.urbanpiper ?? new UrbanPiper(hub);
  const relay = o.relay ?? new GuestRelay(hub);
  const tunnels = o.tunnels ?? new Tunnels();
  const deviceDomain = (o.deviceDomain ?? (o.publicUrl ? new URL(o.publicUrl).hostname : '')).toLowerCase();
  const deviceScheme = o.publicUrl ? new URL(o.publicUrl).protocol : 'https:';
  // a port in the public address (local testing: http://localhost:4900 → http://<store>.localhost:4900) is kept
  const devicePort = o.publicUrl && new URL(o.publicUrl).port ? `:${new URL(o.publicUrl).port}` : '';
  const deviceLimit = limiter(() => 1200);
  const outletUrl = (slug: string) => (deviceDomain ? `${deviceScheme}//${slug}.${deviceDomain}${devicePort}` : null);
  const demoHost = o.demo?.host ?? o.hosted;
  const demos = o.demo && demoHost ? new Demos(hub, { host: demoHost, seed: o.demo.seed, max: o.demo.max, hours: o.demo.hours, outletUrl }) : null;
  /** The store whose device address this request is for (Host = <store>.<deviceDomain>), or null. */
  const outletOf = (req: IncomingMessage): { id: string; slug: string } | null | 'unknown' => {
    if (!deviceDomain) return null;
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!host.endsWith(`.${deviceDomain}`)) return null;
    const label = host.slice(0, -(deviceDomain.length + 1));
    if (!label || label.includes('.') || RESERVED_SLUGS.has(label)) return null; // portal.<cloud> and the like are the cloud's own
    try {
      const st = hub.store({ slug: label });
      return { id: st.id, slug: st.slug };
    } catch {
      return 'unknown';
    }
  };
  const pickHeaders = (req: IncomingMessage) => {
    const h: Record<string, string> = {};
    for (const k of REQUEST_HEADERS) {
      const v = req.headers[k];
      if (typeof v === 'string') h[k] = v;
    }
    return h;
  };
  /** A device's request to its outlet, through the outlet's tunnel. */
  const forwardToOutlet = async (req: IncomingMessage, res: ServerResponse, outlet: { id: string }) => {
    try {
      deviceLimit(req.socket.remoteAddress ?? '?');
      let body: Buffer | null = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const ch of req) {
          size += (ch as Buffer).length;
          if (size > 16 * 1024 * 1024) throw new HubError('TOO_LARGE', 'Request too large.', 413);
          chunks.push(ch as Buffer);
        }
        body = Buffer.concat(chunks);
      }
      const a = await tunnels.request(outlet.id, { method: req.method ?? 'GET', path: req.url ?? '/', headers: pickHeaders(req), body });
      res.writeHead(a.status, { ...a.headers, 'Content-Length': a.body.length });
      res.end(req.method === 'HEAD' ? undefined : a.body);
    } catch (e) {
      if (res.headersSent) return void res.end();
      const err = e instanceof HubError ? e : new HubError('INTERNAL', 'Something went wrong. Please try again.', 500);
      json(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
    }
  };
  // a guest page load is the page, its script and style, the menu, photos, then a status check every few seconds
  const guestLimit = limiter(() => 240);
  add('GET', '/health', () => ({ ok: true }));
  /** For an uptime service: 503 while a hosted outlet is down or backups fail (store addresses only, no data). */
  add('GET', '/health/deep', (c) => {
    const r = o.monitor?.report() ?? { ok: true, problems: [], hosted: { total: 0, running: 0, down: [] }, backup: null, checkedAt: new Date().toISOString() };
    const body = JSON.stringify(r);
    c.res.writeHead(r.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    c.res.end(body);
    return Symbol.for('handled');
  });

  // ---- website builder (the ordering website's /admin page): one store's editor password, then a token (X-Site-Token)
  const siteLoginLimit = limiter(() => 10);
  const siteToken = (c: Ctx) => (typeof c.req.headers['x-site-token'] === 'string' ? c.req.headers['x-site-token'] : undefined);
  add('POST', '/v1/site/:slug/login', (c) => { siteLoginLimit(c.ip); return hub.siteLogin(c.params.slug!, (c.body as { password?: unknown } | null)?.password); }, { cors: true });
  add('POST', '/v1/site/:slug/logout', (c) => hub.siteLogout(c.params.slug!, siteToken(c)), { cors: true });
  add('GET', '/v1/site/:slug', (c) => hub.siteForEditor(c.params.slug!, siteToken(c)), { cors: true });
  add('PUT', '/v1/site/:slug/draft', (c) => hub.saveSiteDraft(c.params.slug!, siteToken(c), (c.body as { site?: unknown } | null)?.site), { cors: true, maxBody: 256 * 1024 });
  add('POST', '/v1/site/:slug/publish', (c) => hub.publishSite(c.params.slug!, siteToken(c)), { cors: true });
  add('POST', '/v1/site/:slug/discard', (c) => hub.discardSiteDraft(c.params.slug!, siteToken(c)), { cors: true });
  add('PUT', '/v1/site/:slug/images/:name', (c) => hub.putSiteImage(c.params.slug!, siteToken(c), c.params.name!, (c.body as { dataBase64?: unknown } | null)?.dataBase64), { cors: true, maxBody: 2_100_000 });

  // ---- customer accounts (P7-01, src/accounts.ts): the portal signs in with an HttpOnly cookie. Over https it is
  // `__Host-dp_account` (Secure, Path=/, no Domain: the browser keeps it to this exact host, and no other site or
  // subdomain can set or replace it). SameSite=Lax, and these routes send no CORS headers, so other sites cannot call
  // them with it; changes (POST) from another site's page are also refused by their Origin (sameOriginAccount below).
  // Sign-ins last until 400 days without a visit; each visit renews the cookie (GET /v1/account/me).
  const COOKIE = 'dp_account', SECURE_COOKIE = '__Host-dp_account';
  const accountToken = (c: Ctx) => {
    const jar = new Map<string, string>();
    for (const part of String(c.req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k) jar.set(k, v.join('='));
    }
    return jar.get(SECURE_COOKIE) || jar.get(COOKIE) || undefined;
  };
  const secure = (c: Ctx) => (o.publicUrl ?? '').startsWith('https:') || String(c.req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https';
  const cookie = (c: Ctx, value: string, age: number) => (secure(c)
    ? [`${SECURE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`, `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`]
    : [`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`]);
  const setSession = (c: Ctx, s: { token: string; expiresAt: number } | null) => {
    const age = s ? Math.max(0, Math.floor((s.expiresAt - hub.now()) / 1000)) : 0;
    c.res.setHeader('Set-Cookie', cookie(c, s ? s.token : '', age));
    return s ? { ok: true, expiresAt: s.expiresAt } : { ok: true };
  };
  const ua = (c: Ctx) => String(c.req.headers['user-agent'] ?? '');
  const signupLimit = limiter(() => 5), loginLimit = limiter(() => 10), codeLimit = limiter(() => 20);
  type B = Record<string, unknown> | null;
  add('POST', '/v1/account/signup', async (c) => {
    signupLimit(c.ip);
    const r = await hub.accounts.signup(c.body, ua(c));
    if (!r.verify) { setSession(c, r.session); return { email: r.email, verify: false }; } // HUB_SKIP_EMAIL_VERIFY: signed in now
    return r;
  });
  add('POST', '/v1/account/resend', (c) => { signupLimit(c.ip); return hub.accounts.resendVerify((c.body as B)?.email); });
  add('POST', '/v1/account/verify', (c) => { codeLimit(c.ip); const b = c.body as B; return setSession(c, hub.accounts.verifyEmail(b?.email, b?.code, ua(c))); });
  add('POST', '/v1/account/login', async (c) => { loginLimit(c.ip); const b = c.body as B; return setSession(c, await hub.accounts.login(b?.email, b?.password, ua(c))); });
  add('POST', '/v1/account/logout', (c) => { hub.accounts.logout(accountToken(c)); return setSession(c, null); });
  add('GET', '/v1/account/me', (c) => {
    const token = accountToken(c);
    const me = hub.accounts.me(token);
    // renew the cookie with the session's (rolling) end, so a portal used now and then never signs out by itself
    const end = hub.accounts.sessionExpiry(token);
    if (token && end) c.res.setHeader('Set-Cookie', cookie(c, token, Math.max(0, Math.floor((end - hub.now()) / 1000))));
    return me;
  });
  add('GET', '/v1/account/sessions', (c) => ({ sessions: hub.accounts.sessions(accountToken(c)) }));
  add('POST', '/v1/account/sessions/:id/revoke', (c) => hub.accounts.revokeSession(accountToken(c), c.params.id));
  add('POST', '/v1/account/sessions/revoke-others', (c) => hub.accounts.revokeOtherSessions(accountToken(c)));
  add('POST', '/v1/account/forgot', (c) => { signupLimit(c.ip); return hub.accounts.forgotPassword((c.body as B)?.email); });
  add('POST', '/v1/account/reset', async (c) => { codeLimit(c.ip); const b = c.body as B; return setSession(c, await hub.accounts.resetPassword(b?.email, b?.code, b?.password, ua(c))); });
  add('POST', '/v1/account/password', (c) => { loginLimit(c.ip); const b = c.body as B; return hub.accounts.changePassword(accountToken(c), b?.current, b?.password); });
  add('GET', '/v1/account/licences', (c) => {
    const user = hub.accounts.session(accountToken(c));
    return { licences: hub.licences.forAccount(user.account_id).map(({ id, product, kind, hardwareId, storeName, licensee, seats, issuedAt, expiresAt, revokedAt, key }) => ({ id, product, kind, hardwareId, outlet: storeName, licensee, seats, issuedAt, expiresAt, revoked: revokedAt !== null, key })) };
  });
  add('POST', '/v1/account/products', (c) => hub.accounts.setProducts(accountToken(c), (c.body as B)?.products));
  add('GET', '/v1/account/status', () => ({ signupOpen: hub.accounts.open }));
  // P7-03: the Windows app activating on a PC (its outlet server calls this with the account's email and password)
  const activations = new Activations(hub);

  // ---- P8-04: Windows downloads (src/downloads.ts). The list is public; a download needs a signed-in account (recorded).
  const downloads = o.downloads ?? new Downloads(hub.db, { log: console, now: () => hub.now(), ...(o.githubFetch ? { fetch: o.githubFetch } : {}), ...(o.downloadsDir ? { dir: o.downloadsDir } : {}) });
  add('GET', '/v1/downloads', async () => ({ downloads: await downloads.list() }));
  add('GET', '/v1/account/downloads/:id', async (c) => {
    const user = hub.accounts.session(accountToken(c));
    const d = await downloads.start(user.id, user.account_id, c.params.id!);
    if (d.kind === 'url') {
      c.res.writeHead(302, { Location: d.url, 'Cache-Control': 'no-store' });
      c.res.end();
      return Symbol.for('handled');
    }
    // P8-11: an installer uploaded to this server
    const stream = downloads.open(d);
    if (!stream) throw new HubError('NOT_AVAILABLE', 'This download is missing on the server. Please try again later or open a support ticket.', 503);
    c.res.writeHead(200, {
      'Content-Type': d.fileName.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/vnd.microsoft.portable-executable', 'Content-Length': d.size, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${d.fileName}"`, 'X-Content-Type-Options': 'nosniff', 'X-Content-SHA256': d.sha256,
    });
    stream.pipe(c.res);
    c.res.on('close', () => stream.destroy());
    return Symbol.for('handled');
  });
  add('GET', '/v1/admin/downloads', (c) => { admin(c); return { stats: downloads.stats(), files: downloads.files() }; });
  // P8-11: installers built on the vendor's PC (npm run release): streamed to disk, checked against X-Content-SHA256
  add('PUT', '/v1/admin/downloads/:item/:file', async (c) => {
    admin(c);
    const declared = c.req.headers['content-length'] ? Number(c.req.headers['content-length']) : undefined;
    return { file: await downloads.upload(c.params.item!, decodeURIComponent(c.params.file!), c.req, String(c.req.headers['x-content-sha256'] ?? '').toLowerCase(), declared) };
  }, { raw: true });
  add('DELETE', '/v1/admin/downloads/:item/:version', (c) => { admin(c); downloads.remove(c.params.item!, decodeURIComponent(c.params.version!)); return { ok: true }; });

  // ---- posinext.com "Book a Demo" form (src/demo-requests.ts): open to the website (CORS), rate limited
  const demoRequests = new DemoRequests(hub, o.demoRequestTo, o.log);
  const demoRequestLimit = limiter(() => 10);
  add('POST', '/v1/demo-requests', (c) => { demoRequestLimit(c.ip); return demoRequests.submit(c.body, c.ip); }, { cors: true, maxBody: 8 * 1024 });
  add('GET', '/v1/admin/demo-requests', (c) => { admin(c); return { requests: demoRequests.list() }; });

  // ---- P8-08: support tickets, announcements, knowledge base, service status (src/support.ts)
  const support = new Support(hub, o.supportNotifyTo, o.log);
  const ticketLimit = limiter(() => 10);
  add('GET', '/v1/account/tickets', (c) => ({ tickets: support.mine(accountToken(c)) }));
  add('POST', '/v1/account/tickets', (c) => { ticketLimit(c.ip); return support.open(accountToken(c), c.body); });
  add('GET', '/v1/account/tickets/:id', (c) => support.oneOfMine(accountToken(c), c.params.id!));
  add('POST', '/v1/account/tickets/:id/reply', (c) => { ticketLimit(c.ip); return support.reply(accountToken(c), c.params.id!, c.body); });
  add('POST', '/v1/account/tickets/:id/close', (c) => support.closeMine(accountToken(c), c.params.id!));
  add('GET', '/v1/admin/tickets', (c) => { admin(c); return { tickets: support.adminList() }; });
  add('GET', '/v1/admin/tickets/:id', (c) => { admin(c); return support.adminGet(c.params.id!); });
  add('POST', '/v1/admin/tickets/:id/reply', async (c) => { admin(c); return support.adminReply(c.params.id!, c.body); });
  add('POST', '/v1/admin/tickets/:id/close', (c) => { admin(c); return support.adminClose(c.params.id!); });
  add('GET', '/v1/announcements', (c) => ({ announcements: support.announcements(c.query.get('product') ?? undefined) }));
  add('POST', '/v1/admin/announcements', (c) => { admin(c); return support.announce(c.body); });
  add('POST', '/v1/admin/announcements/:id/delete', (c) => { admin(c); return support.unannounce(c.params.id!); });
  add('GET', '/v1/kb', () => ({ articles: support.articles() }));
  add('GET', '/v1/kb/:slug', (c) => support.article(c.params.slug!));
  add('POST', '/v1/admin/kb', (c) => { admin(c); return support.saveArticle(c.body); });
  add('POST', '/v1/admin/kb/:slug/delete', (c) => { admin(c); return support.deleteArticle(c.params.slug!); });
  // public status for the portal: is the cloud answering, can PCs activate, are downloads published
  add('GET', '/v1/status', async () => {
    let db = true;
    try { one(hub.db, 'SELECT 1 AS x'); } catch { db = false; }
    const list = await downloads.list().catch(() => []);
    const published = list.filter((d) => d.available).length;
    const components = [
      { name: 'Client area and sign-in', status: db ? 'ok' : 'down', note: db ? 'Working' : 'The database is not answering' },
      { name: 'Licence activation and renewals', status: db && hub.licences.ready ? 'ok' : 'down', note: hub.licences.ready ? 'PCs can start trials and get their keys' : 'Licence signing is not set up' },
      { name: 'Downloads', status: published > 0 ? 'ok' : 'degraded', note: published > 0 ? `${published} installer${published === 1 ? '' : 's'} published` : 'No installer published yet' },
      { name: 'Online orders relay', status: db ? 'ok' : 'down', note: db ? 'Orders reach the outlets' : 'Down' },
    ];
    return { ok: components.every((x) => x.status === 'ok'), checkedAt: hub.now(), components };
  });
  const activateLimit = limiter(() => 10);
  add('POST', '/v1/activate', async (c) => { activateLimit(c.ip); return activations.activate((c.body ?? {}) as ActivateInput); });
  // P7-04: the browser demo (src/demos.ts), for a signed-in person. P8-05 (ADR-0007): off unless the cloud is started
  // with it (HUB_BROWSER_DEMO=1); the trial is the Windows app.
  const demoLimit = limiter(() => 5);
  const NO_DEMO = 'There is no browser demo. Download the Windows app and start a 30-day free trial on your PC.';
  add('GET', '/v1/account/demo', (c) => {
    if (demos) return demos.current(accountToken(c));
    hub.accounts.session(accountToken(c));
    return { demo: null, available: false, reason: NO_DEMO };
  });
  add('POST', '/v1/account/demo', async (c) => {
    demoLimit(c.ip);
    if (!demos) { hub.accounts.session(accountToken(c)); throw new HubError('NOT_AVAILABLE', NO_DEMO, 503); }
    return demos.start(accountToken(c));
  });
  add('GET', '/v1/admin/demos', (c) => { admin(c); return { demos: demos?.adminList() ?? [], available: demos ? demos.unavailable() === null : false, reason: demos?.unavailable() ?? 'Not set up.' }; });
  add('GET', '/v1/admin/accounts', (c) => { admin(c); return { accounts: hub.accounts.adminList(), signupOpen: hub.accounts.open }; });
  // a second 30-day trial (testing, or agreed with a customer): revokes the trial keys, clears the trial claims
  add('POST', '/v1/admin/trials/reset', (c) => {
    admin(c);
    const r = activations.resetTrial((c.body ?? {}) as { email?: unknown; hardwareId?: unknown; product?: unknown });
    console.log(new Date().toISOString(), 'trial reset by admin', JSON.stringify({ ...(c.body as object), ...r }));
    return r;
  });

  // ---- admin
  // A connection link carries the hub address and a one-use pairing code: the shop pastes only this into its POS.
  const base = (c: Ctx) => (o.publicUrl ?? `${String(c.req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]!.trim()}://${String(c.req.headers['x-forwarded-host'] ?? c.req.headers.host ?? 'localhost')}`).replace(/\/+$/, '');
  const withLink = <T extends { pairingCode: string }>(c: Ctx, r: T) => ({ ...r, connectUrl: `${base(c)}/connect/${r.pairingCode}` });
  add('POST', '/v1/admin/stores', (c) => { admin(c); const b = c.body as { slug?: string; name?: string }; return withLink(c, hub.createStore(String(b?.slug ?? ''), String(b?.name ?? ''))); });
  add('POST', '/v1/admin/stores/:slug/pairing-code', (c) => { admin(c); return withLink(c, hub.pairingCodeWithExpiry(c.params.slug!)); });
  add('GET', '/v1/admin/stores/:slug', (c) => { admin(c); return hub.adminStore(c.params.slug!); });
  add('GET', '/v1/admin/orders', (c) => { admin(c); return hub.adminOrders({ slug: c.query.get('store') || undefined, status: c.query.get('status') ?? 'all', limit: Number(c.query.get('limit') ?? 100) }); });
  add('GET', '/v1/admin/overview', (c) => { admin(c); return hub.adminOverview(); });
  add('PUT', '/v1/admin/settings', (c) => { admin(c); return { settings: hub.saveSettings(c.body) }; });
  add('PUT', '/v1/admin/stores/:slug/pause', (c) => { admin(c); const b = (c.body ?? {}) as { paused?: unknown; reason?: unknown }; return hub.pauseStore(c.params.slug!, b.paused === true, b.reason); });
  add('GET', '/v1/admin/stores/:slug/sales', (c) => { admin(c); return hub.sync.sales(hub.store({ slug: c.params.slug! }).id, Number(c.query.get('days') ?? 14)); });
  add('GET', '/v1/admin/stores/:slug/licence', (c) => { admin(c); return hub.sync.licenceInfo(hub.store({ slug: c.params.slug! }).id); });
  add('PUT', '/v1/admin/stores/:slug/licence', (c) => { admin(c); return hub.sync.setLicence(hub.store({ slug: c.params.slug! }).id, (c.body as { key?: unknown } | null)?.key); });
  // P7-02: licence keys signed by this cloud (kept in licence_grant, put in the store's licence slot)
  add('GET', '/v1/admin/licence-signing', (c) => { admin(c); return { ready: hub.licences.ready, publicKey: hub.licences.publicKey() }; });
  add('GET', '/v1/admin/stores/:slug/grants', (c) => { admin(c); return { grants: hub.licences.forStore(hub.store({ slug: c.params.slug! }).id), ready: hub.licences.ready }; });
  add('POST', '/v1/admin/stores/:slug/grants', (c) => {
    admin(c);
    const st = hub.store({ slug: c.params.slug! });
    const b = (c.body ?? {}) as { hardwareId?: unknown; days?: unknown; terminals?: unknown; captains?: unknown; kds?: unknown; licensee?: unknown; product?: unknown };
    const product = productOf(b.product);
    if (!product) throw new HubError('VALIDATION', 'Choose the product: fine_dine (DinePOS) or tiffin_qsr (Tiffin POS).', 400, { fields: { product: 'Unknown product.' } });
    const owner = one<{ account_id: string }>(hub.db, 'SELECT account_id FROM account_store WHERE store_id = ?', st.id);
    return hub.licences.issue({
      storeId: st.id, accountId: owner?.account_id ?? null, hardwareId: String(b.hardwareId ?? ''), kind: 'manual', days: Number(b.days),
      seats: { terminals: Number(b.terminals ?? 1), captains: Number(b.captains ?? 0), kds: Number(b.kds ?? 0) }, licensee: String(b.licensee ?? st.name), by: 'admin', product,
    });
  });
  add('POST', '/v1/admin/grants/:id/revoke', (c) => { admin(c); return hub.licences.revoke(c.params.id!, (c.body as { reason?: unknown } | null)?.reason); });
  add('POST', '/v1/admin/stores/:slug/site-password', (c) => { admin(c); return hub.newSitePassword(c.params.slug!); });
  add('GET', '/v1/admin/stores/:slug/orders', (c) => { admin(c); return hub.adminOrders({ slug: c.params.slug!, limit: Number(c.query.get('limit') ?? 50) }); });
  add('POST', '/v1/admin/devices/:id/revoke', (c) => { admin(c); hub.revokeDevice(c.params.id!); return { ok: true }; });

  // ---- brands (P6-05): one website for several outlets; each order goes to the nearest outlet that can take it
  const brands = new Brands(hub);
  add('GET', '/v1/admin/brands', (c) => { admin(c); return { brands: brands.adminList() }; });
  add('POST', '/v1/admin/brands', (c) => { admin(c); const b = c.body as { slug?: string; name?: string } | null; return brands.create(String(b?.slug ?? ''), String(b?.name ?? '')); });
  add('GET', '/v1/admin/brands/:slug', (c) => { admin(c); return brands.adminView(c.params.slug!); });
  add('PUT', '/v1/admin/brands/:slug/stores/:store', (c) => { admin(c); return brands.addStore(c.params.slug!, c.params.store!); });
  add('DELETE', '/v1/admin/brands/:slug/stores/:store', (c) => { admin(c); return brands.removeStore(c.params.slug!, c.params.store!); });
  add('PUT', '/v1/admin/brands/:slug/main', (c) => { admin(c); return brands.setMain(c.params.slug!, String((c.body as { store?: unknown } | null)?.store ?? '')); });

  // ---- Swiggy / Zomato through UrbanPiper: the store's details (admin), and UrbanPiper's webhooks
  // the one UrbanPiper account (Hub settings)
  add('GET', '/v1/admin/urbanpiper', (c) => { admin(c); return up.accountView(base(c)); });
  add('PUT', '/v1/admin/urbanpiper', (c) => { admin(c); return up.saveAccount(c.body, base(c)); });
  add('DELETE', '/v1/admin/urbanpiper', (c) => { admin(c); return up.removeAccount(); });
  add('POST', '/v1/admin/urbanpiper/test', (c) => { admin(c); return up.test(); });
  add('POST', '/v1/admin/urbanpiper/webhooks', (c) => { admin(c); return up.setupWebhooks(base(c)); });
  // each store at UrbanPiper (store page)
  add('GET', '/v1/admin/stores/:slug/urbanpiper', (c) => { admin(c); return up.view(c.params.slug!); });
  add('PUT', '/v1/admin/stores/:slug/urbanpiper', (c) => { admin(c); return up.saveLink(c.params.slug!, c.body); });
  add('DELETE', '/v1/admin/stores/:slug/urbanpiper', (c) => { admin(c); return up.removeLink(c.params.slug!); });
  add('POST', '/v1/admin/stores/:slug/urbanpiper/store', (c) => { admin(c); return up.pushStore(c.params.slug!); });
  add('POST', '/v1/admin/stores/:slug/urbanpiper/menu', (c) => { admin(c); return up.pushMenu(c.params.slug!, base(c)); });
  add('POST', '/v1/urbanpiper/:bizId', (c) => up.webhook(c.params.bizId!, c.req.headers, c.body), { maxBody: 2 * 1024 * 1024 });

  // ---- POS
  add('POST', '/v1/pos/pair', (c) => { pairLimit(c.ip); const b = c.body as { code?: string; deviceName?: string }; return hub.pair(String(b?.code ?? ''), String(b?.deviceName ?? 'POS')); });
  add('PUT', '/v1/pos/menu', (c) => hub.publishMenu(device(c), c.body as PublishedMenu), { maxBody: 4 * 1024 * 1024 });
  add('PUT', '/v1/pos/status', (c) => hub.setStatus(device(c), c.body as { accepting: boolean; reason?: string }));
  add('GET', '/v1/pos/orders', (c) => hub.openOrders(device(c)));
  add('POST', '/v1/pos/sync/batches', (c) => hub.sync.receive(device(c), c.body), { maxBody: 4 * 1024 * 1024 }); // DinePOS sales sync
  add('GET', '/v1/pos/licence', (c) => hub.sync.licence(device(c)));
  add('GET', '/v1/pos/images', (c) => ({ names: hub.imageNames(device(c)) }));
  add('PUT', '/v1/pos/images/:name', (c) => hub.putImage(device(c), c.params.name!, (c.body as { dataBase64?: unknown } | null)?.dataBase64), { maxBody: 2_100_000 });
  add('POST', '/v1/pos/orders/:id/platform-action', (c) => up.platformAction(device(c), c.params.id!, c.body, idem(c))); // Swiggy / Zomato requests
  for (const action of ['received', 'accept', 'reject', 'state'] as const) {
    add('POST', `/v1/pos/orders/:id/${action}`, (c) => hub.posAction(device(c), c.params.id!, action, (c.body ?? {}) as Record<string, unknown>, idem(c)));
  }
  // online backups (src/backups.ts): binary bodies, streamed to and from disk
  const readRaw = async (c: Ctx, max: number) => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const ch of c.req) { size += (ch as Buffer).length; if (size > max) throw new HubError('TOO_LARGE', 'Request too large.', 413); chunks.push(ch as Buffer); }
    return Buffer.concat(chunks);
  };
  const sendFile = (c: Ctx, type: string, bytes: number, stream: NodeJS.ReadableStream, extra: Record<string, string> = {}) => {
    c.res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    stream.pipe(c.res);
    return Symbol.for('handled');
  };
  add('GET', '/v1/pos/backups', (c) => ({ backups: hub.backups.list(device(c)) }));
  add('PUT', '/v1/pos/backups/:name', (c) => hub.backups.put(device(c), c.params.name!, c.req, String(c.req.headers['x-content-sha256'] ?? '').toLowerCase(), c.req.headers['content-length'] ? Number(c.req.headers['content-length']) : undefined), { raw: true });
  add('GET', '/v1/pos/backups/:name', (c) => { const f = hub.backups.open(device(c), c.params.name!); return sendFile(c, 'application/gzip', f.bytes, f.stream, f.sha256 ? { 'X-Content-SHA256': f.sha256 } : {}); });
  add('GET', '/v1/pos/backup-images', (c) => ({ names: hub.backups.imageNames(device(c)) }));
  add('PUT', '/v1/pos/backup-images/:name', async (c) => { const dev = device(c); return hub.backups.putImage(dev, c.params.name!, await readRaw(c, 2_000_000)); }, { raw: true });
  add('GET', '/v1/pos/backup-images/:name', (c) => { const b = hub.backups.image(device(c), c.params.name!); c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length, 'Cache-Control': 'no-store' }); c.res.end(b); return Symbol.for('handled'); });
  add('GET', '/v1/pos/events', (c) => {
    const dev = device(c);
    const after = Number(c.req.headers['last-event-id'] ?? c.query.get('after') ?? 0) || 0;
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    c.res.write('retry: 3000\n\n');
    hub.streamOpened(dev.storeId);
    let last = after;
    const send = (ev: { seq: number; type: string }) => { if (ev.seq <= last) return; last = ev.seq; c.res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); };
    for (let batch = hub.eventsSince(dev.storeId, last); batch.length; batch = hub.eventsSince(dev.storeId, last)) for (const ev of batch) send(ev);
    const onEvent = (storeId: string, ev: { seq: number; type: string }) => { if (storeId === dev.storeId) send(ev); };
    hub.bus.on('pos', onEvent);
    const onRelay = (storeId: string, ev: unknown) => { if (storeId === dev.storeId) c.res.write(`event: guest.request\ndata: ${JSON.stringify(ev)}\n\n`); };
    hub.bus.on('relay', onRelay);
    const beat = setInterval(() => { try { c.res.write(': ping\n\n'); hub.streamOpened(dev.storeId); hub.streamClosed(dev.storeId); } catch { clearInterval(beat); } }, heartbeat);
    c.req.on('close', () => { clearInterval(beat); hub.bus.off('pos', onEvent); hub.bus.off('relay', onRelay); hub.streamClosed(dev.storeId); });
    return Symbol.for('handled');
  });

  // ---- P6-02: devices from anywhere
  /** Caddy asks before making an HTTPS certificate on demand: only the cloud's own name and its stores' addresses. */
  add('GET', '/v1/tls-ask', (c) => {
    const d = String(c.query.get('domain') ?? '').toLowerCase();
    if (deviceDomain && d === deviceDomain) return { ok: true };
    if (deviceDomain && d.endsWith(`.${deviceDomain}`)) {
      const label = d.slice(0, -(deviceDomain.length + 1));
      if (label && !label.includes('.')) {
        hub.store({ slug: label }); // NOT_FOUND for an unknown store
        return { ok: true };
      }
    }
    throw new HubError('NOT_FOUND', 'Not a DinePOS Cloud address.', 404);
  });
  // ---- P6-04: hosted outlets (their DinePOS server runs here)
  const hosted = o.hosted;
  const needHosted = () => {
    if (!hosted) throw new HubError('NOT_AVAILABLE', 'Hosted outlets are not set up on this cloud.', 503);
    return hosted;
  };
  const hostedView = async (slug: string) => {
    const st = hub.store({ slug });
    const s = hosted ? hosted.status(st.id) : { hosted: false, running: false, port: null, restarts: 0, lastExit: null, startedAt: null };
    let setup: { setupNeeded: boolean; outletName: string; users: Array<{ id: string; name: string; roleName: string }> } | null = null;
    if (hosted && s.running) setup = (await hosted.call(st.id, 'GET', '/v1/setup-state').catch(() => null))?.json as typeof setup;
    return { available: !!hosted?.available, ...s, deviceUrl: outletUrl(slug), setup };
  };
  add('GET', '/v1/admin/stores/:slug/hosted', (c) => { admin(c); return hostedView(c.params.slug!); });
  add('PUT', '/v1/admin/stores/:slug/hosted', async (c) => {
    admin(c);
    const on = (c.body as { enabled?: unknown } | null)?.enabled === true;
    const h = needHosted();
    if (on) {
      h.enable(c.params.slug!);
      await h.ready(hub.store({ slug: c.params.slug! }).id, 30_000);
    } else await h.disable(c.params.slug!);
    return hostedView(c.params.slug!);
  });
  /** The owner's first step: outlet name, owner and PIN (only while the outlet has no staff). */
  add('POST', '/v1/admin/stores/:slug/hosted/setup', async (c) => {
    admin(c);
    const b = (c.body ?? {}) as { outletName?: unknown; ownerName?: unknown; pin?: unknown };
    const id = hub.store({ slug: c.params.slug! }).id;
    const r = await needHosted().call(id, 'POST', '/v1/commands', { commandId: ulidLike(), type: 'SetupOutlet', payload: { outletName: String(b.outletName ?? ''), ownerId: ulidLike(), ownerName: String(b.ownerName ?? ''), pin: String(b.pin ?? '') }, createdAt: new Date().toISOString() });
    if (r.status !== 200) throw new HubError('SETUP_FAILED', (r.json as { error?: { message?: string } })?.error?.message ?? 'The outlet could not be set up.', r.status >= 400 && r.status < 500 ? r.status : 502);
    return hostedView(c.params.slug!);
  });
  /** Approves a terminal's (or phone's, or kitchen screen's) pairing code with a manager's PIN, as the outlet's host. */
  add('POST', '/v1/admin/stores/:slug/hosted/approve', async (c) => {
    admin(c);
    const b = (c.body ?? {}) as { code?: unknown; pin?: unknown; userId?: unknown };
    const id = hub.store({ slug: c.params.slug! }).id;
    const h = needHosted();
    const state = (await h.call(id, 'GET', '/v1/setup-state')).json as { users?: Array<{ id: string; roleName: string }> };
    const users = state.users ?? [];
    const userId = typeof b.userId === 'string' && b.userId ? b.userId : (users.find((u) => u.roleName === 'Owner') ?? users[0])?.id;
    if (!userId) throw new HubError('NO_STAFF', 'Set up the outlet first (owner and PIN).', 409);
    const signIn = await h.call(id, 'POST', '/v1/sessions', { userId, pin: String(b.pin ?? '') });
    if (signIn.status !== 200) throw new HubError('WRONG_PIN', (signIn.json as { error?: { message?: string } })?.error?.message ?? 'Wrong PIN.', 401);
    const token = (signIn.json as { token: string }).token;
    const r = await h.call(id, 'POST', '/v1/commands', { commandId: ulidLike(), type: 'PairDevice', payload: { code: String(b.code ?? '').replace(/\D/g, '') }, createdAt: new Date().toISOString() }, { 'x-user-session': token, 'x-manager-pin': String(b.pin ?? '') });
    await h.call(id, 'DELETE', '/v1/session', undefined, { 'x-user-session': token }).catch(() => undefined);
    if (r.status !== 200) throw new HubError('PAIR_FAILED', (r.json as { error?: { message?: string } })?.error?.message ?? 'The device could not be paired.', r.status >= 400 && r.status < 500 ? r.status : 502);
    return { ok: true };
  });

  /** The address devices use for this outlet, and whether its tunnel is up. */
  add('GET', '/v1/pos/tunnel-info', (c) => {
    const dev = device(c);
    return { deviceUrl: deviceDomain ? `${deviceScheme}//${dev.slug}.${deviceDomain}` : null, connected: tunnels.online(dev.storeId) };
  });

  // ---- DinePOS add-on guest pages, relayed to the store's POS (P5-03, src/relay.ts)
  add('POST', '/v1/pos/relay/:id', (c) => relay.answer(device(c).storeId, c.params.id!, c.body), { maxBody: 4 * 1024 * 1024 });
  add('GET', '/s/:slug/a/:addon', (c) => {
    c.res.writeHead(301, { Location: `/s/${encodeURIComponent(c.params.slug!)}/a/${encodeURIComponent(c.params.addon!)}/${c.query.toString() ? `?${c.query.toString()}` : ''}`, 'Cache-Control': 'no-store' });
    c.res.end();
    return Symbol.for('handled');
  });
  const guest = async (c: Ctx, rest: string[]) => {
    guestLimit(c.ip);
    const path = `/a/${c.params.addon!}/${rest.join('/')}`;
    let a;
    try {
      a = await relay.forward(c.params.slug!, { method: c.req.method === 'POST' ? 'POST' : 'GET', path, query: c.query.toString(), body: c.req.method === 'POST' ? JSON.stringify(c.body ?? {}) : null, ip: c.ip });
    } catch (e) {
      // the guest page shows the server's message; a browser opening the page itself gets a short page
      if (e instanceof HubError && !path.includes('/api/') && !/\.(js|css)$/.test(path)) {
        const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not available</title><body style="font-family:system-ui;padding:2rem;text-align:center"><p style="font-size:2rem">&#127869;</p><p>${e.message.replace(/[<>&]/g, '')}</p></body>`;
        c.res.writeHead(e.status, { ...PAGE_HEADERS, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Referrer-Policy': 'no-referrer' });
        c.res.end(page);
        return Symbol.for('handled');
      }
      throw e;
    }
    const bytes = Buffer.from(a.bodyBase64, 'base64');
    c.res.writeHead(a.status, {
      'Content-Type': a.contentType,
      'Content-Length': bytes.length,
      'Cache-Control': a.cacheControl ?? 'no-store',
      'Content-Security-Policy': GUEST_CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    c.res.end(bytes);
    return Symbol.for('handled');
  };
  for (const method of ['GET', 'POST']) {
    add(method, '/s/:slug/a/:addon/', (c) => guest(c, ['']));
    add(method, '/s/:slug/a/:addon/:pa', (c) => guest(c, [c.params.pa!]));
    add(method, '/s/:slug/a/:addon/:pa/:pb', (c) => guest(c, [c.params.pa!, c.params.pb!]));
    add(method, '/s/:slug/a/:addon/:pa/:pb/:pc', (c) => guest(c, [c.params.pa!, c.params.pb!, c.params.pc!]));
  }

  // ---- customer
  add('GET', '/v1/stores/:slug', (c) => hub.storePublic(c.params.slug!, c.query.get('channel') === 'app' ? 'app' : 'website'), { cors: true });
  add('GET', '/v1/stores/:slug/images/:name', (c) => {
    const img = hub.image(c.params.slug!, c.params.name!);
    c.res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ...CORS });
    c.res.end(Buffer.from(img.bytes));
    return Symbol.for('handled');
  }, { cors: true });
  add('POST', '/v1/stores/:slug/quote', (c) => hub.quote(c.params.slug!, c.body as Parameters<Hub['quote']>[1]), { cors: true });
  add('POST', '/v1/stores/:slug/orders', async (c) => { orderLimit(c.ip); return hub.placeOrder(c.params.slug!, c.body, idem(c)); }, { cors: true });
  add('GET', '/v1/brands/:slug', (c) => brands.publicView(c.params.slug!), { cors: true });
  add('POST', '/v1/brands/:slug/outlet', (c) => { guestLimit(c.ip); return brands.outletFor(c.params.slug!, c.body); }, { cors: true });
  add('POST', '/v1/brands/:slug/orders', async (c) => { orderLimit(c.ip); return brands.placeOrder(c.params.slug!, c.body, idem(c)); }, { cors: true });
  add('POST', '/v1/otp/send', (c) => { otpLimit(c.ip); return hub.otpSend(String((c.body as { mobile?: string })?.mobile ?? '')); }, { cors: true });
  add('POST', '/v1/otp/verify', (c) => { const b = c.body as { mobile?: string; otp?: string }; return hub.otpVerify(String(b?.mobile ?? ''), String(b?.otp ?? '')); }, { cors: true });
  add('GET', '/v1/orders/:id', (c) => hub.orderForCustomer(c.params.id!, orderToken(c)), { cors: true });
  add('POST', '/v1/orders/:id/cancel', (c) => hub.cancelByCustomer(c.params.id!, orderToken(c), (c.body as { reasonText?: string } | null)?.reasonText), { cors: true });
  add('GET', '/v1/orders/:id/events', (c) => {
    const order = hub.orderForCustomer(c.params.id!, orderToken(c));
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS });
    c.res.write(`event: order.state\ndata: ${JSON.stringify({ type: 'order.state', orderId: order.id, state: order.state, order })}\n\n`);
    const on = (id: string, ev: unknown) => { if (id === order.id) c.res.write(`event: order.state\ndata: ${JSON.stringify({ ...(ev as object), order: hub.orderForCustomer(order.id, orderToken(c)) })}\n\n`); };
    hub.bus.on('customer', on);
    const beat = setInterval(() => c.res.write(': ping\n\n'), heartbeat);
    c.req.on('close', () => { clearInterval(beat); hub.bus.off('customer', on); });
    return Symbol.for('handled');
  }, { cors: true });

  const pub = o.publicDir ?? join(import.meta.dirname, '..', 'public');

  // ---- admin page (no secrets inside: it asks for the admin key and sends it with each call)
  add('GET', '/admin', (c) => {
    c.res.writeHead(200, { ...PAGE_HEADERS, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'none'" });
    c.res.end(readFileSync(join(pub, 'admin.html')));
    return Symbol.for('handled');
  });

  // ---- the customer portal (P7-01): one page; it shows sign-up, sign-in, password reset or the account by its path
  const portalPage = (c: Ctx) => {
    c.res.writeHead(200, { ...PAGE_HEADERS, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; form-action 'self'" });
    c.res.end(readFileSync(join(pub, 'portal.html')));
    return Symbol.for('handled');
  };
  for (const p of ['/signup', '/login', '/forgot', '/app']) add('GET', p, portalPage);
  // the DinePOS fonts (Manrope, Fraunces; SIL OFL), as in the desktop app
  add('GET', '/fonts/:name', (c) => {
    const name = c.params.name!;
    if (!['manrope-latin.woff2', 'fraunces-latin.woff2'].includes(name)) throw new HubError('NOT_FOUND', 'Not found.', 404);
    const bytes = readFileSync(join(pub, 'fonts', name));
    c.res.writeHead(200, { 'Content-Type': 'font/woff2', 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    c.res.end(bytes);
    return Symbol.for('handled');
  });
  add('GET', '/', (c) => { c.res.writeHead(302, { Location: '/app', 'Cache-Control': 'no-store' }); c.res.end(); return Symbol.for('handled'); });

  // ---- a connection link opened in a browser: says where to paste it (the code is not used up here)
  add('GET', '/connect/:code', (c) => {
    const code = c.params.code!.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9);
    c.res.writeHead(200, { ...PAGE_HEADERS, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    c.res.end(readFileSync(join(pub, 'connect.html'), 'utf8').replace('__CODE__', code));
    return Symbol.for('handled');
  });

  // ---- demo ordering page (phase 2 replaces it with the store apps)
  add('GET', '/order/:slug', (c) => {
    const slug = decodeURIComponent(c.params.slug!);
    const html = readFileSync(join(pub, 'order.html'), 'utf8').replace('__STORE__', JSON.stringify(slug)).replace('__BRAND__', brands.isBrand(slug) ? 'true' : 'false');
    c.res.writeHead(200, { ...PAGE_HEADERS, 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" });
    c.res.end(html);
    return Symbol.for('handled');
  });

  const server = http.createServer(async (req, res) => {
    let route: Route | undefined;
    // P6-02: everything for https://<store>.<cloud>/ goes to that outlet's main PC
    const outlet = outletOf(req);
    if (outlet === 'unknown') return json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'No DinePOS outlet at this address.' } });
    if (outlet && hosted?.isHosted(outlet.id)) return void hosted.proxy(outlet.id, req, res);
    if (outlet) return void forwardToOutlet(req, res, outlet);
    // P8-09: the customer portal's pages on its own address; its /v1 calls fall through to the routes below
    if (o.portal?.isPortalHost(req)) {
      try { if (o.portal.serve(req, res)) return; } catch { return json(res, 500, { error: { code: 'ERROR', message: 'The portal page could not be read.' } }); }
    }
    try {
      const url = new URL(req.url ?? '/', 'http://hub');
      let params: Record<string, string> = {};
      let pathOk = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathOk = true;
        if (req.method === 'OPTIONS' && r.cors) { res.writeHead(204, CORS); res.end(); return; }
        if (r.method !== req.method) continue;
        route = r; params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        break;
      }
      if (!route) throw new HubError(pathOk ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', pathOk ? 'Method not allowed.' : 'Not found.', pathOk ? 405 : 404);
      if (req.method !== 'GET' && url.pathname.startsWith('/v1/account/') && !sameOriginAccount(req)) {
        throw new HubError('FORBIDDEN', 'This request came from another website and was refused.', 403);
      }
      let body: unknown = null;
      if (req.method !== 'GET' && !route.raw) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const ch of req) { size += (ch as Buffer).length; if (size > route.maxBody) throw new HubError('TOO_LARGE', 'Request too large.', 413); chunks.push(ch as Buffer); }
        const text = Buffer.concat(chunks).toString('utf8');
        if (text) { if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HubError('UNSUPPORTED_MEDIA_TYPE', 'Send JSON.', 415); try { body = JSON.parse(text); } catch { throw new HubError('BAD_JSON', 'The request is not valid JSON.', 400); } }
      }
      const out = await route.handler({ req, res, params, query: url.searchParams, body, ip: req.socket.remoteAddress ?? '?' });
      if (out === Symbol.for('handled')) return;
      json(res, req.method === 'POST' && /\/orders$/.test(url.pathname) ? 201 : 200, out ?? { ok: true }, route.cors);
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HubError) return json(res, e.status, { error: { code: e.code, message: e.message, details: e.details } }, route?.cors);
      console.error('hub error', e);
      json(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } }, route?.cors);
    }
  });
  // P6-02: the outlet's tunnel (its main PC connects out), and devices' live streams through it
  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    try {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const outlet = outletOf(req);
      if (outlet === 'unknown') return refuseUpgrade(socket, 404, 'Not Found');
      // P6-04: a hosted outlet's server checks the stream itself (origin, device token)
      if (outlet && hosted?.isHosted(outlet.id)) return hosted.proxyUpgrade(outlet.id, req, socket, head);
      if (outlet) {
        if (path !== '/v1/stream') return refuseUpgrade(socket, 404, 'Not Found');
        const origin = req.headers.origin;
        // a page of this outlet's own address, the DinePOS terminal app, or a native client (no Origin)
        if (origin && origin !== 'app://dinepos' && origin.toLowerCase() !== `${deviceScheme}//${String(req.headers.host ?? '').toLowerCase()}`) return refuseUpgrade(socket, 403, 'Forbidden');
        if (!tunnels.online(outlet.id)) return refuseUpgrade(socket, 503, 'Service Unavailable');
        const conn = acceptUpgrade(req, socket, head, 1024 * 1024);
        if (conn) tunnels.openStream(outlet.id, conn, pickHeaders(req));
        return;
      }
      if (path === '/v1/pos/tunnel') {
        const dev = hub.device(/^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1]);
        const conn = acceptUpgrade(req, socket, head, 32 * 1024 * 1024);
        if (conn) tunnels.attachOutlet(dev.storeId, conn);
        return;
      }
      refuseUpgrade(socket, 404, 'Not Found');
    } catch (e) {
      refuseUpgrade(socket, e instanceof HubError ? e.status : 500, e instanceof HubError ? 'Refused' : 'Error');
    }
  });
  server.on('close', () => {
    relay.close();
    tunnels.close();
  });
  // Node ends a request that takes longer than 5 minutes to arrive; an installer (150 MB) over a slow upload link can
  // take longer (P8-11). Headers must still arrive within headersTimeout (60 s), so a slow-headers client gains nothing.
  server.requestTimeout = 60 * 60_000;
  return Object.assign(server, { demos });
}

/**
 * A change to a customer account (POST /v1/account/...) must come from the portal's own pages. Browsers send Origin
 * with every POST; one from another host is refused (cross-site request forgery). Requests without Origin (scripts,
 * the Windows apps' activation) are not browser requests and carry no portal cookie, so they pass. In development the
 * portal's dev server (localhost) forwards to the hub on another port: loopback to loopback is allowed.
 */
function sameOriginAccount(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  const hosts = [req.headers.host, req.headers['x-forwarded-host']].flatMap((h) => String(h ?? '').split(',')).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hosts.includes(o.host.toLowerCase())) return true;
  const loop = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h);
  return loop(o.host) && hosts.some(loop) && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A fresh ULID-shaped id (time + random) for commands sent to a hosted outlet's server. */
function ulidLike(): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomUUID().replace(/-/g, '');
  let rest = '';
  for (let i = 0; i < 16; i++) rest += CROCKFORD[parseInt(rnd.slice(i * 2, i * 2 + 2), 16) % 32];
  return time + rest;
}

