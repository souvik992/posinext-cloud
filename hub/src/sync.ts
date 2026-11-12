import { createHash } from 'node:crypto';
import { exec, many, one, tx } from './db.ts';
import type { Db } from './db.ts';
import { HubError } from './hub.ts';
import type { DeviceRef } from './hub.ts';

/**
 * Sales sync and licence renewals for DinePOS outlets (DinePOS P4-05, docs/05 "Cloud sync"):
 *   up    the outlet's outbox (day.closed, bill.printed, bill.settled, bill.voided), in its own numbering (seq), in batches.
 *         Each outlet database is one stream (its streamId), so a reinstalled or restored POS never overwrites what an
 *         earlier one sent. The hub acks the highest seq it holds; resending a batch is harmless (same seq, same payload).
 *   down  the outlet's licence key, put here by the vendor (admin) and fetched by the POS, which checks it itself.
 * The hub never needs this to take orders, and the POS never needs the hub to bill.
 */

export interface SyncBatch { streamId: string; fromSeq: number; events: Array<{ seq: number; kind: string; payload: unknown; createdAt: string }> }

export const MAX_SYNC_EVENTS = 500;
const STREAM_ID = /^[0-9A-Za-z]{16,64}$/;
const KIND = /^[a-z][a-z0-9._-]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,400}$/;

interface Tender { mode: string; amountPaise: number }
interface ZReport { bills: number; covers: number; netSalesPaise: number; grossSalesPaise: number; discountPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; byMode: Tender[]; cashExpectedPaise: number; cashCountedPaise: number; closedAt: string; voids?: Array<{ amountPaise: number }> }
export interface SalesDay {
  businessDate: string;
  /** closed: figures from the day's Z report; open: added up from the bills received so far */
  closed: boolean;
  closedAt: string | null;
  bills: number;
  covers: number | null;
  netSalesPaise: number;
  taxPaise: number | null;
  discountPaise: number | null;
  byMode: Tender[];
  voids: number;
  voidPaise: number;
  cashDifferencePaise: number | null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : 0);

/** What a licence key says about itself (not checked here: the POS verifies the signature and its hardware id). */
function describeKey(key: string): { licensee: string | null; expiresAt: string | null; hardwareId: string | null } {
  try {
    const p = JSON.parse(Buffer.from(key.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, 120) : null);
    return { licensee: s(p.licensee), expiresAt: s(p.expiresAt), hardwareId: s(p.hardwareId) };
  } catch { return { licensee: null, expiresAt: null, hardwareId: null }; }
}

export class SalesSync {
  private db: Db; private now: () => number;
  constructor(db: Db, now: () => number) { this.db = db; this.now = now; }

  /** POST /v1/pos/sync/batches: stores the batch (or finds it already stored) and returns the highest seq held. */
  receive(dev: DeviceRef, body: unknown): { ackSeq: number; stored: number } {
    const b = this.check(body);
    return tx(this.db, () => {
      let s = one<{ ack_seq: number }>(this.db, 'SELECT ack_seq FROM sync_stream WHERE store_id = ? AND stream_id = ?', dev.storeId, b.streamId);
      if (!s) {
        exec(this.db, 'INSERT INTO sync_stream (store_id, stream_id, first_seq, ack_seq, created_at, last_at) VALUES (?,?,?,?,?,?)', dev.storeId, b.streamId, b.fromSeq, b.fromSeq - 1, this.now(), this.now());
        s = { ack_seq: b.fromSeq - 1 };
      }
      // a gap: the POS thinks the hub holds events it does not (e.g. the hub was restored from a backup) — it resends from ackSeq + 1
      if (b.fromSeq > s.ack_seq + 1) throw new HubError('SYNC_GAP', `The hub has this outlet's sales up to number ${s.ack_seq} only. Send from ${s.ack_seq + 1}.`, 409, { ackSeq: s.ack_seq });
      let stored = 0;
      for (const e of b.events) {
        const text = JSON.stringify(e.payload ?? null);
        const h = sha(`${e.kind}\n${text}`);
        if (e.seq <= s.ack_seq) {
          const had = one<{ payload_hash: string }>(this.db, 'SELECT payload_hash FROM sync_event WHERE store_id = ? AND stream_id = ? AND seq = ?', dev.storeId, b.streamId, e.seq);
          if (had && had.payload_hash !== h) throw new HubError('SYNC_CONFLICT', `The hub already holds a different record number ${e.seq} from this outlet. Was its database restored from a backup? Start a new sync stream on the POS.`, 409, { seq: e.seq, ackSeq: s.ack_seq });
          if (had) continue;
        }
        const p = e.payload as { businessDate?: unknown } | null;
        const day = p && typeof p === 'object' && typeof p.businessDate === 'string' && DATE.test(p.businessDate) ? p.businessDate : null;
        exec(this.db, 'INSERT INTO sync_event (store_id, stream_id, seq, kind, payload_json, payload_hash, business_date, created_at, received_at) VALUES (?,?,?,?,?,?,?,?,?)',
          dev.storeId, b.streamId, e.seq, e.kind, text, h, day, e.createdAt, this.now());
        stored++;
      }
      const ack = Math.max(s.ack_seq, b.events[b.events.length - 1]!.seq);
      exec(this.db, 'UPDATE sync_stream SET ack_seq = ?, last_at = ? WHERE store_id = ? AND stream_id = ?', ack, this.now(), dev.storeId, b.streamId);
      return { ackSeq: ack, stored };
    });
  }

