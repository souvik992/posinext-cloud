import { randomUUID } from 'node:crypto';
import { HubError } from './hub.ts';
import type { Hub } from './hub.ts';

/**
 * Guest relay (DinePOS add-ons, e.g. Table QR, P5-03). A guest's phone on mobile data opens
 *   <hub>/s/<store>/a/<addon>/...
 * and the hub passes each request down the store's own event stream (the POS connected out to the hub; the outlet
 * accepts no incoming connections). The POS answers with POST /v1/pos/relay/:id and the hub sends that back to the
 * phone. Nothing is stored here: no menus, no orders, no guest data. When the POS is not connected the guest is told so.
 */

export interface RelayRequest {
  type: 'guest.request';
  id: string;
  method: 'GET' | 'POST';
  /** Below the store: always /a/<addon>/... */
  path: string;
  query: string;
  /** JSON body of a POST, as text. */
  body: string | null;
  /** The guest's address (the POS rate-limits per guest). */
  ip: string;
}

export interface RelayAnswer {
  status: number;
  contentType: string;
  cacheControl: string | null;
  bodyBase64: string;
}

const PATH = /^\/a\/[a-z][a-z0-9]{1,19}\/(?:[A-Za-z0-9._-]+\/){0,3}[A-Za-z0-9._-]*$/;
const TYPES = /^(text\/html|text\/javascript|text\/css|application\/json|image\/(?:jpeg|png|webp))(;\s*charset=utf-8)?$/i;

export class GuestRelay {
  private readonly pending = new Map<string, { storeId: string; resolve: (a: RelayAnswer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly cache = new Map<string, { at: number; answer: RelayAnswer }>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly cacheMs: number;
  private readonly hub: Hub;

  constructor(hub: Hub, o: { timeoutMs?: number; maxPendingPerStore?: number; cacheMs?: number } = {}) {
    this.hub = hub;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.maxPending = o.maxPendingPerStore ?? 40;
    this.cacheMs = o.cacheMs ?? 60_000;
  }

  /** Sends a guest request to the store's POS and waits for its answer. */
  forward(slug: string, r: Omit<RelayRequest, 'type' | 'id'>): Promise<RelayAnswer> {
    if (!PATH.test(r.path) || r.path.includes('..')) throw new HubError('NOT_FOUND', 'Not found.', 404);
    const store = this.hub.store({ slug });
    // the page and its script/style files change only with an add-on update: kept a minute, so many guests opening
    // the menu at once do not each pull them down the restaurant's line
    const key = `${store.id} ${r.path}`;
    const isFile = r.method === 'GET' && !r.path.includes('/api/');
    if (isFile) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < this.cacheMs) return Promise.resolve(hit.answer);
    }
    if (!this.hub.connected(store.id)) throw new HubError('STORE_OFFLINE', 'The restaurant’s system is not connected right now. Please ask a member of staff, or try again in a minute.', 503);
    if ([...this.pending.values()].filter((p) => p.storeId === store.id).length >= this.maxPending) throw new HubError('BUSY', 'The restaurant is busy. Please try again in a moment.', 503);
    const id = randomUUID();
    return new Promise<RelayAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HubError('STORE_TIMEOUT', 'The restaurant did not answer in time. Please try again.', 504));
      }, this.timeoutMs);
      this.pending.set(id, {
        storeId: store.id,
        timer,
        reject,
        resolve: (a) => {
          if (isFile && a.status === 200) this.cache.set(key, { at: Date.now(), answer: a });
          if (this.cache.size > 500) this.cache.clear();
          resolve(a);
        },
      });
      const ev: RelayRequest = { type: 'guest.request', id, ...r };
      this.hub.bus.emit('relay', store.id, ev);
    });
  }

  /** The POS's answer to one request (only the store it was sent to may answer it). */
  answer(storeId: string, id: string, body: unknown): { ok: true } {
    const p = this.pending.get(id);
    if (!p || p.storeId !== storeId) throw new HubError('NOT_FOUND', 'That request is no longer waiting (it timed out or was answered).', 404);
    const b = (body ?? {}) as Partial<RelayAnswer>;
    const status = Number(b.status);
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new HubError('VALIDATION', 'status must be an HTTP status.');
    if (typeof b.contentType !== 'string' || !TYPES.test(b.contentType)) throw new HubError('VALIDATION', 'Unsupported content type.');
    if (typeof b.bodyBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.bodyBase64)) throw new HubError('VALIDATION', 'bodyBase64 must be base64.');
    const cacheControl = typeof b.cacheControl === 'string' && /^(no-store|no-cache|private(, max-age=\d{1,6})?|public, max-age=\d{1,6})$/.test(b.cacheControl) ? b.cacheControl : null;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve({ status, contentType: b.contentType, cacheControl, bodyBase64: b.bodyBase64 });
    return { ok: true };
  }

  close(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new HubError('STORE_OFFLINE', 'The hub is restarting.', 503));
    }
    this.pending.clear();
  }
}

/** Guest pages: own files only, calls only back to the same address (the hub). */
export const GUEST_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
