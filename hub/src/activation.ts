import { randomInt } from 'node:crypto';
import { normaliseHardwareId } from '../../packages/licensing/src/index.ts';
import { exec, hash, one, tx } from './db.ts';
import { HubError } from './hub.ts';
import type { Hub } from './hub.ts';
import type { Grant } from './licences.ts';
import { PRODUCTS, productOf, type ProductCode } from './products.ts';

/**
 * Activating a product's Windows app (DinePOS or Tiffin POS) from its licence settings (P7-03, P8-02; ADR-0007). The
 * app's server sends the account's email and password, the PC's hardware id and the product:
 *   trial   a 30-day trial key, once per product per PC, per email and per mobile (trial_claim)
 *   signin  the key this account already has for this PC and product (a reinstall, or a paid plan)
 * The first activation makes the account's store for that PC and, when asked, pairs the outlet with this cloud (the
 * device key), so later renewals reach it through GET /v1/pos/licence.
 */

export const TRIAL_DAYS = 30;

export interface ActivateInput { email?: unknown; password?: unknown; hardwareId?: unknown; outletName?: unknown; mode?: unknown; link?: unknown; product?: unknown }
export interface Activation {
  kind: Grant['kind'];
  product: ProductCode;
  key: string;
  expiresAt: number;
  store: { slug: string; name: string };
  /** Only when `link` was asked: the outlet's key for this cloud (sales sync, renewals). Shown once. */
  deviceKey: string | null;
}

/** A trial claim's fingerprint. DinePOS claims keep the form they had before products existed, so they still count. */
const claimHash = (product: ProductCode, kind: string, value: string) =>
  hash(product === 'fine_dine' ? `trial-claim:${kind}:${value}` : `trial-claim:${product}:${kind}:${value}`);