  private check(body: unknown): SyncBatch {
    const b = (body ?? {}) as Partial<SyncBatch>;
    const bad = (m: string) => new HubError('VALIDATION', m);
    if (typeof b.streamId !== 'string' || !STREAM_ID.test(b.streamId)) throw bad('streamId must be 16-64 letters or digits.');
    if (!Array.isArray(b.events) || b.events.length === 0 || b.events.length > MAX_SYNC_EVENTS) throw bad(`Send 1-${MAX_SYNC_EVENTS} events in a batch.`);
    if (!Number.isSafeInteger(b.fromSeq) || b.fromSeq! < 1) throw bad('fromSeq must be a whole number from 1.');
    b.events.forEach((e, i) => {
      if (!e || typeof e !== 'object') throw bad(`Event ${i + 1} is not an object.`);
      if (e.seq !== b.fromSeq! + i) throw bad('Events must be numbered one after another from fromSeq.');
      if (typeof e.kind !== 'string' || !KIND.test(e.kind)) throw bad(`Event ${e.seq}: kind is not valid.`);
      if (typeof e.createdAt !== 'string' || e.createdAt.length > 40) throw bad(`Event ${e.seq}: createdAt is not valid.`);
    });
    return b as SyncBatch;
  }

  /** The admin's sales view: the latest business days, newest first, and when the outlet last sent. */
  sales(storeId: string, days = 14): { days: SalesDay[]; lastSyncAt: number | null; events: number } {
    const n = Math.min(Math.max(1, Math.trunc(days) || 14), 90);
    const rows = many<{ kind: string; payload_json: string; business_date: string }>(this.db,
      `SELECT kind, payload_json, business_date FROM sync_event WHERE store_id = ? AND business_date IN (
         SELECT DISTINCT business_date FROM sync_event WHERE store_id = ? AND business_date IS NOT NULL ORDER BY business_date DESC LIMIT ?)
       ORDER BY received_at, stream_id, seq`, storeId, storeId, n);
    const byDay = new Map<string, { z: ZReport | null; bills: Map<string, { total: number; voided: boolean; tenders: Tender[] }> }>();
    for (const r of rows) {
      const d = byDay.get(r.business_date) ?? { z: null, bills: new Map() };
      byDay.set(r.business_date, d);
      const p = JSON.parse(r.payload_json) as { billId?: string; totalPaise?: number; tenders?: Tender[]; zReport?: ZReport };
      if (r.kind === 'day.closed' && p.zReport) { d.z = p.zReport; continue; } // a day closed again (reinstall): the latest Z report
      if (typeof p.billId !== 'string') continue;
      const bill = d.bills.get(p.billId) ?? { total: 0, voided: false, tenders: [] };
      d.bills.set(p.billId, bill);
      if (r.kind === 'bill.printed') bill.total = int(p.totalPaise); // a reprint after changes: its latest total
      else if (r.kind === 'bill.settled') bill.tenders = Array.isArray(p.tenders) ? p.tenders : [];
      else if (r.kind === 'bill.voided') { bill.voided = true; bill.total = int(p.totalPaise) || bill.total; }
    }
    const out: SalesDay[] = [...byDay.entries()].map(([businessDate, d]) => {
      const bills = [...d.bills.values()];
      const voided = bills.filter((b) => b.voided);
      if (d.z) {
        const z = d.z;
        return { businessDate, closed: true, closedAt: z.closedAt ?? null, bills: int(z.bills), covers: int(z.covers), netSalesPaise: int(z.netSalesPaise),
          taxPaise: int(z.cgstPaise) + int(z.sgstPaise) + int(z.igstPaise), discountPaise: int(z.discountPaise),
          byMode: (z.byMode ?? []).map((m) => ({ mode: String(m.mode), amountPaise: int(m.amountPaise) })),
          voids: z.voids?.length ?? voided.length, voidPaise: z.voids ? z.voids.reduce((s, v) => s + int(v.amountPaise), 0) : voided.reduce((s, b) => s + b.total, 0),
          cashDifferencePaise: int(z.cashCountedPaise) - int(z.cashExpectedPaise) };
      }
      const live = bills.filter((b) => !b.voided);
      const modes = new Map<string, number>();
      for (const b of live) for (const t of b.tenders) modes.set(String(t.mode), (modes.get(String(t.mode)) ?? 0) + int(t.amountPaise));
      return { businessDate, closed: false, closedAt: null, bills: live.length, covers: null, netSalesPaise: live.reduce((s, b) => s + b.total, 0), taxPaise: null, discountPaise: null,
        byMode: [...modes].map(([mode, amountPaise]) => ({ mode, amountPaise })), voids: voided.length, voidPaise: voided.reduce((s, b) => s + b.total, 0), cashDifferencePaise: null };
    }).sort((a, b) => b.businessDate.localeCompare(a.businessDate));
    const st = one<{ last_at: number | null; events: number }>(this.db, 'SELECT max(last_at) AS last_at, (SELECT count(*) FROM sync_event WHERE store_id = ?) AS events FROM sync_stream WHERE store_id = ?', storeId, storeId)!;
    return { days: out, lastSyncAt: st.last_at, events: st.events };
  }

