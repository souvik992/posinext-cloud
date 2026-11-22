import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
// The licensing library (packages/licensing, ADR-0007): the key format, signing and hardware ids for every product.
import { loadSigningKey, normaliseHardwareId, publicKeyBase64, signKey } from '../../packages/licensing/src/index.ts';
import { exec, many, one, tx } from './db.ts';
import type { Db } from './db.ts';
import { HubError } from './hub.ts';
import type { SalesSync } from './sync.ts';
import { DEFAULT_PRODUCT, PRODUCTS, type ProductCode } from './products.ts';

/**
 * Licence keys signed by PosiNext Cloud itself (P7-02, ADR-0006). The cloud holds its own Ed25519 key (`kid: "cloud"`);
 * the DinePOS app trusts it next to the vendor's offline master key, but only for keys of at most 400 days. Every key
 * signed here is a row in licence_grant (append-only: a revoke only marks it). A grant is put in the store's licence
 * slot, so the outlet's hourly renewal (GET /v1/pos/licence) installs it; a revoke takes it out of the slot but cannot
 * reach a key the outlet already installed (it is checked offline, until it ends).
 */

export const CLOUD_KEY_MAX_DAYS = 400;
const DAY = 86_400_000;
/** The Free plan's key lasts a year; it is renewed FREE_RENEW_DAYS before its end (before the apps' 15-day warning). */
export const FREE_DAYS = 365, FREE_RENEW_DAYS = 30;
/** A trial moves to the Free plan this many days before it ends (before the apps' 2-day trial warning). */
export const FREE_AFTER_TRIAL_DAYS = 3;

export type GrantKind = 'trial' | 'paid' | 'demo' | 'manual' | 'free';
export interface Seats { terminals: number; captains: number; kds: number }
export interface GrantInput {
  storeId: string;
  accountId?: string | null;
  hardwareId: string;
  kind: GrantKind;
  days: number;
  seats: Seats;
  licensee: string;
  features?: string[];
  /** P8-02: the product the key is for (default fine_dine); written into the key as `product`. */
  product?: ProductCode;
  /** Put it in the store's licence slot (default true). */
  putInSlot?: boolean;
  by?: string;
}
export interface Grant {
  id: string; storeId: string; accountId: string | null; hardwareId: string; kind: GrantKind; licensee: string; seats: Seats; features: string[];
  issuedAt: number; expiresAt: number; revokedAt: number | null; revokedReason: string | null; by: string; key: string; product: ProductCode;
}
interface GrantRow {
  id: string; store_id: string; account_id: string | null; hardware_id: string; kind: GrantKind; licensee: string; seats_json: string; features_json: string;
  issued_at: number; expires_at: number; key_text: string; revoked_at: number | null; revoked_reason: string | null; created_by: string; product: ProductCode;
}

/** The signing key from a PEM (PKCS#8) text or file (Ed25519 only), and its public half as base64 SPKI. */
export { loadSigningKey, publicKeyBase64 };

const toGrant = (r: GrantRow): Grant => ({
  id: r.id, storeId: r.store_id, accountId: r.account_id, hardwareId: r.hardware_id, kind: r.kind, licensee: r.licensee,
  seats: JSON.parse(r.seats_json) as Seats, features: JSON.parse(r.features_json) as string[], issuedAt: r.issued_at, expiresAt: r.expires_at,
  revokedAt: r.revoked_at, revokedReason: r.revoked_reason, by: r.created_by, key: r.key_text, product: r.product,
});

export class Licences {
  private db: Db;
  private now: () => number;
  private sync: SalesSync;
  private key: KeyObject | null;
  constructor(db: Db, now: () => number, sync: SalesSync, key: KeyObject | null) { this.db = db; this.now = now; this.sync = sync; this.key = key; }

  get ready(): boolean { return this.key !== null; }
  publicKey(): string | null { return this.key ? publicKeyBase64(this.key) : null; }

