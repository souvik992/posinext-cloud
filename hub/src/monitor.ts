import { readFileSync } from 'node:fs';
import { many } from './db.ts';
import type { Hub } from './hub.ts';
import type { HostedOutlets } from './hosted.ts';

/**
 * DinePOS Cloud monitoring: what an operator must know without looking.
 *   - a hosted outlet's DinePOS server down for more than a minute (its devices cannot bill)
 *   - backups failing, or not run for over two hours (deploy/backup.sh writes backup-status.json every hour)
 * GET /health/deep reports them (503 while any is open), for an uptime service such as UptimeRobot; the admin page
 * shows them; with HUB_ALERT_WEBHOOK set, each new problem (and its end) is posted to Slack, Discord or Google Chat,
 * and repeated every 6 hours while it lasts.
 */

export interface BackupStatus {
  at: string;
  ok: boolean;
  outlets: number;
  target: string;
  offsite: boolean;
  error: string | null;
}

export interface HealthReport {
  ok: boolean;
  problems: string[];
  hosted: { total: number; running: number; down: string[] };
  backup: BackupStatus | null;
  checkedAt: string;
}

export interface MonitorOptions {
  hosted?: HostedOutlets;
  backupStatusFile?: string;
  webhook?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** A hosted outlet counts as down after this long (a restart takes a few seconds). */
  downAfterMs?: number;
  /** Backups run hourly: older than this is a problem. */
  backupMaxAgeMs?: number;
  repeatMs?: number;
  log?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
}

export class Monitor {
  private readonly hub: Hub;
  private readonly o: Required<Pick<MonitorOptions, 'fetch' | 'now' | 'downAfterMs' | 'backupMaxAgeMs' | 'repeatMs'>> & MonitorOptions;
  private readonly downSince = new Map<string, number>();
  private readonly alerted = new Map<string, number>();

  constructor(hub: Hub, o: MonitorOptions = {}) {
    this.hub = hub;
    this.o = { fetch: (i, init) => fetch(i, init), now: Date.now, downAfterMs: 60_000, backupMaxAgeMs: 2 * 3_600_000, repeatMs: 6 * 3_600_000, ...o };
  }

  private backup(): BackupStatus | null {
    if (!this.o.backupStatusFile) return null;
    try {
      return JSON.parse(readFileSync(this.o.backupStatusFile, 'utf8')) as BackupStatus;
    } catch {
      return null; // not run yet (a new server) or not set up on this machine
    }
  }

  report(): HealthReport {
    const now = this.o.now();
    const problems: string[] = [];
    const down: string[] = [];
    let total = 0;
    let running = 0;
    if (this.o.hosted) {
      let rows: Array<{ store_id: string; slug: string }> = [];
      try {
        rows = many<{ store_id: string; slug: string }>(this.hub.db, 'SELECT h.store_id, s.slug FROM hosted_outlet h JOIN store s ON s.id = h.store_id WHERE h.enabled = 1 ORDER BY s.slug');
      } catch {
        rows = [];
      }
      total = rows.length;
      for (const r of rows) {
        const st = this.o.hosted.status(r.store_id);
        if (st.running) {
          running++;
          this.downSince.delete(r.store_id);
          continue;
        }
        const since = this.downSince.get(r.store_id) ?? now;
        this.downSince.set(r.store_id, since);
        if (now - since >= this.o.downAfterMs) {
          down.push(r.slug);
          problems.push(`Hosted outlet ${r.slug} is down${st.lastExit ? ` (${st.lastExit.slice(0, 160)})` : ''}: its devices cannot bill.`);
        }
      }
    }
    const backup = this.backup();
    if (backup) {
      if (!backup.ok) problems.push(`Backups failed: ${backup.error ?? 'unknown error'}.`);
      else if (now - Date.parse(backup.at) > this.o.backupMaxAgeMs) problems.push(`Backups have not run since ${backup.at}.`);
    }
    return { ok: problems.length === 0, problems, hosted: { total, running, down }, backup, checkedAt: new Date(now).toISOString() };
  }

  /** Called every half minute: alerts each new problem, its end, and a reminder every few hours while it lasts. */
  async tick(): Promise<HealthReport> {
    const r = this.report();
    const now = this.o.now();
    const open = new Set(r.problems);
    for (const p of open) {
      const last = this.alerted.get(p);
      if (last === undefined || now - last >= this.o.repeatMs) {
        this.alerted.set(p, now);
        await this.send(`⚠️ DinePOS Cloud: ${p}`);
      }
    }
    for (const p of [...this.alerted.keys()]) {
      if (open.has(p)) continue;
      this.alerted.delete(p);
      await this.send(`✅ DinePOS Cloud: resolved: ${p}`);
    }
    return r;
  }

  private async send(text: string): Promise<void> {
    this.o.log?.warn(text);
    if (!this.o.webhook) return;
    try {
      // Slack and Google Chat read `text`, Discord reads `content`
      await this.o.fetch(this.o.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      this.o.log?.warn('alert could not be sent', String(e));
    }
  }
}
