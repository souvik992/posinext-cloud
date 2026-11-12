import { randomUUID } from 'node:crypto';
import { HubError } from './hub.ts';
import type { WsConn } from './ws.ts';

/**
 * Devices from anywhere (P6-02, DinePOS ADR-0005). Each outlet's main PC keeps one outgoing WebSocket to the cloud
 * (/v1/pos/tunnel). Requests from terminals, captain phones and kitchen screens to https://<outlet>.<cloud>/... travel
 * down it and the answers come back up; their live streams (/v1/stream) are carried in it too. The cloud stores
 * nothing of them. Messages (JSON text):
 *   cloud -> outlet  {t:'req', id, method, path, headers, body}          a device's HTTP request (body base64 or null)
 *   outlet -> cloud  {t:'res', id, status, headers, body}                its answer
 *   cloud -> outlet  {t:'ws.open', id, headers}                          a device opened /v1/stream
 *   both ways        {t:'ws.msg', id, data} / {t:'ws.close', id, code}   that stream's messages, and its end
 */

export interface DeviceRequest {
  method: string;
  /** Path and query, e.g. /v1/floor?x=1 */
  path: string;
  headers: Record<string, string>;
  body: Buffer | null;
}
export interface DeviceAnswer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Headers a device may send to its outlet (its own credentials and content), and the answer headers passed back. */
export const REQUEST_HEADERS = ['authorization', 'x-user-session', 'x-manager-pin', 'content-type', 'accept', 'origin', 'access-control-request-method', 'access-control-request-headers', 'if-none-match'];
export const ANSWER_HEADERS = ['content-type', 'cache-control', 'content-security-policy', 'x-request-id', 'location', 'etag', 'x-content-type-options', 'referrer-policy', 'service-worker-allowed', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers', 'access-control-max-age', 'access-control-allow-credentials', 'vary', 'content-disposition'];

interface Pending {
  storeId: string;
  resolve: (a: DeviceAnswer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class Tunnels {
  private readonly byStore = new Map<string, { conn: WsConn; beat: NodeJS.Timeout }>();
  private readonly pending = new Map<string, Pending>();
  private readonly streams = new Map<string, { storeId: string; conn: WsConn }>();
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly maxPending: number;

  constructor(o: { timeoutMs?: number; heartbeatMs?: number; maxPendingPerStore?: number } = {}) {
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.heartbeatMs = o.heartbeatMs ?? 25_000;
    this.maxPending = o.maxPendingPerStore ?? 200;
  }

  online(storeId: string): boolean {
    return this.byStore.has(storeId);
  }

  /** The outlet's main PC connected; a newer connection replaces an older one. */
  attachOutlet(storeId: string, conn: WsConn): void {
    const old = this.byStore.get(storeId);
    if (old) {
      clearInterval(old.beat);
      old.conn.close(4000, 'replaced by a newer connection');
    }
    const beat = setInterval(() => conn.ping(), this.heartbeatMs);
    beat.unref?.();
    this.byStore.set(storeId, { conn, beat });
    conn.on('message', (text: unknown) => {
      if (typeof text === 'string') this.fromOutlet(storeId, text);
    });
    conn.on('close', () => {
      clearInterval(beat);
      if (this.byStore.get(storeId)?.conn !== conn) return;
      this.byStore.delete(storeId);
      for (const [id, p] of this.pending) {
        if (p.storeId !== storeId) continue;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(offline());
      }
      for (const [id, s] of this.streams) {
        if (s.storeId !== storeId) continue;
        this.streams.delete(id);
        s.conn.close(1012, 'the outlet went offline; reconnecting');
      }
    });
  }

  /** A device's request, answered by the outlet. */
  request(storeId: string, r: DeviceRequest): Promise<DeviceAnswer> {
    const t = this.byStore.get(storeId);
    if (!t) return Promise.reject(offline());
    if ([...this.pending.values()].filter((p) => p.storeId === storeId).length >= this.maxPending) return Promise.reject(new HubError('BUSY', 'The outlet is busy. Try again in a moment.', 503));
    const id = randomUUID();
    return new Promise<DeviceAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HubError('OUTLET_TIMEOUT', 'The outlet did not answer in time.', 504));
      }, this.timeoutMs);
      this.pending.set(id, { storeId, resolve, reject, timer });
      t.conn.send(JSON.stringify({ t: 'req', id, method: r.method, path: r.path, headers: r.headers, body: r.body ? r.body.toString('base64') : null }));
    });
  }

  /** A device's live stream, carried to the outlet and back. */
  openStream(storeId: string, device: WsConn, headers: Record<string, string>): void {
    const t = this.byStore.get(storeId);
    if (!t) return device.close(1013, 'the outlet is offline');
    const id = randomUUID();
    this.streams.set(id, { storeId, conn: device });
    t.conn.send(JSON.stringify({ t: 'ws.open', id, headers }));
    device.on('message', (data: unknown) => {
      if (typeof data === 'string') this.byStore.get(storeId)?.conn.send(JSON.stringify({ t: 'ws.msg', id, data }));
    });
    device.on('close', (code: number) => {
      if (!this.streams.delete(id)) return;
      this.byStore.get(storeId)?.conn.send(JSON.stringify({ t: 'ws.close', id, code }));
    });
  }

  private fromOutlet(storeId: string, text: string): void {
    let m: { t?: string; id?: string; status?: number; headers?: Record<string, unknown>; body?: string; data?: string; code?: number };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    const id = String(m.id ?? '');
    if (m.t === 'res') {
      const p = this.pending.get(id);
      if (!p || p.storeId !== storeId) return;
      clearTimeout(p.timer);
      this.pending.delete(id);
      const status = Number(m.status);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.headers ?? {})) if (ANSWER_HEADERS.includes(k.toLowerCase()) && typeof v === 'string') headers[k.toLowerCase()] = v;
      p.resolve({ status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502, headers, body: Buffer.from(typeof m.body === 'string' ? m.body : '', 'base64') });
    } else if (m.t === 'ws.msg') {
      const s = this.streams.get(id);
      if (s && s.storeId === storeId && typeof m.data === 'string') s.conn.send(m.data);
    } else if (m.t === 'ws.close') {
      const s = this.streams.get(id);
      if (!s || s.storeId !== storeId) return;
      this.streams.delete(id);
      const code = Number(m.code);
      s.conn.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
    }
  }

  close(): void {
    for (const [, t] of this.byStore) {
      clearInterval(t.beat);
      t.conn.close(1001, 'the cloud is restarting');
    }
    this.byStore.clear();
  }
}

const offline = () => new HubError('OUTLET_OFFLINE', 'The outlet’s main PC is not connected to PosiNext Cloud right now. Billing on the outlet’s own network still works.', 503);