  // ---------------------------------------------------------------- licence renewals (down)

  /** Admin: the outlet's licence key for its POS to fetch (empty: removed). The hub does not verify it; the POS does. */
  setLicence(storeId: string, key: unknown) {
    const k = typeof key === 'string' ? key.replace(/\s+/g, '') : '';
    if (!k) { exec(this.db, 'DELETE FROM store_licence WHERE store_id = ?', storeId); return this.licenceInfo(storeId); }
    if (!KEY.test(k)) throw new HubError('VALIDATION', 'That is not a DinePOS licence key. Paste the whole key the vendor issued.');
    exec(this.db, 'INSERT INTO store_licence (store_id, licence_key, updated_at) VALUES (?,?,?) ON CONFLICT (store_id) DO UPDATE SET licence_key = excluded.licence_key, updated_at = excluded.updated_at', storeId, k, this.now());
    return this.licenceInfo(storeId);
  }

  licenceInfo(storeId: string) {
    const r = one<{ licence_key: string; updated_at: number }>(this.db, 'SELECT licence_key, updated_at FROM store_licence WHERE store_id = ?', storeId);
    return r ? { set: true, updatedAt: r.updated_at, ...describeKey(r.licence_key) } : { set: false, updatedAt: null, licensee: null, expiresAt: null, hardwareId: null };
  }

  /** GET /v1/pos/licence: the key the vendor put here for this outlet, if any. */
  licence(dev: DeviceRef): { key: string | null; updatedAt: number | null } {
    const r = one<{ licence_key: string; updated_at: number }>(this.db, 'SELECT licence_key, updated_at FROM store_licence WHERE store_id = ?', dev.storeId);
    return { key: r?.licence_key ?? null, updatedAt: r?.updated_at ?? null };
  }
}