export class Activations {
  private hub: Hub;
  constructor(hub: Hub) {
    this.hub = hub;
    exec(hub.db, `CREATE TABLE IF NOT EXISTS trial_claim (value_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('hardware','email','phone')),
      account_id TEXT NOT NULL REFERENCES account(id), grant_id TEXT NOT NULL REFERENCES licence_grant(id), claimed_at INTEGER NOT NULL)`);
    const cols = new Set((hub.db.prepare('PRAGMA table_info(trial_claim)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('product')) exec(hub.db, "ALTER TABLE trial_claim ADD COLUMN product TEXT NOT NULL DEFAULT 'fine_dine'");
  }

  async activate(input: ActivateInput): Promise<Activation> {
    const user = await this.hub.accounts.checkLogin(input.email, input.password);
    const hardwareId = normaliseHardwareId(input.hardwareId);
    if (!hardwareId) throw new HubError('VALIDATION', 'This PC’s hardware id was not sent correctly.', 400);
    const product = productOf(input.product);
    if (!product) throw new HubError('VALIDATION', 'This app is not one PosiNext Cloud knows. Update it, or contact us.', 400);
    const app = PRODUCTS[product].app;
    const mode = input.mode === 'trial' ? 'trial' : 'signin';
    const outletName = String(input.outletName ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || `${app} outlet`;
    const account = one<{ id: string; name: string; phone: string; status: string }>(this.hub.db, 'SELECT id, name, phone, status FROM account WHERE id = ?', user.account_id)!;
    if (account.status === 'suspended' || account.status === 'closed') throw new HubError('ACCOUNT_CLOSED', 'This account is not active. Please contact us.', 403);

    // the newest key this account has for this PC that has not ended (a reinstall, or a paid key made in the portal)
    const existing = one<{ id: string; store_id: string }>(this.hub.db, `SELECT id, store_id FROM licence_grant WHERE account_id = ? AND hardware_id = ? AND product = ?
      AND revoked_at IS NULL AND expires_at > ? AND kind != 'demo' ORDER BY expires_at DESC LIMIT 1`, account.id, hardwareId, product, this.hub.now());
    if (existing) return this.answer(this.hub.licences.get(existing.id)!, input.link === true, outletName);
    if (mode === 'signin') throw new HubError('NO_LICENCE', `This account has no ${app} licence for this PC yet. Start the free trial, or choose a plan in your account at portal.posinext.com.`, 404);

    const claims: Array<[string, string]> = [['hardware', hardwareId], ['email', user.email], ['phone', account.phone]];
    const taken = claims.find(([k, v]) => one(this.hub.db, 'SELECT 1 FROM trial_claim WHERE value_hash = ?', claimHash(product, k, v)));
    if (taken) {
      const what = taken[0] === 'hardware' ? 'This PC has' : taken[0] === 'email' ? 'This email has' : 'This mobile number has';
      throw new HubError('TRIAL_USED', `${what} already had a free ${app} trial. Choose a plan in your account at portal.posinext.com, or contact us.`, 409, { claim: taken[0] });
    }
    const storeId = this.storeFor(account.id, hardwareId, product, outletName);
    const grant = tx(this.hub.db, () => {
      const g = this.hub.licences.issue({ storeId, accountId: account.id, hardwareId, kind: 'trial', days: TRIAL_DAYS, seats: PRODUCTS[product].trialSeats, licensee: account.name, by: `account:${user.email}`, product });
      for (const [k, v] of claims) {
        exec(this.hub.db, 'INSERT INTO trial_claim (value_hash, kind, account_id, grant_id, claimed_at, product) VALUES (?,?,?,?,?,?)', claimHash(product, k, v), k, account.id, g.id, this.hub.now(), product);
      }
      if (account.status === 'new') exec(this.hub.db, "UPDATE account SET status = 'trial' WHERE id = ?", account.id);
      return g;
    });
    return this.answer(grant, input.link === true, outletName);
  }

  /**
   * Admin: lets the 30-day trial be started again (testing, or a customer we agree to give a second trial). For the account
   * of `email` (and/or one PC by its hardware id), for one product or both: its unexpired trial keys are revoked (keys are
   * never deleted; the app then finds no key on sign-in) and its trial claims (that email, mobile and PCs; the PC given)
   * are removed, so the next "Start 30-day free trial" makes a new trial. Paid and manual keys are not touched.
   */
  resetTrial(input: { email?: unknown; hardwareId?: unknown; product?: unknown }): { revokedKeys: number; clearedClaims: number; products: ProductCode[] } {
    const email = String(input.email ?? '').trim().toLowerCase();
    const hw = input.hardwareId ? normaliseHardwareId(String(input.hardwareId)) : null;
    if (input.hardwareId && !hw) throw new HubError('VALIDATION', 'That is not a hardware id (like AB12-CD34-EF56-7890).', 400, { fields: { hardwareId: 'Not a hardware id.' } });
    if (!email && !hw) throw new HubError('VALIDATION', 'Give the account email, the PC hardware id, or both.', 400);
    const products: ProductCode[] = input.product ? [productOf(input.product) ?? (() => { throw new HubError('VALIDATION', 'Unknown product.', 400); })()] : (Object.keys(PRODUCTS) as ProductCode[]);
    const user = email ? one<{ account_id: string; email: string }>(this.hub.db, 'SELECT account_id, email FROM account_user WHERE email = ?', email) : undefined;
    if (email && !user) throw new HubError('NOT_FOUND', `No account with the email ${email}.`, 404);
    const phone = user ? one<{ phone: string }>(this.hub.db, 'SELECT phone FROM account WHERE id = ?', user.account_id)?.phone : undefined;
    let revokedKeys = 0, clearedClaims = 0;
    tx(this.hub.db, () => {
      for (const product of products) {
        const where: string[] = [], args: unknown[] = [];
        if (user) { where.push('account_id = ?'); args.push(user.account_id); }
        if (hw) { where.push('hardware_id = ?'); args.push(hw); }
        const trials = this.hub.db.prepare(`SELECT id FROM licence_grant WHERE kind = 'trial' AND product = ? AND revoked_at IS NULL AND (${where.join(' OR ')})`).all(product, ...args) as Array<{ id: string }>;
        for (const g of trials) { this.hub.licences.revoke(g.id, 'trial reset by admin'); revokedKeys++; }
        const hashes = [
          ...(user ? [claimHash(product, 'email', user.email)] : []),
          ...(phone ? [claimHash(product, 'phone', phone)] : []),
          ...(hw ? [claimHash(product, 'hardware', hw)] : []),
        ];
        for (const h of hashes) clearedClaims += Number(this.hub.db.prepare('DELETE FROM trial_claim WHERE value_hash = ?').run(h).changes);
        // the account's other trial PCs too
        if (user) clearedClaims += Number(this.hub.db.prepare('DELETE FROM trial_claim WHERE account_id = ? AND product = ?').run(user.account_id, product).changes);
      }
    });
    return { revokedKeys, clearedClaims, products };
  }

  /** The account's store for this PC and product: the one an earlier key was for, else a new one (named after the outlet). */
  private storeFor(accountId: string, hardwareId: string, product: ProductCode, outletName: string): string {
    const before = one<{ store_id: string }>(this.hub.db, 'SELECT store_id FROM licence_grant WHERE account_id = ? AND hardware_id = ? AND product = ? ORDER BY issued_at DESC LIMIT 1', accountId, hardwareId, product);
    if (before) return before.store_id;
    const base = outletName.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'outlet';
    let slug = '';
    for (let i = 0; i < 20 && !slug; i++) {
      const s = `${base.length < 3 ? `${base}-outlet` : base}-${String(randomInt(1000, 10000))}`;
      if (!one(this.hub.db, 'SELECT 1 FROM store WHERE slug = ? UNION ALL SELECT 1 FROM brand WHERE slug = ?', s, s)) slug = s;
    }
    const st = this.hub.createStore(slug, outletName);
    exec(this.hub.db, 'INSERT INTO account_store (store_id, account_id, added_at) VALUES (?,?,?)', st.storeId, accountId, this.hub.now());
    return st.storeId;
  }

  private answer(g: Grant, link: boolean, outletName: string): Activation {
    const st = one<{ slug: string; name: string }>(this.hub.db, 'SELECT slug, name FROM store WHERE id = ?', g.storeId)!;
    let deviceKey: string | null = null;
    if (link) deviceKey = this.hub.pair(this.hub.newPairingCode(g.storeId), `${outletName.slice(0, 40)} (${PRODUCTS[g.product].app})`).deviceKey;
    return { kind: g.kind, product: g.product, key: g.key, expiresAt: g.expiresAt, store: st, deviceKey };
  }
}
