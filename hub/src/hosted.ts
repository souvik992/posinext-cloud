import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { exec, many, one } from './db.ts';
import { HubError } from './hub.ts';
import type { Hub } from './hub.ts';

/**
 * Hosted outlets (P6-04, DinePOS ADR-0005): the outlet has no main PC. Its DinePOS server runs here, one process and one
 * database per outlet (data/outlets/<store id>), listening on 127.0.0.1 only; https://<store>.<cloud>/ is proxied to it
 * (HTTP and the live stream). Printing goes through a DinePOS Print Agent at the outlet (P6-03).
 *
 * The outlet server trusts nobody on loopback (DINEPOS_TRUST_LOOPBACK=0): every device pairs, every person signs in.
 * Only this process holds the outlet's host key (DINEPOS_HOST_KEY), used for the owner's first steps from the admin page
 * (set up the outlet, approve the first terminal); the proxy strips that header from every outside request.
 */

export const HOST_KEY_HEADER = 'x-dinepos-host-key';
const STRIP = new Set([HOST_KEY_HEADER, 'x-dinepos-relay']);

interface Row {
  store_id: string;
  port: number;
  host_key: string;
  enabled: number;
  created_at: number;
}

interface Running {
  child: ChildProcess | null;
  restarts: number;
  lastExit: string | null;
  startedAt: number | null;
  timer: NodeJS.Timeout | null;
}

export interface HostedOptions {
  /** The DinePOS server bundle (server.mjs); see outlet-server (built by npm run bundle:cloud in the fine-dine repository). */
  serverEntry: string;
  /** Folder for the outlets' data (each outlet gets <dataRoot>/<store id>). */
  dataRoot: string;
  node?: string;
  basePort?: number;
  timeZone?: string;
  log?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
  /** Extra environment for every outlet server (tests: a licence key, etc.). */
  env?: Record<string, string>;
}

export class HostedOutlets {
  private readonly hub: Hub;
  private readonly o: HostedOptions & { node: string; basePort: number };
  private readonly running = new Map<string, Running>();
  private stopping = false;

  constructor(hub: Hub, o: HostedOptions) {
    this.hub = hub;
    this.o = { node: process.execPath, basePort: 5100, ...o };
    exec(hub.db, `CREATE TABLE IF NOT EXISTS hosted_outlet (store_id TEXT PRIMARY KEY REFERENCES store(id), port INTEGER NOT NULL UNIQUE, host_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`);
  }

  get available(): boolean {
    return existsSync(this.o.serverEntry);
  }

  private row(storeId: string): Row | undefined {
    return one<Row>(this.hub.db, 'SELECT * FROM hosted_outlet WHERE store_id = ?', storeId);
  }

  /** Is this store run here (and switched on)? */
  isHosted(storeId: string): boolean {
    return this.row(storeId)?.enabled === 1;
  }

  /** Starts every hosted outlet (the cloud starting). */
  start(): void {
    for (const r of many<Row>(this.hub.db, 'SELECT * FROM hosted_outlet WHERE enabled = 1')) this.spawn(r);
  }

  /** Makes this store a hosted outlet (or switches it back on) and starts its server. */
  enable(slug: string): { port: number } {
    if (!this.available) throw new HubError('NOT_AVAILABLE', 'This cloud has no DinePOS outlet server installed (outlet-server).', 503);
    const store = this.hub.store({ slug });
    let r = this.row(store.id);
    if (!r) {
      const used = new Set(many<{ port: number }>(this.hub.db, 'SELECT port FROM hosted_outlet').map((x) => x.port));
      let port = this.o.basePort;
      while (used.has(port)) port++;
      exec(this.hub.db, 'INSERT INTO hosted_outlet (store_id, port, host_key, enabled, created_at) VALUES (?,?,?,1,?)', store.id, port, randomBytes(32).toString('base64url'), Date.now());
      r = this.row(store.id)!;
    } else if (!r.enabled) {
      exec(this.hub.db, 'UPDATE hosted_outlet SET enabled = 1 WHERE store_id = ?', store.id);
      r = this.row(store.id)!;
    }
    this.spawn(r);
    return { port: r.port };
  }

  /** Stops the outlet's server; its data is kept (switch on again to continue). */
  async disable(slug: string): Promise<void> {
    const store = this.hub.store({ slug });
    exec(this.hub.db, 'UPDATE hosted_outlet SET enabled = 0 WHERE store_id = ?', store.id);
    await this.kill(store.id);
  }