  /** Signs a key for one PC (or hosted outlet) and records it. Throws NOT_AVAILABLE when no signing key is set up. */
  issue(input: GrantInput): Grant {
    if (!this.key) throw new HubError('NOT_AVAILABLE', 'This cloud has no licence signing key yet (HUB_LICENCE_SIGNING_KEY_FILE).', 503);
    const hardwareId = normaliseHardwareId(input.hardwareId);
    if (!hardwareId) throw new HubError('VALIDATION', 'The hardware id looks like AB12-CD34-EF56-7890-1A2B (Settings › Licence on that PC).', 400, { fields: { hardwareId: 'Not a hardware id.' } });
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > CLOUD_KEY_MAX_DAYS) throw new HubError('VALIDATION', `A cloud key lasts 1 to ${CLOUD_KEY_MAX_DAYS} days.`, 400, { fields: { days: `1 to ${CLOUD_KEY_MAX_DAYS}.` } });
    const s = input.seats;
    if (!s || ![s.terminals, s.captains, s.kds].every((n) => Number.isInteger(n) && n >= 0 && n <= 99) || s.terminals < 1) throw new HubError('VALIDATION', 'Seats: at least 1 terminal; 0 to 99 of each.', 400, { fields: { seats: 'Check the seats.' } });
    const licensee = String(input.licensee ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!licensee) throw new HubError('VALIDATION', 'Enter who the licence is for.', 400, { fields: { licensee: 'Required.' } });
    if (!one(this.db, 'SELECT 1 FROM store WHERE id = ?', input.storeId)) throw new HubError('NOT_FOUND', 'No such store.', 404);
    const issuedAt = this.now(), expiresAt = issuedAt + input.days * DAY;
    const seats = { terminals: s.terminals, captains: s.captains, kds: s.kds };
    // P7-03: trial and demo keys say so (the app then warns only in their last days)
    const features = [...new Set([...(input.features ?? []), ...(input.kind === 'trial' || input.kind === 'demo' ? ['trial'] : [])])];
    const product = input.product ?? DEFAULT_PRODUCT;
    const keyText = signKey({ kid: 'cloud', licensee, hardwareId, issuedAt: new Date(issuedAt), expiresAt: new Date(expiresAt), seats, features, outletId: input.storeId, product }, this.key);
    const id = randomUUID();
    tx(this.db, () => {
      exec(this.db, `INSERT INTO licence_grant (id, account_id, store_id, hardware_id, kind, licensee, seats_json, features_json, issued_at, expires_at, key_text, created_by, product)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, input.accountId ?? null, input.storeId, hardwareId, input.kind, licensee, JSON.stringify(seats), JSON.stringify(features), issuedAt, expiresAt, keyText, input.by ?? 'cloud', product);
      if (input.putInSlot !== false) this.sync.setLicence(input.storeId, keyText);
    });
    return this.get(id)!;
  }

  get(id: string): Grant | null {
    const r = one<GrantRow>(this.db, 'SELECT * FROM licence_grant WHERE id = ?', id);
    return r ? toGrant(r) : null;
  }

  /** P8-07: an account's keys for the portal, newest first, with the outlet's name (browser demos left out). */
  forAccount(accountId: string): Array<Grant & { storeName: string }> {
    return many<GrantRow & { store_name: string }>(this.db, `SELECT g.*, s.name AS store_name FROM licence_grant g JOIN store s ON s.id = g.store_id
      WHERE g.account_id = ? AND g.kind != 'demo' ORDER BY g.issued_at DESC LIMIT 200`, accountId).map((r) => ({ ...toGrant(r), storeName: r.store_name }));
  }

  /**
   * The Free plan (2026-11-22). For each PC of a portal account whose newest key (per outlet, PC and product) is
   *  - a trial with FREE_AFTER_TRIAL_DAYS days or less left (or already ended),
   *  - a paid key that has ended (the shop keeps billing on one PC instead of locking), or
   *  - a free key with FREE_RENEW_DAYS days or less left,
   * a new free key (FREE_DAYS, the product's free seats, every feature) is signed and put in the outlet's slot; the
   * app installs it at its next hourly renewal (it ends later than the key it has). Revoked keys, manual and demo keys,
   * closed, suspended or deleted accounts and products without a Free plan are left alone. Returns how many keys were made.
   */
  sweepFree(): number {
    if (!this.key) return 0;
    const now = this.now();
    const due = many<GrantRow>(this.db, `SELECT g.* FROM licence_grant g JOIN account a ON a.id = g.account_id
      WHERE g.revoked_at IS NULL AND a.status NOT IN ('suspended','closed','deleted')
        AND ((g.kind = 'trial' AND g.expires_at <= ?) OR (g.kind = 'paid' AND g.expires_at <= ?) OR (g.kind = 'free' AND g.expires_at <= ?))
        AND NOT EXISTS (SELECT 1 FROM licence_grant x WHERE x.store_id = g.store_id AND x.hardware_id = g.hardware_id AND x.product = g.product
          AND x.revoked_at IS NULL AND x.kind != 'demo' AND x.id != g.id AND x.expires_at >= g.expires_at)`,
      now + FREE_AFTER_TRIAL_DAYS * DAY, now, now + FREE_RENEW_DAYS * DAY);
    let made = 0;
    for (const g of due) {
      const seats = PRODUCTS[g.product]?.freeSeats;
      if (!seats) continue;
      this.issue({ storeId: g.store_id, accountId: g.account_id, hardwareId: g.hardware_id, kind: 'free', days: FREE_DAYS, seats, licensee: g.licensee, product: g.product, by: 'cloud:free-plan' });
      made++;
    }
    return made;
  }

  forStore(storeId: string): Grant[] {
    return many<GrantRow>(this.db, 'SELECT * FROM licence_grant WHERE store_id = ? ORDER BY issued_at DESC LIMIT 100', storeId).map(toGrant);
  }

  /** Marks the grant revoked and takes it out of the store's slot (if it is the key there). */
  revoke(id: string, reason: unknown): Grant {
    const g = this.get(id);
    if (!g) throw new HubError('NOT_FOUND', 'No such licence grant.', 404);
    if (g.revokedAt !== null) return g;
    const why = String(reason ?? '').trim().slice(0, 200) || 'revoked';
    tx(this.db, () => {
      exec(this.db, 'UPDATE licence_grant SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL', this.now(), why, id);
      exec(this.db, 'DELETE FROM store_licence WHERE store_id = ? AND licence_key = ?', g.storeId, g.key);
    });
    return this.get(id)!;
  }
}
