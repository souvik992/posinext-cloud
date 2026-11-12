// One-time import of another hub's database into PosiNext Cloud: the Tiffin order hub (QSR stores, paired POS PCs,
// menus, orders, customers' OTPs, UrbanPiper links and orders, sales sync, website builder, brands). Both hubs come
// from the same code (PosiNext Cloud was copied from the Tiffin hub on 2026-11-06), so their tables match; rows are
// copied column by column and never overwrite what is already here. Run by scripts/import-hub.ts (deploy/merge-tiffin.sh).
import type { DatabaseSync } from 'node:sqlite';
import { RESERVED_SLUGS } from './hub.ts';

type Db = DatabaseSync;

/** Copy order: parents before children. Tables the source does not have are skipped. */
const TABLES = [
  'store', 'brand', 'brand_store', 'device', 'pairing_code', 'image', 'orders', 'event', 'idem', 'otp', 'otp_token',
  'order_attempt', 'setting', 'up_link', 'up_order', 'up_outbox', 'up_log', 'sync_stream', 'sync_event', 'site_session', 'store_licence',
] as const;

export interface ImportReport {
  tables: Record<string, { source: number; copied: number; alreadyHere: number }>;
  /** Stores (or brands) whose web address had to change because the address was taken here: old -> new slug. */
  renamed: Array<{ kind: 'store' | 'brand'; id: string; from: string; to: string }>;
  /** Hub settings that differ: this hub's value is kept. */
  settingsKept: string[];
  urbanpiper: 'none' | 'copied' | 'same-business' | 'only-here';
  /** Tiffin's UrbanPiper webhook token, still accepted until "Set up order links" is run here (same business). */
  legacyWebhookToken: string | null;
  storeIds: string[];
}