  /**
   * P7-04: ends a browser demo outlet for good: stops its server, deletes its data folder (database, backups, logs) and
   * frees its port. Only for demo outlets, which hold no real data.
   */
  async remove(slug: string): Promise<void> {
    const store = this.hub.store({ slug });
    exec(this.hub.db, 'UPDATE hosted_outlet SET enabled = 0 WHERE store_id = ?', store.id);
    await this.kill(store.id);
    this.running.delete(store.id);
    rmSync(join(this.o.dataRoot, store.id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    exec(this.hub.db, 'DELETE FROM hosted_outlet WHERE store_id = ?', store.id);
  }

  status(storeId: string): { hosted: boolean; running: boolean; port: number | null; restarts: number; lastExit: string | null; startedAt: number | null } {
    const r = this.row(storeId);
    const run = this.running.get(storeId);
    return { hosted: r?.enabled === 1, running: !!run?.child && run.child.exitCode === null, port: r?.port ?? null, restarts: run?.restarts ?? 0, lastExit: run?.lastExit ?? null, startedAt: run?.startedAt ?? null };
  }

  private spawn(r: Row): void {
    if (this.stopping) return;
    const run = this.running.get(r.store_id) ?? { child: null, restarts: 0, lastExit: null, startedAt: null, timer: null };
    this.running.set(r.store_id, run);
    if (run.child && run.child.exitCode === null) return;
    const dataDir = join(this.o.dataRoot, r.store_id);
    mkdirSync(dataDir, { recursive: true });
    const child = spawn(this.o.node, [this.o.serverEntry], {
      cwd: dataDir,
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        DATA_DIR: dataDir,
        DINEPOS_HOST: '127.0.0.1',
        DINEPOS_PORT: String(r.port),
        // nobody is the trusted master on loopback here: the cloud's own proxy connects from loopback
        DINEPOS_TRUST_LOOPBACK: '0',
        DINEPOS_HOST_KEY: r.host_key,
        // its licence is per outlet (Settings › Licence shows this outlet's own hardware id)
        DINEPOS_HOSTED_OUTLET: r.store_id,
        DINEPOS_LOG_TO_FILE: '1',
        LOG_LEVEL: 'warn',
        ...(this.o.timeZone ? { DINEPOS_TIMEZONE: this.o.timeZone } : {}),
        ...this.o.env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    run.child = child;
    run.startedAt = Date.now();
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on('exit', (code, signal) => {
      run.child = null;
      run.lastExit = `${signal ?? `exit ${code}`}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`;
      if (this.stopping || !this.isHosted(r.store_id)) return;
      run.restarts++;
      this.o.log?.warn('hosted outlet stopped; restarting', { storeId: r.store_id, lastExit: run.lastExit });
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(run.restarts, 5));
      run.timer = setTimeout(() => {
        run.timer = null;
        const again = this.row(r.store_id);
        if (again?.enabled) this.spawn(again);
      }, wait);
      run.timer.unref?.();
    });
    this.o.log?.info('hosted outlet started', { storeId: r.store_id, port: r.port });
  }

  private kill(storeId: string): Promise<void> {
    const run = this.running.get(storeId);
    if (run?.timer) clearTimeout(run.timer);
    const child = run?.child;
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.running.keys()].map((id) => this.kill(id)));
  }

  /** Waits until the outlet's server answers its health check (after a start). */
  async ready(storeId: string, timeoutMs = 30_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const a = await this.call(storeId, 'GET', '/v1/health');
        if (a.status === 200) return true;
      } catch {
        // starting
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  /** A request to the outlet's server as its host (the admin page's first steps); JSON in and out. */
  call(storeId: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
    const r = this.row(storeId);
    if (!r?.enabled) return Promise.reject(new HubError('NOT_HOSTED', 'This outlet is not hosted in this cloud.', 404));
    const text = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: r.port, method, path, headers: { [HOST_KEY_HEADER]: r.host_key, ...(text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}), ...headers }, timeout: 15_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const s = Buffer.concat(chunks).toString();
            let json: unknown = null;
            try {
              json = s ? JSON.parse(s) : null;
            } catch {
              json = s;
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('the outlet server did not answer')));
      req.on('error', reject);
      req.end(text ?? undefined);
    });
  }

  /** A device's request to a hosted outlet, passed to its server (without any host key it may have sent). */
  proxy(storeId: string, req: IncomingMessage, res: ServerResponse): void {
    const r = this.row(storeId);
    const run = this.running.get(storeId);
    if (!r?.enabled || !run?.child) return unavailable(res);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!STRIP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    const up = http.request({ host: '127.0.0.1', port: r.port, method: req.method, path: req.url, headers }, (ures) => {
      res.writeHead(ures.statusCode ?? 502, ures.headers);
      ures.pipe(res);
    });
    up.on('error', () => unavailable(res));
    req.pipe(up);
  }

  /** A device's live stream: the upgrade request (stripped) and then the raw connection, both ways. */
  proxyUpgrade(storeId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const r = this.row(storeId);
    if (!r?.enabled || !this.running.get(storeId)?.child) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const up = net.connect(r.port, '127.0.0.1', () => {
      let head1 = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (!STRIP.has(req.rawHeaders[i]!.toLowerCase())) head1 += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(`${head1}\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', end);
    socket.on('error', end);
    up.on('close', end);
    socket.on('close', end);
  }
}

function unavailable(res: ServerResponse): void {
  if (res.headersSent) return void res.end();
  const body = JSON.stringify({ ok: false, error: { code: 'OUTLET_STARTING', message: 'This outlet’s DinePOS server is starting or stopped. Try again in a moment.' } });
  res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
