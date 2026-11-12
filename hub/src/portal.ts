import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

/**
 * P8-09 (ADR-0007): the customer portal (souvik992/saas-portal cloud/saas-web, built by its CI, fetched by
 * deploy/portal.sh into HUB_PORTAL_DIR) served on the portal's own address (HUB_PORTAL_DOMAIN, e.g.
 * portal.posinext.com). Its API calls (/v1/...) go to this hub on the same address, so the HttpOnly session cookie
 * needs no cross-site rules. Any other path that is not a file is the portal's index.html (it routes in the browser).
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export interface PortalOptions {
  /** The built portal (index.html, assets/, fonts/). */
  dir: string;
  /** The portal's host names (HUB_PORTAL_DOMAIN). Empty: any host whose first label is "portal". */
  hosts?: string[];
}

/**
 * The portal's pages: only its own scripts, styles, fonts and API (no inline scripts, nothing from other sites), never
 * inside another site's frame, no camera / microphone / location.
 */
const PAGE_SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export class Portal {
  private dir: string;
  private hosts: Set<string>;
  constructor(o: PortalOptions) {
    this.dir = normalize(o.dir);
    this.hosts = new Set((o.hosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  }

  get ready(): boolean { return existsSync(join(this.dir, 'index.html')); }

  /** Is this request for the portal's address? */
  isPortalHost(req: IncomingMessage): boolean {
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    return this.hosts.size ? this.hosts.has(host) : host.startsWith('portal.');
  }

  /** Serves a portal page or file. False when this request is not the portal's (the API, health, other methods). */
  serve(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const raw = new URL(req.url ?? '/', 'http://portal').pathname;
    let path = raw;
    try { path = decodeURIComponent(raw); } catch { /* a malformed %-escape: not a file; the page is served */ }
    if (path.startsWith('/v1/') || path === '/health' || path.startsWith('/health/')) return false;
    if (!this.ready) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('The customer portal is being installed. Please try again in a few minutes.');
      return true;
    }
    const file = this.file(path);
    const isIndex = file === null;
    const target = file ?? join(this.dir, 'index.html');
    const body = readFileSync(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // hashed build files never change; pages are checked every time
      'Cache-Control': !isIndex && path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...(isIndex || target.endsWith('.html') ? PAGE_SECURITY : {}),
      // over https: browsers use https only for this host for a year (no downgrade to http)
      ...(String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  /** The file for this path inside the portal folder, or null (then index.html). Never outside the folder. */
  private file(path: string): string | null {
    if (path === '/' || path.includes('\0')) return null;
    const full = normalize(join(this.dir, path));
    if (!full.startsWith(this.dir + sep)) return null;
    try { return statSync(full).isFile() ? full : null; } catch { return null; }
  }
}