const tableExists = (db: Db, t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
const columns = (db: Db, t: string) => db.prepare(`SELECT name, type, pk FROM pragma_table_info('${t}')`).all() as Array<{ name: string; type: string; pk: number }>;

export class ImportConflict extends Error {}

/**
 * Copies `source` into `target` in one transaction. A store or brand whose slug is taken by a different one here gets
 * "<slug>-qsr" (then -qsr2, ...) and is reported (its ordering page address changes). Auto-numbered ids (log rows) get
 * new numbers. UrbanPiper: one account per hub; two different businesses stop the import (ImportConflict).
 */
export function importHub(target: Db, source: Db, o: { slugSuffix?: string; posType?: string } = {}): ImportReport {
  const report: ImportReport = { tables: {}, renamed: [], settingsKept: [], urbanpiper: 'none', legacyWebhookToken: null, storeIds: [] };
  const suffix = o.slugSuffix ?? 'qsr';

  // UrbanPiper account first: it decides whether the import may go ahead at all
  const srcUp = tableExists(source, 'up_account') ? source.prepare('SELECT * FROM up_account WHERE id = 1').get() as Record<string, string | number> | undefined : undefined;
  const dstUp = target.prepare('SELECT * FROM up_account WHERE id = 1').get() as Record<string, string | number> | undefined;
  if (srcUp && dstUp && String(srcUp.biz_id) !== String(dstUp.biz_id)) {
    throw new ImportConflict(`Both hubs have an UrbanPiper account, for different businesses (biz ${String(srcUp.biz_id)} and ${String(dstUp.biz_id)}). PosiNext Cloud has one UrbanPiper account; decide which one to keep first.`);
  }

  target.exec('BEGIN IMMEDIATE');
  try {
    // slugs taken here by someone else: rename the incoming one (store and brand slugs share /order/<slug>)
    // the cloud keeps some addresses for itself (portal, admin, demo, ...); the Tiffin hub did not
    const taken = new Set([
      ...RESERVED_SLUGS,
      ...(target.prepare('SELECT slug FROM store').all() as Array<{ slug: string }>).map((r) => r.slug),
      ...(tableExists(target, 'brand') ? (target.prepare('SELECT slug FROM brand').all() as Array<{ slug: string }>).map((r) => r.slug) : []),
    ]);
    const slugMap = new Map<string, string>(); // `${kind}:${id}` -> new slug
    for (const kind of ['store', 'brand'] as const) {
      if (!tableExists(source, kind)) continue;
      for (const r of source.prepare(`SELECT id, slug FROM ${kind}`).all() as Array<{ id: string; slug: string }>) {
        const same = target.prepare(`SELECT 1 FROM ${kind} WHERE id = ?`).get(r.id);
        if (same) continue; // imported before: left as it is
        if (!taken.has(r.slug)) { taken.add(r.slug); continue; }
        let n = 1, to = `${r.slug}-${suffix}`;
        while (taken.has(to)) to = `${r.slug}-${suffix}${++n}`;
        taken.add(to);
        slugMap.set(`${kind}:${r.id}`, to);
        report.renamed.push({ kind, id: r.id, from: r.slug, to });
      }
    }

    for (const t of TABLES) {
      if (!tableExists(source, t) || !tableExists(target, t)) continue;
      const srcCols = columns(source, t), dstCols = new Set(columns(target, t).map((c) => c.name));
      const pks = srcCols.filter((c) => c.pk > 0);
      // a single INTEGER primary key is an auto-number: let this hub number the row
      const autoId = pks.length === 1 && /^INTEGER$/i.test(pks[0]!.type) ? pks[0]!.name : null;
      const cols = srcCols.map((c) => c.name).filter((c) => dstCols.has(c) && c !== autoId);
      const rows = source.prepare(`SELECT ${cols.join(', ')} FROM ${t}`).all() as Array<Record<string, unknown>>;
      const ins = target.prepare(`INSERT OR IGNORE INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      let copied = 0;
      for (const row of rows) {
        if ((t === 'store' || t === 'brand') && slugMap.has(`${t}:${String(row.id)}`)) row.slug = slugMap.get(`${t}:${String(row.id)}`);
        if (t === 'setting') {
          const here = target.prepare('SELECT value_json FROM setting WHERE key = ?').get(row.key) as { value_json: string } | undefined;
          if (here && here.value_json !== row.value_json) report.settingsKept.push(String(row.key));
        }
        const r = ins.run(...cols.map((c) => row[c] as never));
        copied += Number(r.changes);
      }
      report.tables[t] = { source: rows.length, copied, alreadyHere: rows.length - copied };
    }
    report.storeIds = (source.prepare('SELECT id FROM store').all() as Array<{ id: string }>).map((r) => r.id);
    // the POS type of imported stores that do not say (the Tiffin hub has no such column: its stores are QSR)
    if (o.posType) {
      const set = target.prepare('UPDATE store SET pos_type = ? WHERE id = ? AND pos_type IS NULL');
      for (const id of report.storeIds) set.run(o.posType, id);
    }

    if (srcUp && !dstUp) {
      const cols = Object.keys(srcUp);
      target.prepare(`INSERT INTO up_account (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => srcUp[c] as never));
      report.urbanpiper = 'copied';
    } else if (srcUp && dstUp) {
      report.urbanpiper = 'same-business';
      if (srcUp.webhook_token !== dstUp.webhook_token) {
        report.legacyWebhookToken = String(srcUp.webhook_token);
        const cur = target.prepare("SELECT value_json FROM setting WHERE key = 'up_legacy_webhook_tokens'").get() as { value_json: string } | undefined;
        const list = new Set<string>(cur ? JSON.parse(cur.value_json) as string[] : []);
        list.add(String(srcUp.webhook_token));
        target.prepare("INSERT INTO setting (key, value_json, updated_at) VALUES ('up_legacy_webhook_tokens', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
          .run(JSON.stringify([...list]), Date.now());
      }
    } else if (dstUp) report.urbanpiper = 'only-here';
    target.exec('COMMIT');
  } catch (e) {
    target.exec('ROLLBACK');
    throw e;
  }
  return report;
}
