import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { join } from 'node:path';
import { HubError } from './hub.ts';
import type { DeviceRef } from './hub.ts';

/**
 * Online backups ("DinePOS Cloud backup server"): each paired POS uploads its verified, gzipped database backups and the menu
 * photos they use. Files live on disk, one folder per store, never in the hub database:
 *   <backupDir>/<storeId>/<name>.db.gz (+ .sha256)   and   <backupDir>/<storeId>/images/<sha256>.<ext>
 * Uploads are streamed to a temporary file, checked against the SHA-256 the POS sent, then renamed into place, so a
 * broken upload never replaces a good backup. The newest `keep` backups of each store are kept.
 */

export const BACKUP_NAME = /^[a-z]+-\d{8}T\d{9}Z\.db\.gz$/;
const IMAGE_NAME = /^([0-9a-f]{64})\.(jpg|png|webp)$/;
const SHA = /^[0-9a-f]{64}$/;

export interface BackupStoreOptions { dir: string; keep?: number; maxBytes?: number; now?: () => number }
export interface OnlineBackup { name: string; bytes: number; uploadedAt: number; sha256: string }

/** "hourly-20261018T091500123Z.db.gz" -> its time stamp, so lists sort by time whatever the kind. */
const stampOf = (name: string) => name.slice(name.indexOf('-') + 1);

export class BackupStore {
  dir: string; keep: number; maxBytes: number; now: () => number;
  constructor(o: BackupStoreOptions) {
    this.dir = o.dir; this.keep = o.keep ?? 30; this.maxBytes = o.maxBytes ?? 1024 * 1024 * 1024; this.now = o.now ?? Date.now;
  }

  private storeDir(dev: DeviceRef): string {
    const d = join(this.dir, dev.storeId);
    mkdirSync(join(d, 'images'), { recursive: true });
    return d;
  }

  list(dev: DeviceRef): OnlineBackup[] {
    const d = this.storeDir(dev);
    return readdirSync(d).filter((f) => BACKUP_NAME.test(f)).sort((a, b) => stampOf(b).localeCompare(stampOf(a))).map((name) => {
      const st = statSync(join(d, name));
      let sha256 = '';
      try { sha256 = readFileSync(join(d, `${name}.sha256`), 'utf8').trim(); } catch { /* older file */ }
      return { name, bytes: st.size, uploadedAt: Math.round(st.mtimeMs), sha256 };
    });
  }

  /** Streams an upload to disk; refuses it (and keeps nothing) when it is too large or does not match its SHA-256. */
  async put(dev: DeviceRef, name: string, body: Readable, sha256: string, declaredBytes?: number): Promise<OnlineBackup> {
    if (!BACKUP_NAME.test(name)) throw new HubError('VALIDATION', 'Unknown backup name.');
    if (declaredBytes !== undefined && declaredBytes > this.maxBytes) throw new HubError('TOO_LARGE', 'This backup is larger than the server accepts.', 413);
    if (!SHA.test(sha256)) throw new HubError('VALIDATION', 'Send the backup\'s SHA-256 in X-Content-SHA256.');
    const d = this.storeDir(dev);
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
          if (size > this.maxBytes) tooBig = true; // keep reading (and dropping) so the POS gets a clear answer
          if (tooBig) return;
          h.update(ch);
          if (!out.write(ch)) { body.pause(); out.once('drain', () => body.resume()); }
        });
        body.on('end', () => out.end(() => resolve()));
      });
      if (tooBig) throw new HubError('TOO_LARGE', 'This backup is larger than the server accepts.', 413);
      if (h.digest('hex') !== sha256) throw new HubError('VALIDATION', 'The backup was damaged on the way (its SHA-256 does not match). Try again.');
      writeFileSync(join(d, `${name}.sha256`), sha256);
      renameSync(tmp, join(d, name));
    } finally {
      try { unlinkSync(tmp); } catch { /* renamed or never written */ }
    }
    this.prune(d);
    return this.list(dev).find((b) => b.name === name)!;
  }

  /** The file and its size, for streaming a download. */
  open(dev: DeviceRef, name: string): { stream: Readable; bytes: number; sha256: string } {
    if (!BACKUP_NAME.test(name)) throw new HubError('VALIDATION', 'Unknown backup name.');
    const file = join(this.storeDir(dev), name);
    if (!existsSync(file)) throw new HubError('NOT_FOUND', 'No such backup on the server.', 404);
    let sha256 = '';
    try { sha256 = readFileSync(`${file}.sha256`, 'utf8').trim(); } catch { /* older file */ }
    return { stream: createReadStream(file), bytes: statSync(file).size, sha256 };
  }

  imageNames(dev: DeviceRef): string[] {
    return readdirSync(join(this.storeDir(dev), 'images')).filter((f) => IMAGE_NAME.test(f));
  }

  /** A menu photo. Its name is the SHA-256 of its bytes, so a damaged photo is refused. */
  putImage(dev: DeviceRef, name: string, bytes: Buffer) {
    const m = IMAGE_NAME.exec(name);
    if (!m) throw new HubError('VALIDATION', 'Unknown photo name.');
    if (createHash('sha256').update(bytes).digest('hex') !== m[1]) throw new HubError('VALIDATION', 'The photo does not match its name.');
    const dir = join(this.storeDir(dev), 'images');
    if (readdirSync(dir).length >= 5000) throw new HubError('TOO_MANY', 'Too many photos for one store.', 409);
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(dir, name));
    return { ok: true };
  }

  image(dev: DeviceRef, name: string): Buffer {
    if (!IMAGE_NAME.test(name)) throw new HubError('VALIDATION', 'Unknown photo name.');
    try { return readFileSync(join(this.storeDir(dev), 'images', name)); } catch { throw new HubError('NOT_FOUND', 'Photo not found.', 404); }
  }

  private prune(d: string) {
    const names = readdirSync(d).filter((f) => BACKUP_NAME.test(f)).sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
    for (const n of names.slice(this.keep)) for (const f of [n, `${n}.sha256`]) { try { unlinkSync(join(d, f)); } catch { /* gone */ } }
  }
}
