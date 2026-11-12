import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { join } from 'node:path';
import { exec, many, one } from './db.ts';
import type { Db } from './db.ts';
import { HubError } from './hub.ts';
import { PRODUCTS, type ProductCode } from './products.ts';

/**
 * The downloads offered in the customer portal (P8-04, ADR-0007): each product's app and add-ons (Windows installers, and
 * the captain app's Android APK), always the newest build, and which signed-in account downloaded what.
 *
 * Installers are built on the vendor's PC and uploaded here (`npm run release` in fine-dine and in tiffin:
 * PUT /v1/admin/downloads/<item>/<file name>, admin key). The files live on disk in <downloadsDir>/<item>/, checked
 * against the SHA-256 sent with them; the newest `keep` versions of each item are kept, and the newest one is offered.
 * The hub serves them itself, so downloads do not depend on GitHub.
 *
 * Until an item has an upload, its newest GitHub Release asset is offered instead (fine-dine `dinepos-build-<n>`, tiffin
 * `tiffin-build-<n>`: the releases CI made before installers were built locally). That list is read from the GitHub
 * API, cached, and kept in the database so it survives restarts while GitHub cannot be reached.
 */

export interface DownloadItem {
  id: string;
  product: ProductCode;
  kind: 'app' | 'addon';
  name: string;
  description: string;
  repo: string;
  tagPrefix: string;
  /** The installer's file name; group 1 is the version. */
  asset: RegExp;
}

export const CATALOGUE: readonly DownloadItem[] = [
  { id: 'dinepos', product: 'fine_dine', kind: 'app', name: 'DinePOS for Windows', description: 'Billing, tables, KOTs and the kitchen. Install it on the outlet’s main PC first.', repo: 'souvik992/fine-dine', tagPrefix: 'dinepos-build-', asset: /^DinePOS-Setup-(.+)\.exe$/ },
  { id: 'dinepos-tableqr', product: 'fine_dine', kind: 'addon', name: 'Table QR', description: 'Guests order and call a waiter from a QR code on the table. Install after DinePOS.', repo: 'souvik992/fine-dine', tagPrefix: 'dinepos-build-', asset: /^DinePOS-TableQR-Setup-(.+)\.exe$/ },
  { id: 'dinepos-kitchen', product: 'fine_dine', kind: 'addon', name: 'Kitchen display (KDS)', description: 'DinePOS Kitchen: KOTs as tickets on a kitchen PC or screen, bumped when ready. Install on the kitchen PC; DinePOS runs on the main PC.', repo: 'souvik992/fine-dine', tagPrefix: 'dinepos-build-', asset: /^DinePOS-Kitchen-Setup-(.+)\.exe$/ },
  { id: 'dinepos-captain', product: 'fine_dine', kind: 'addon', name: 'Captain app (Android)', description: 'DinePOS Captain: waiters take orders and fire KOTs from their Android phones. Install the APK on each phone; it connects to DinePOS on the main PC over the Wi-Fi.', repo: 'souvik992/fine-dine', tagPrefix: 'dinepos-build-', asset: /^DinePOS-Captain-(.+)\.apk$/ },
  { id: 'tiffin', product: 'tiffin_qsr', kind: 'app', name: 'Tiffin POS for Windows', description: 'Quick billing, kitchen tickets and stock for counter service.', repo: 'souvik992/tiffin', tagPrefix: 'tiffin-build-', asset: /^TiffinPOS-Setup-(.+)\.exe$/ },
  { id: 'tiffin-ods', product: 'tiffin_qsr', kind: 'addon', name: 'ODS (online orders)', description: 'Online orders from your website, app, Swiggy and Zomato on an order display screen. Install after Tiffin POS.', repo: 'souvik992/tiffin', tagPrefix: 'tiffin-build-', asset: /^TiffinPOS-ODS-Setup-(.+)\.exe$/ },
  { id: 'posinext-grocery', product: 'grocery', kind: 'app', name: 'PosiNext Grocery for Windows', description: 'Supermarket and kirana billing: barcodes, weighing-scale labels, batches and expiry, khata, GST returns.', repo: 'souvik992/posinext-grocery', tagPrefix: 'grocery-build-', asset: /^PosiNextGrocery-Setup-(.+)\.exe$/ },
  { id: 'posinext-grocery-edc', product: 'grocery', kind: 'addon', name: 'Payment machines', description: 'Card and UPI payments on a Paytm or Pine Labs machine, the amount sent from the bill. Install after PosiNext Grocery.', repo: 'souvik992/posinext-grocery', tagPrefix: 'grocery-build-', asset: /^PosiNextGrocery-PaymentMachines-Setup-(.+)\.exe$/ },
  { id: 'posinext-apparel', product: 'apparel', kind: 'app', name: 'PosiNext Apparel for Windows', description: 'Clothing and footwear billing: sizes and colours, barcode labels, exchanges, GST returns.', repo: 'souvik992/posinext-apparel', tagPrefix: 'apparel-build-', asset: /^PosiNextApparel-Setup-(.+)\.exe$/ },
  { id: 'posinext-apparel-edc', product: 'apparel', kind: 'addon', name: 'Payment machines', description: 'Card and UPI payments on a Paytm or Pine Labs machine, the amount sent from the bill. Install after PosiNext Apparel.', repo: 'souvik992/posinext-apparel', tagPrefix: 'apparel-build-', asset: /^PosiNextApparel-PaymentMachines-Setup-(.+)\.exe$/ },
  { id: 'posinext-pharmacy', product: 'pharmacy', kind: 'app', name: 'PosiNext Pharmacy for Windows', description: 'Chemist billing: batches and expiry, scheduled-drug register, drug licence on bills, GST returns.', repo: 'souvik992/posinext-pharmacy', tagPrefix: 'pharmacy-build-', asset: /^PosiNextPharmacy-Setup-(.+)\.exe$/ },
  { id: 'posinext-pharmacy-edc', product: 'pharmacy', kind: 'addon', name: 'Payment machines', description: 'Card and UPI payments on a Paytm or Pine Labs machine, the amount sent from the bill. Install after PosiNext Pharmacy.', repo: 'souvik992/posinext-pharmacy', tagPrefix: 'pharmacy-build-', asset: /^PosiNextPharmacy-PaymentMachines-Setup-(.+)\.exe$/ },
];

/** One download as the portal shows it. `url` is GitHub's; the portal links to /v1/account/downloads/<id>. */
export interface DownloadView {
  id: string; product: ProductCode; productName: string; app: string; kind: 'app' | 'addon'; name: string; description: string;
  available: boolean; version: string | null; fileName: string | null; size: number | null; publishedAt: string | null; build: string | null;
}
interface Found { version: string; fileName: string; size: number; publishedAt: string; build: string; url: string }
/** An installer uploaded to this server. */
export interface UploadedFile { item: string; version: string; fileName: string; size: number; sha256: string; uploadedAt: number }
/** What a download hands out: a file on this server, or GitHub's address. */
export type DownloadTarget = { kind: 'file'; path: string; fileName: string; size: number; sha256: string } | { kind: 'url'; url: string; fileName: string };
const SHA = /^[0-9a-f]{64}$/;
interface GhRelease { tag_name: string; draft: boolean; prerelease: boolean; published_at: string | null; assets: Array<{ name: string; size: number; browser_download_url: string; state?: string }> }

export interface DownloadsOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** How long a fetched list is used before GitHub is asked again (default 10 minutes). */
  cacheMs?: number;
  /** GITHUB_TOKEN: optional, raises GitHub's limit of 60 requests an hour per IP. */
  githubToken?: string;
  log?: { warn(m: string, d?: unknown): void };
  /** Where uploaded installers are kept. Not given: uploads are refused (GitHub Releases only). */
  dir?: string;
  /** Versions of each item kept on disk (default 3: the newest is offered, the others are there to roll back to). */
  keep?: number;
  /** The largest installer accepted (default 1 GB). */
  maxBytes?: number;
}

const SETTING = 'downloads.catalogue';

export class Downloads {
  private db: Db;
  private o: DownloadsOptions;
  private found = new Map<string, Found>();
  private fetchedAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(db: Db, o: DownloadsOptions = {}) {
    this.db = db;
    this.o = o;
    exec(db, `CREATE TABLE IF NOT EXISTS download_log (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES account(id),
      user_id TEXT NOT NULL REFERENCES account_user(id), item TEXT NOT NULL, version TEXT NOT NULL, at INTEGER NOT NULL)`);
    exec(db, 'CREATE INDEX IF NOT EXISTS download_log_account ON download_log(account_id, at)');
    exec(db, `CREATE TABLE IF NOT EXISTS download_file (item TEXT NOT NULL, version TEXT NOT NULL, file_name TEXT NOT NULL, size INTEGER NOT NULL,
      sha256 TEXT NOT NULL, uploaded_at INTEGER NOT NULL, PRIMARY KEY (item, version))`);
    // the last list fetched, for when GitHub cannot be reached after a restart
    const saved = one<{ value_json: string }>(db, 'SELECT value_json FROM setting WHERE key = ?', SETTING);
    if (saved) {
      try { for (const [id, f] of Object.entries(JSON.parse(saved.value_json) as Record<string, Found>)) this.found.set(id, f); } catch { /* ignore a damaged copy */ }
    }
  }

  private now() { return (this.o.now ?? Date.now)(); }

  /** The catalogue (fetched from GitHub when the cached list is older than cacheMs; the cached list when GitHub fails). */
  async list(): Promise<DownloadView[]> {
    if (this.now() - this.fetchedAt > (this.o.cacheMs ?? 600_000)) await this.refresh();
    return CATALOGUE.map((item) => {
      const u = this.newestUpload(item.id);
      const f = u
        ? { version: u.version, fileName: u.fileName, size: u.size, publishedAt: new Date(u.uploadedAt).toISOString(), build: null }
        : this.found.get(item.id);
      return {
        id: item.id, product: item.product, productName: PRODUCTS[item.product].name, app: PRODUCTS[item.product].app, kind: item.kind, name: item.name,
        description: item.description, available: !!f, version: f?.version ?? null, fileName: f?.fileName ?? null, size: f?.size ?? null,
        publishedAt: f?.publishedAt ?? null, build: f?.build ?? null,
      };
    });
  }

  /** Asks GitHub for each repository's releases (once at a time). Failures keep the list there was. */
  refresh(): Promise<void> {
    this.refreshing ??= this.refreshOnce().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    const repos = [...new Set(CATALOGUE.map((i) => i.repo))];
    const results = await Promise.all(repos.map(async (repo) => [repo, await this.releases(repo)] as const));
    let changed = false;
    for (const [repo, releases] of results) {
      if (!releases) continue; // GitHub failed for this repository: keep what we had
      for (const item of CATALOGUE.filter((i) => i.repo === repo)) {
        const f = pick(item, releases);
        if (f) { this.found.set(item.id, f); changed = true; } else if (this.found.delete(item.id)) changed = true;
      }
    }
    this.fetchedAt = this.now();
    if (changed) {
      exec(this.db, 'INSERT INTO setting (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
        SETTING, JSON.stringify(Object.fromEntries(this.found)), this.now());
    }
  }

  private async releases(repo: string): Promise<GhRelease[] | null> {
    try {
      const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'dinepos-cloud', 'x-github-api-version': '2022-11-28' };
      if (this.o.githubToken) headers.authorization = `Bearer ${this.o.githubToken}`;
      const res = await (this.o.fetch ?? fetch)(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      return (await res.json()) as GhRelease[];
    } catch (e) {
      this.o.log?.warn('downloads: could not read GitHub releases', { repo, error: String(e) });
      return null;
    }
  }

  /** A signed-in account's download: recorded, then the file on this server (streamed) or GitHub's address (redirect). */
  async start(userId: string, accountId: string, itemId: string): Promise<DownloadTarget> {
    const item = CATALOGUE.find((i) => i.id === itemId);
    if (!item) throw new HubError('NOT_FOUND', 'No such download.', 404);
    const log = (version: string) => exec(this.db, 'INSERT INTO download_log (account_id, user_id, item, version, at) VALUES (?,?,?,?,?)', accountId, userId, item.id, version, this.now());
    const u = this.newestUpload(itemId);
    if (u && this.o.dir) {
      log(u.version);
      return { kind: 'file', path: join(this.o.dir, item.id, u.fileName), fileName: u.fileName, size: u.size, sha256: u.sha256 };
    }
    if (!this.found.has(itemId)) await this.list();
    const f = this.found.get(itemId);
    if (!f) throw new HubError('NOT_AVAILABLE', `${item.name} is not available to download yet. Please try again later.`, 503);
    log(f.version);
    return { kind: 'url', url: f.url, fileName: f.fileName };
  }

  /** Opens an uploaded file for streaming (null when it is missing from the disk or has the wrong size). */
  open(t: Extract<DownloadTarget, { kind: 'file' }>): Readable | null {
    try { if (statSync(t.path).size !== t.size) return null; } catch { return null; }
    return createReadStream(t.path);
  }

  // ---- uploads (the vendor's release script)

  /** The uploaded installers, newest first. */
  files(): UploadedFile[] {
    return many<{ item: string; version: string; file_name: string; size: number; sha256: string; uploaded_at: number }>(this.db,
      'SELECT * FROM download_file ORDER BY uploaded_at DESC, rowid DESC').map((r) => ({ item: r.item, version: r.version, fileName: r.file_name, size: r.size, sha256: r.sha256, uploadedAt: r.uploaded_at }));
  }

  private newestUpload(itemId: string): UploadedFile | null {
    return this.files().find((f) => f.item === itemId) ?? null;
  }

  /**
   * Streams an installer to disk. The file name must be the item's installer (its version is read from it), and the
   * bytes must match `sha256`; otherwise nothing is kept. The same version again replaces it; older versions beyond
   * `keep` are deleted.
   */
  async upload(itemId: string, fileName: string, body: Readable, sha256: string, declaredBytes?: number): Promise<UploadedFile> {
    const item = CATALOGUE.find((i) => i.id === itemId);
    if (!item) throw new HubError('NOT_FOUND', `No download called ${itemId}. Known: ${CATALOGUE.map((i) => i.id).join(', ')}.`, 404);
    if (!this.o.dir) throw new HubError('NOT_AVAILABLE', 'This server does not keep installers (no downloads folder).', 503);
    const m = item.asset.exec(fileName);
    if (!m || !/^[0-9A-Za-z.+-]{1,40}$/.test(m[1]!)) throw new HubError('VALIDATION', `That is not the ${item.name} installer (expected a name matching ${item.asset.source}).`);
    const version = m[1]!;
    if (!SHA.test(sha256)) throw new HubError('VALIDATION', "Send the file's SHA-256 in X-Content-SHA256.");
    const max = this.o.maxBytes ?? 1024 ** 3;
    if (declaredBytes !== undefined && declaredBytes > max) throw new HubError('TOO_LARGE', 'This file is larger than the server accepts.', 413);
    const d = join(this.o.dir, item.id);
    mkdirSync(d, { recursive: true });
    const tmp = join(d, `.upload-${randomUUID()}.tmp`);
    const h = createHash('sha256');
    let size = 0, tooBig = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(tmp);
        out.on('error', reject);
        body.on('error', reject);
        body.on('data', (ch: Buffer) => {
          size += ch.length;
          if (size > max) tooBig = true; // keep reading (and dropping) so the uploader gets a clear answer
          if (tooBig) return;
          h.update(ch);
          if (!out.write(ch)) { body.pause(); out.once('drain', () => body.resume()); }
        });
        body.on('end', () => out.end(() => resolve()));
      });
      if (tooBig) throw new HubError('TOO_LARGE', 'This file is larger than the server accepts.', 413);
      if (h.digest('hex') !== sha256) throw new HubError('VALIDATION', 'The file was damaged on the way (its SHA-256 does not match). Upload it again.');
      renameSync(tmp, join(d, fileName));
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or never written */ }
    }
    exec(this.db, `INSERT INTO download_file (item, version, file_name, size, sha256, uploaded_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(item, version) DO UPDATE SET file_name = excluded.file_name, size = excluded.size, sha256 = excluded.sha256, uploaded_at = excluded.uploaded_at`,
      item.id, version, fileName, size, sha256, this.now());
    for (const old of this.files().filter((f) => f.item === item.id).slice(this.o.keep ?? 3)) this.remove(old.item, old.version);
    return this.files().find((f) => f.item === item.id && f.version === version)!;
  }

  /** Deletes an uploaded version (the newest one left is offered again). */
  remove(itemId: string, version: string): void {
    const f = this.files().find((x) => x.item === itemId && x.version === version);
    if (!f) throw new HubError('NOT_FOUND', 'No such uploaded file.', 404);
    exec(this.db, 'DELETE FROM download_file WHERE item = ? AND version = ?', itemId, version);
    if (this.o.dir && !this.files().some((x) => x.item === itemId && x.fileName === f.fileName)) {
      try { unlinkSync(join(this.o.dir, itemId, f.fileName)); } catch { /* already gone */ }
    }
  }

  /** Downloads per item and version (the admin page). */
  stats(): Array<{ item: string; version: string; downloads: number; accounts: number; last: number }> {
    return many(this.db, `SELECT item, version, COUNT(*) AS downloads, COUNT(DISTINCT account_id) AS accounts, MAX(at) AS last
      FROM download_log GROUP BY item, version ORDER BY last DESC LIMIT 100`);
  }
}

/** The newest published release with this item's tag prefix that has its installer. */
function pick(item: DownloadItem, releases: GhRelease[]): Found | null {
  const ours = releases
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(item.tagPrefix) && r.published_at)
    .sort((a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!));
  for (const r of ours) {
    for (const a of r.assets) {
      const m = item.asset.exec(a.name);
      if (m && (a.state ?? 'uploaded') === 'uploaded') {
        return { version: m[1]!, fileName: a.name, size: a.size, publishedAt: r.published_at!, build: r.tag_name.slice(item.tagPrefix.length), url: a.browser_download_url };
      }
    }
  }
  return null;
}
