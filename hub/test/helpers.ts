import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';
import { createHubServer } from '../src/http.ts';
import type { HttpOptions } from '../src/http.ts';
import type { Demos } from '../src/demos.ts';
import { UrbanPiper } from '../src/urbanpiper.ts';
import type { Fetcher } from '../src/urbanpiper.ts';
import type { Mail } from '../src/mailer.ts';
import { generateKeyPairSync } from 'node:crypto';

/** P7-02: the test cloud's licence signing key pair (the hub signs with the private half). */
export const TEST_CLOUD_KEY = generateKeyPairSync('ed25519');
import type { PublishedMenu } from '../../contract/src/menu.ts';
import { DEFAULT_SERVICEABILITY } from '../../contract/src/serviceability.ts';
import type { Hours } from '../../contract/src/serviceability.ts';

export const STORE_AT = { lat: 13.0213, lng: 77.646 };
export const NEAR = { lat: 13.03, lng: 77.646 }; // ~1 km
export const FAR = { lat: 13.2, lng: 77.646 }; // ~20 km
const allDay: Hours = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [{ open: '00:00', close: '23:59' }]])) as Hours;

export function menu(o: Partial<PublishedMenu> = {}): PublishedMenu {
  return {
    version: 1, storeName: 'Demo Burger Hub',
    categories: [{ id: 'c1', name: 'Burgers', sort: 1 }],
    items: [
      { id: 'burger', categoryId: 'c1', name: 'Cheese Burger', price: 12900, unit: 'pcs', isVeg: true, rateBp: 500, cessBp: 0, priceIncludesTax: true, modifierGroupIds: [], available: true },
      { id: 'cola', categoryId: 'c1', name: 'Cola', price: 4000, unit: 'pcs', isVeg: true, rateBp: 1200, cessBp: 0, priceIncludesTax: true, modifierGroupIds: [], available: true },
    ],
    modifierGroups: [], roundToRupee: true, feeTax: { rateBp: 500, cessBp: 0, priceIncludesTax: true },
    options: { acceptMode: 'manual', acceptTimeoutMin: 5, channels: { app: true, website: true, swiggy: false, zomato: false }, fulfilment: { pickup: true, delivery: true }, payments: { online: true, cod: true } },
    serviceability: { ...DEFAULT_SERVICEABILITY, location: { ...STORE_AT, label: 'Kalyan Nagar' }, hours: allDay, roadFactor: 1 },
    ...o,
  };
}

export interface TestHub {
  hub: Hub; base: string; clock: { t: number }; dir: string; up: UrbanPiper;
  /** P7-01: every email the hub sent (customer accounts) */
  mail: Mail[];
  /** P7-04: the browser demos (when started with a demo option) */
  demos: Demos | null;
  call(method: string, path: string, o?: { body?: unknown; key?: string; admin?: boolean; idem?: string; token?: string; headers?: Record<string, string> }): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
  restart(): Promise<TestHub>;
}

/** upFetch: a stand-in UrbanPiper for the hub's calls to it (its outbox is then sent only when a test calls up.pump()). */
export async function startHub(dir = mkdtempSync(join(tmpdir(), 'hub-test-')), clock = { t: Date.parse('2026-10-16T12:00:00+05:30') }, upFetch?: Fetcher, extra: Partial<HttpOptions> = {}): Promise<TestHub> {
  const mail: Mail[] = [];
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), now: () => clock.t, devOtp: true, onlinePayments: false, mailer: { kind: 'test', send: async (m) => { mail.push(m); } }, licenceSigningKey: TEST_CLOUD_KEY.privateKey });
  const up = new UrbanPiper(hub, { fetch: upFetch ?? (async () => { throw new Error('no UrbanPiper in this test'); }), kick: false, allowLocalWebhooks: true });
  const server = createHubServer(hub, { adminKey: 'admin-test-key', heartbeatMs: 100, urbanpiper: up, ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call: TestHub['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = {};
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.key) headers.authorization = `Bearer ${o.key}`;
    if (o.admin) headers['x-admin-key'] = 'admin-test-key';
    if (o.idem) headers['idempotency-key'] = o.idem;
    if (o.token) headers['x-order-token'] = o.token;
    Object.assign(headers, o.headers);
    const r = await fetch(base + path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  const close = () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); hub.close(); });
  const t: TestHub = { hub, base, clock, dir, up, mail, demos: server.demos, call, close, restart: async () => { await close(); return startHub(dir, clock, upFetch, extra); } };
  return t;
}

/** A POS event stream reader (what the ODS connector does), collecting events. */
export function posStream(base: string, key: string, lastEventId?: number) {
  const events: Array<{ seq: number; type: string; [k: string]: unknown }> = [];
  const ctl = new AbortController();
  const done = (async () => {
    const r = await fetch(`${base}/v1/pos/events`, { headers: { authorization: `Bearer ${key}`, ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}) }, signal: ctl.signal });
    if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk as Uint8Array, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (data) events.push(JSON.parse(data));
      }
    }
  })().catch(() => { /* closed */ });
  const waitFor = async (pred: (e: typeof events) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred(events)) { if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(events.map((e) => e.type))}`); await new Promise((r) => setTimeout(r, 20)); }
  };
  return { events, waitFor, close: async () => { ctl.abort(); await done; } };
}

export const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });
