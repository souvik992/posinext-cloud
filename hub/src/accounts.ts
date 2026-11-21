import { randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { exec, hash, many, one, tx } from './db.ts';
import type { Db } from './db.ts';
import { HubError } from './hub.ts';
import { DEFAULT_PRODUCT, PRODUCTS, type ProductCode } from './products.ts';
import type { Mailer } from './mailer.ts';
import { fullChecks, type Checks } from './settings.ts';
import type { SendSms } from './sms.ts';

/**
 * Customer accounts (P7-01, ADR-0006): the businesses that buy DinePOS, and the people who sign in to the portal.
 * Sign up → a 6-digit code by email → verified and signed in. Passwords are scrypt-hashed (never stored or logged in
 * clear); portal sign-ins are random tokens of which only the SHA-256 is stored. A person whose email is not verified
 * never gets a session, so cannot reach the portal.
 * Per the hub's security checks (src/settings.ts), on the portal's address: the account's mobile number is confirmed by
 * an SMS code before the first sign-in (mobile verification), and the owner can sign in with an SMS code (otp).
 */

/** A portal sign-in ends only after this long without a visit (each visit moves the end on): 400 days, the longest a
 *  browser keeps a cookie. Changing or resetting the password, or signing a device out, ends sessions at once. */
const SESSION_MS = 400 * 86_400_000;
const CODE_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const SENDS_PER_HOUR = 5;
const LOGIN_FAILS = 10, LOGIN_WINDOW_MS = 15 * 60_000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type CodePurpose = 'verify' | 'reset';
export type SmsPurpose = 'phone' | 'signin';
const PENDING_MS = 30 * 60_000;
export type AccountRole = 'owner' | 'admin' | 'billing';
export interface UserRow { id: string; account_id: string; email: string; name: string; password_hash: string; role: AccountRole; verified_at: number | null; created_at: number }
interface AccountRow { id: string; name: string; phone: string; gstin: string | null; status: string; created_at: number; products_json: string }

export interface AccountsOptions {
  mailer: Mailer;
  /** Accept the development mailer (codes in the log). Off in production: sign-up is then closed until email is set up. */
  allowLogMailer?: boolean;
  /**
   * HUB_SKIP_EMAIL_VERIFY=1: sign-up needs no emailed code: the account is created confirmed and signed in at once, and
   * sign-up is open without an email provider. For getting started only: anyone can then sign up with an email that is
   * not theirs, and "forgot password" cannot work without email.
   */
  skipEmailVerify?: boolean;
  /** The hub's security checks (read on each use, so the admin page changes them at once). Not given: skipEmailVerify only. */
  checks?: () => Checks;
  /** SMS codes (mobile verification, sign in with a code). Not given: codes are only logged (masked, or in full with allowLogMailer). */
  sendSms?: SendSms;
  /** The SMS sender in use now (the admin page can set MSG91 up while the hub runs); wins over sendSms. */
  sms?: () => SendSms | undefined;
  log?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
}

const scryptAsync = (password: string, salt: Buffer) => new Promise<Buffer>((res, rej) =>
  scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key || Number(n) !== SCRYPT.N || Number(r) !== SCRYPT.r || Number(p) !== SCRYPT.p) return false;
  const want = Buffer.from(key, 'base64url');
  const got = await scryptAsync(password, Buffer.from(salt, 'base64url'));
  return got.length === want.length && timingSafeEqual(got, want);
}

const normEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();
function checkEmail(v: unknown): string {
  const e = normEmail(v);
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new HubError('VALIDATION', 'Enter a valid email address.', 400, { fields: { email: 'Enter a valid email address.' } });
  return e;
}
function checkNewPassword(v: unknown, field = 'password'): string {
  const p = typeof v === 'string' ? v : '';
  if (p.length < 8) throw new HubError('VALIDATION', 'The password must be at least 8 characters.', 400, { fields: { [field]: 'At least 8 characters.' } });
  if (p.length > 200) throw new HubError('VALIDATION', 'The password is too long (at most 200 characters).', 400, { fields: { [field]: 'At most 200 characters.' } });
  return p;
}
function checkText(v: unknown, field: string, label: string, max: number): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new HubError('VALIDATION', `Enter ${label}.`, 400, { fields: { [field]: `Enter ${label}.` } });
  if (s.length > max) throw new HubError('VALIDATION', `Keep ${label} under ${max} characters.`, 400, { fields: { [field]: `At most ${max} characters.` } });
  return s;
}
/** Indian 10-digit mobiles become +91…; other numbers must start with + and the country code. */
export function normalisePhone(v: unknown): string {
  const raw = String(v ?? '').replace(/[\s()-]/g, '');
  const d = raw.replace(/^\+/, '');
  if (/^[6-9]\d{9}$/.test(raw)) return `+91${raw}`;
  if (/^(0|91)[6-9]\d{9}$/.test(raw)) return `+91${raw.slice(-10)}`;
  if (raw.startsWith('+') && /^\d{8,15}$/.test(d)) return `+${d}`;
  throw new HubError('VALIDATION', 'Enter a mobile number, e.g. 98765 43210 or +44 7700 900123.', 400, { fields: { phone: 'Enter a mobile number.' } });
}

export interface Me {
  user: { id: string; name: string; email: string; role: AccountRole };
  account: { id: string; name: string; phone: string; gstin: string | null; status: string; createdAt: number; products: ProductCode[] };
  stores: Array<{ slug: string; name: string }>;
}

export class Accounts {
  private loginFails = new Map<string, { n: number; start: number }>();
  private db: Db;
  private now: () => number;
  private o: AccountsOptions;
  constructor(db: Db, now: () => number, o: AccountsOptions) { this.db = db; this.now = now; this.o = o; }

  /** False while only the development mailer is set and it is not allowed (production without email set up). */
  get open(): boolean { return this.o.mailer.kind !== 'log' || this.o.allowLogMailer === true || this.skipEmail; }
  private checks(): Checks { return this.o.checks ? this.o.checks() : fullChecks({ emailVerification: { portal: !this.o.skipEmailVerify } }); }
  /** Email verification switched off (security checks, or HUB_SKIP_EMAIL_VERIFY): sign-up signs in at once. */
  private get skipEmail(): boolean { return !this.checks().emailVerification.portal; }
  /** Mobile verification in progress: a short-lived reference to a person whose password (or email code) was right. */
  private pending = new Map<string, { userId: string; expires: number }>();
  private needOpen() {
    if (!this.open) throw new HubError('SIGNUP_CLOSED', 'Sign-up is not open yet. Please contact us.', 503);
  }

  // ---------------------------------------------------------------- sign up, verify

  /** A new account. Normally an emailed code confirms it (verify: true); with skipEmailVerify it is signed in at once. */
  async signup(input: unknown, userAgent?: string, portal = false): Promise<{ email: string; verify: true } | { email: string; verify: false; session: { token: string; expiresAt: number } }> {
    this.needOpen();
    const b = (input ?? {}) as Record<string, unknown>;
    const businessName = checkText(b.businessName, 'businessName', 'the business name', 80);
    const name = checkText(b.name, 'name', 'your name', 80);
    const email = checkEmail(b.email);
    const phone = normalisePhone(b.phone);
    const password = checkNewPassword(b.password);
    const products = checkProducts(b.products ?? [DEFAULT_PRODUCT]);
    const passwordHash = await hashPassword(password);
    const userId = randomUUID();
    tx(this.db, () => {
      if (one(this.db, 'SELECT 1 FROM account_user WHERE email = ?', email)) throw new HubError('EMAIL_TAKEN', 'An account with this email already exists. Sign in, or reset your password.', 409, { fields: { email: 'Already registered.' } });
      const accountId = randomUUID(), at = this.now();
      exec(this.db, "INSERT INTO account (id, name, phone, status, created_at, products_json) VALUES (?,?,?,'new',?,?)", accountId, businessName, phone, at, JSON.stringify(products));
      exec(this.db, "INSERT INTO account_user (id, account_id, email, name, password_hash, role, created_at, verified_at) VALUES (?,?,?,?,?,'owner',?,?)",
        userId, accountId, email, name, passwordHash, at, this.skipEmail ? at : null);
    });
    if (this.skipEmail) {
      this.o.log?.info('account signed up (email not checked: email verification is off)', { email });
      return { email, verify: false, session: await this.startSession(this.userByEmail(email)!, userAgent, portal) };
    }
    this.o.log?.info('account signed up', { email });
    await this.sendCode(userId, email, 'verify');
    return { email, verify: true };
  }

  /** Always answers the same, whether or not the email is known (no account lookup through this). */
  async resendVerify(emailIn: unknown): Promise<{ ok: true }> {
    this.needOpen();
    const u = this.userByEmail(normEmail(emailIn));
    if (u && u.verified_at === null) await this.sendCode(u.id, u.email, 'verify', true);
    return { ok: true };
  }

  /** P8-06: the products the account uses (owner or admin). Shown in the portal: downloads, add-ons, licences. */
  setProducts(token: string | undefined, input: unknown): { products: ProductCode[] } {
    const u = this.session(token);
    if (u.role === 'billing') throw new HubError('FORBIDDEN', 'Only an owner or admin can change the products.', 403);
    const products = checkProducts(input);
    exec(this.db, 'UPDATE account SET products_json = ? WHERE id = ?', JSON.stringify(products), u.account_id);
    return { products };
  }

  async verifyEmail(emailIn: unknown, code: unknown, userAgent?: string, portal = false) {
    const u = this.userByEmail(normEmail(emailIn));
    if (!u) throw new HubError('WRONG_CODE', 'That code is not right.', 400);
    this.useCode('email_code', u.id, 'verify', code);
    exec(this.db, 'UPDATE account_user SET verified_at = COALESCE(verified_at, ?) WHERE id = ?', this.now(), u.id);
    this.o.log?.info('account email verified', { email: u.email });
    return this.startSession(u, userAgent, portal);
  }

  // ---------------------------------------------------------------- sign in, out

  async login(emailIn: unknown, password: unknown, userAgent?: string, portal = false) {
    const u = await this.checkLogin(emailIn, password);
    return this.startSession(u, userAgent, portal);
  }

  // ---------------------------------------------------------------- mobile verification, sign in with a code (SMS)

  /**
   * A portal sign-in once every check passed. With mobile verification on (portal address only), an account whose
   * mobile is not confirmed gets an SMS code instead: PHONE_NOT_VERIFIED with `pending`, used by verifyPhone().
   */
  private async startSession(u: UserRow, userAgent: string | undefined, portal: boolean) {
    if (portal && this.checks().mobileVerification.portal) {
      const a = one<{ phone: string; phone_verified_at: number | null }>(this.db, 'SELECT phone, phone_verified_at FROM account WHERE id = ?', u.account_id)!;
      if (a.phone_verified_at === null) {
        const pending = `pv_${randomBytes(24).toString('base64url')}`;
        this.pending.set(hash(pending), { userId: u.id, expires: this.now() + PENDING_MS });
        await this.sendSmsCode(u.id, a.phone, 'phone', true);
        throw new HubError('PHONE_NOT_VERIFIED', `Confirm your mobile number: we have sent a code to ${maskPhone(a.phone)}.`, 403, { pending, phone: maskPhone(a.phone) });
      }
    }
    return this.newSession(u.id, userAgent);
  }

  private pendingUser(pending: unknown): UserRow {
    const key = typeof pending === 'string' ? hash(pending) : '';
    const p = this.pending.get(key);
    const u = p && p.expires > this.now() ? one<UserRow>(this.db, 'SELECT * FROM account_user WHERE id = ?', p.userId) : undefined;
    if (!u) throw new HubError('PENDING_EXPIRED', 'This step has expired. Please sign in again.', 400);
    return u;
  }

  /** The SMS code sent by startSession(): confirms the account's mobile and signs in. */
  verifyPhone(pending: unknown, code: unknown, userAgent?: string) {
    const u = this.pendingUser(pending);
    this.useCode('sms_code', u.id, 'phone', code);
    exec(this.db, 'UPDATE account SET phone_verified_at = COALESCE(phone_verified_at, ?) WHERE id = ?', this.now(), u.account_id);
    this.pending.delete(hash(String(pending)));
    this.o.log?.info('account mobile verified', { email: u.email });
    return this.newSession(u.id, userAgent);
  }

  async resendPhone(pending: unknown): Promise<{ ok: true }> {
    const u = this.pendingUser(pending);
    const a = one<{ phone: string }>(this.db, 'SELECT phone FROM account WHERE id = ?', u.account_id)!;
    await this.sendSmsCode(u.id, a.phone, 'phone');
    return { ok: true };
  }

  /** The owner of the one account with this confirmed mobile (and a confirmed email), if exactly one. */
  private ownerByPhone(phoneIn: unknown): UserRow | undefined {
    const phone = normalisePhone(phoneIn);
    const rows = many<UserRow>(this.db, `SELECT u.* FROM account a JOIN account_user u ON u.account_id = a.id AND u.role = 'owner'
      WHERE a.phone = ? AND a.phone_verified_at IS NOT NULL AND u.verified_at IS NOT NULL`, phone);
    return rows.length === 1 ? rows[0] : undefined;
  }

  private needCodeSignIn() {
    if (!this.checks().otp.portal) throw new HubError('NOT_AVAILABLE', 'Signing in with a code is not switched on. Sign in with your password.', 404);
  }

  /** Sign in with a code, step 1. Always answers the same, whether or not the number has an account. */
  async sendSignInCode(phoneIn: unknown): Promise<{ ok: true }> {
    this.needCodeSignIn();
    const u = this.ownerByPhone(phoneIn);
    if (u) await this.sendSmsCode(u.id, normalisePhone(phoneIn), 'signin', true);
    return { ok: true };
  }

  /** Sign in with a code, step 2: the code proves the (confirmed) mobile, so no other check is asked. */
  signInWithCode(phoneIn: unknown, code: unknown, userAgent?: string) {
    this.needCodeSignIn();
    const u = this.ownerByPhone(phoneIn);
    if (!u) throw new HubError('WRONG_CODE', 'That code is not right.', 400);
    this.useCode('sms_code', u.id, 'signin', code);
    this.o.log?.info('account signed in with an SMS code', { email: u.email });
    return this.newSession(u.id, userAgent);
  }

  /**
   * Email and password checked (with the same lock-out as the portal), for a verified person. P7-03 uses it for the
   * Windows app's activation, which has no portal session.
   */
  async checkLogin(emailIn: unknown, password: unknown): Promise<UserRow> {
    const email = normEmail(emailIn);
    const now = this.now(), f = this.loginFails.get(email);
    if (f && now - f.start <= LOGIN_WINDOW_MS && f.n >= LOGIN_FAILS) throw new HubError('TOO_MANY_REQUESTS', 'Too many wrong passwords. Wait 15 minutes, or reset your password.', 429);
    const u = this.userByEmail(email);
    const ok = u ? await checkPassword(String(password ?? ''), u.password_hash) : (await hashPassword('timing'), false);
    if (!u || !ok) {
      if (!f || now - f.start > LOGIN_WINDOW_MS) this.loginFails.set(email, { n: 1, start: now }); else f.n++;
      throw new HubError('BAD_LOGIN', 'The email or password is not right.', 401);
    }
    this.loginFails.delete(email);
    if (u.verified_at === null && this.skipEmail) {
      // made while email verification was on: the right password is enough now
      exec(this.db, 'UPDATE account_user SET verified_at = ? WHERE id = ?', now, u.id);
      u.verified_at = now;
    }
    if (u.verified_at === null) {
      if (this.open) await this.sendCode(u.id, u.email, 'verify', true);
      throw new HubError('EMAIL_NOT_VERIFIED', 'Verify your email first: we have sent you a new code.', 403, { email: u.email });
    }
    return u;
  }

  logout(token: string | undefined) {
    if (token) exec(this.db, 'DELETE FROM account_session WHERE token_hash = ?', hash(token));
    return { ok: true };
  }

  /** The signed-in person. Sessions roll: each use (at most hourly) moves the end 400 days on. */
  session(token: string | undefined): UserRow {
    const s = token ? one<{ user_id: string; expires_at: number; last_used_at: number }>(this.db, 'SELECT user_id, expires_at, last_used_at FROM account_session WHERE token_hash = ?', hash(token)) : undefined;
    const now = this.now();
    if (!s || s.expires_at < now) throw new HubError('UNAUTHENTICATED', 'Please sign in.', 401);
    const u = one<UserRow>(this.db, 'SELECT * FROM account_user WHERE id = ?', s.user_id);
    if (!u || u.verified_at === null) throw new HubError('UNAUTHENTICATED', 'Please sign in.', 401);
    if (now - s.last_used_at > 3_600_000) exec(this.db, 'UPDATE account_session SET last_used_at = ?, expires_at = ? WHERE token_hash = ?', now, now + SESSION_MS, hash(token!));
    return u;
  }

  /** When this sign-in ends (for renewing the cookie), or null. */
  sessionExpiry(token: string | undefined): number | null {
    if (!token) return null;
    return one<{ expires_at: number }>(this.db, 'SELECT expires_at FROM account_session WHERE token_hash = ?', hash(token))?.expires_at ?? null;
  }

  /** The person's signed-in devices, newest use first. `id` is a short reference (not usable as a sign-in). */
  sessions(token: string | undefined): Array<{ id: string; createdAt: number; lastUsedAt: number; userAgent: string; current: boolean }> {
    const u = this.session(token);
    const mine = hash(token!);
    return many<{ token_hash: string; created_at: number; last_used_at: number; user_agent: string | null }>(this.db,
      'SELECT token_hash, created_at, last_used_at, user_agent FROM account_session WHERE user_id = ? AND expires_at >= ? ORDER BY last_used_at DESC', u.id, this.now())
      .map((s) => ({ id: s.token_hash.slice(0, 16), createdAt: s.created_at, lastUsedAt: s.last_used_at, userAgent: s.user_agent ?? '', current: s.token_hash === mine }));
  }

  /** Signs one of the person's devices out (by its `id` from sessions()). */
  revokeSession(token: string | undefined, id: unknown): { ok: true } {
    const u = this.session(token);
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new HubError('NOT_FOUND', 'No such device.', 404);
    const n = many<{ token_hash: string }>(this.db, 'SELECT token_hash FROM account_session WHERE user_id = ?', u.id).filter((s) => s.token_hash.startsWith(id));
    if (n.length !== 1) throw new HubError('NOT_FOUND', 'No such device.', 404);
    exec(this.db, 'DELETE FROM account_session WHERE token_hash = ? AND user_id = ?', n[0]!.token_hash, u.id);
    return { ok: true };
  }

  /** Signs out every other device of this person (this one stays signed in). */
  revokeOtherSessions(token: string | undefined): { ok: true; signedOut: number } {
    const u = this.session(token);
    const before = many(this.db, 'SELECT 1 FROM account_session WHERE user_id = ? AND token_hash != ?', u.id, hash(token!)).length;
    exec(this.db, 'DELETE FROM account_session WHERE user_id = ? AND token_hash != ?', u.id, hash(token!));
    return { ok: true, signedOut: before };
  }

  me(token: string | undefined): Me {
    const u = this.session(token);
    const a = one<AccountRow>(this.db, 'SELECT * FROM account WHERE id = ?', u.account_id)!;
    const stores = many<{ slug: string; name: string }>(this.db, 'SELECT s.slug, s.name FROM account_store x JOIN store s ON s.id = x.store_id WHERE x.account_id = ? ORDER BY s.name', a.id);
    return {
      user: { id: u.id, name: u.name, email: u.email, role: u.role },
      account: { id: a.id, name: a.name, phone: a.phone, gstin: a.gstin, status: a.status, createdAt: a.created_at, products: JSON.parse(a.products_json) as ProductCode[] },
      stores,
    };
  }

  // ---------------------------------------------------------------- passwords

  /** Sends a reset code if the email is known. Always answers the same. */
  async forgotPassword(emailIn: unknown): Promise<{ ok: true }> {
    this.needOpen();
    const u = this.userByEmail(normEmail(emailIn));
    if (u) await this.sendCode(u.id, u.email, 'reset', true);
    return { ok: true };
  }

  /** A new password with the emailed code. Ends every sign-in of that person, then signs them in here. */
  async resetPassword(emailIn: unknown, code: unknown, password: unknown, userAgent?: string, portal = false) {
    const pw = checkNewPassword(password);
    const u = this.userByEmail(normEmail(emailIn));
    if (!u) throw new HubError('WRONG_CODE', 'That code is not right.', 400);
    this.useCode('email_code', u.id, 'reset', code);
    const h = await hashPassword(pw);
    tx(this.db, () => {
      // the code reached their inbox, so the email is theirs
      exec(this.db, 'UPDATE account_user SET password_hash = ?, verified_at = COALESCE(verified_at, ?) WHERE id = ?', h, this.now(), u.id);
      exec(this.db, 'DELETE FROM account_session WHERE user_id = ?', u.id);
    });
    this.loginFails.delete(u.email);
    this.o.log?.info('account password reset', { email: u.email });
    return this.startSession(u, userAgent, portal);
  }

  /** Change the password while signed in; other sign-ins of this person end, this one stays. */
  async changePassword(token: string | undefined, current: unknown, next: unknown) {
    const u = this.session(token);
    const pw = checkNewPassword(next);
    if (!(await checkPassword(String(current ?? ''), u.password_hash))) throw new HubError('BAD_LOGIN', 'The current password is not right.', 401, { fields: { current: 'Not right.' } });
    const h = await hashPassword(pw);
    tx(this.db, () => {
      exec(this.db, 'UPDATE account_user SET password_hash = ? WHERE id = ?', h, u.id);
      exec(this.db, 'DELETE FROM account_session WHERE user_id = ? AND token_hash != ?', u.id, hash(token!));
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------- admin, timers

  adminList() {
    return many<{ id: string; name: string; phone: string; status: string; created_at: number; owner_email: string | null; owner_name: string | null; verified_at: number | null; users: number; stores: number; keys: number }>(this.db, `
      SELECT a.id, a.name, a.phone, a.status, a.created_at, o.email AS owner_email, o.name AS owner_name, o.verified_at,
        (SELECT COUNT(*) FROM account_user u WHERE u.account_id = a.id) AS users,
        (SELECT COUNT(*) FROM account_store s WHERE s.account_id = a.id) AS stores,
        (SELECT COUNT(*) FROM licence_grant g WHERE g.account_id = a.id AND g.revoked_at IS NULL AND g.expires_at > ?) AS keys
      FROM account a LEFT JOIN account_user o ON o.account_id = a.id AND o.role = 'owner'
      WHERE a.status != 'deleted'
      GROUP BY a.id ORDER BY a.created_at DESC LIMIT 500`, this.now()).map((r) => ({
      id: r.id, name: r.name, phone: r.phone, status: r.status, createdAt: r.created_at,
      owner: r.owner_email ? { email: r.owner_email, name: r.owner_name, verified: r.verified_at !== null } : null,
      users: r.users, stores: r.stores, activeKeys: r.keys,
    }));
  }

  sweep() {
    const now = this.now();
    exec(this.db, 'DELETE FROM account_session WHERE expires_at < ?', now);
    exec(this.db, 'DELETE FROM email_code WHERE expires_at < ? AND window_start < ?', now, now - 3_600_000);
    exec(this.db, 'DELETE FROM sms_code WHERE expires_at < ? AND window_start < ?', now, now - 3_600_000);
    for (const [k, p] of this.pending) if (p.expires <= now) this.pending.delete(k);
    for (const [k, f] of this.loginFails) if (now - f.start > LOGIN_WINDOW_MS) this.loginFails.delete(k);
  }

  // ---------------------------------------------------------------- helpers

  private userByEmail(email: string) { return email ? one<UserRow>(this.db, 'SELECT * FROM account_user WHERE email = ?', email) : undefined; }

  private newSession(userId: string, userAgent?: string) {
    const token = `dpa_${randomBytes(32).toString('base64url')}`, now = this.now(), expiresAt = now + SESSION_MS;
    exec(this.db, 'INSERT INTO account_session (token_hash, user_id, expires_at, created_at, last_used_at, user_agent) VALUES (?,?,?,?,?,?)', hash(token), userId, expiresAt, now, now, (userAgent ?? '').slice(0, 200));
    return { token, expiresAt };
  }

  /** A new code replaces the last one (and its wrong tries). At most 5 sent per hour per person and purpose. */
  /** A new code in `table` (email_code or sms_code); null when the hourly limit is reached and quietWhenLimited. */
  private newCode(table: 'email_code' | 'sms_code', userId: string, purpose: CodePurpose | SmsPurpose, quietWhenLimited: boolean): string | null {
    const now = this.now();
    const row = one<{ sends: number; window_start: number }>(this.db, `SELECT sends, window_start FROM ${table} WHERE user_id = ? AND purpose = ?`, userId, purpose);
    const fresh = !row || now - row.window_start > 3_600_000;
    if (!fresh && row.sends >= SENDS_PER_HOUR) {
      if (quietWhenLimited) return null;
      throw new HubError('TOO_MANY_REQUESTS', 'Too many codes sent. Wait an hour and try again.', 429);
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    exec(this.db, `INSERT INTO ${table} (user_id, purpose, code_hash, expires_at, attempts, sends, window_start) VALUES (?,?,?,?,0,1,?)
      ON CONFLICT(user_id, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
        sends = CASE WHEN ? THEN 1 ELSE ${table}.sends + 1 END, window_start = CASE WHEN ? THEN excluded.window_start ELSE ${table}.window_start END`,
    userId, purpose, codeHash(userId, purpose, code), now + CODE_MS, now, fresh ? 1 : 0, fresh ? 1 : 0);
    return code;
  }

  /** An SMS code to the account's mobile (same limits as email codes). */
  private async sendSmsCode(userId: string, phone: string, purpose: SmsPurpose, quietWhenLimited = false) {
    const code = this.newCode('sms_code', userId, purpose, quietWhenLimited);
    if (code === null) return;
    const text = `${code} is your PosiNext code. It expires in 10 minutes. Do not share it with anyone.`;
    const send = this.o.sms ? this.o.sms() : this.o.sendSms;
    if (!send) {
      this.o.log?.info('SMS code (no SMS provider set up)', { phone: maskPhone(phone), text: this.o.allowLogMailer ? text : text.replace(/\d{6}/, '******') });
      return;
    }
    try {
      await send(phone, text, code);
    } catch (e) {
      this.o.log?.warn('SMS not sent', { phone: maskPhone(phone), error: String(e) });
      throw new HubError('SMS_FAILED', 'We could not send the SMS. Please try again in a minute.', 502);
    }
  }

  private async sendCode(userId: string, email: string, purpose: CodePurpose, quietWhenLimited = false) {
    const code = this.newCode('email_code', userId, purpose, quietWhenLimited);
    if (code === null) return;
    const text = purpose === 'verify'
      ? `Your PosiNext verification code is ${code}.\n\nIt works for 10 minutes. If you did not sign up for PosiNext, ignore this email.`
      : `Your PosiNext password reset code is ${code}.\n\nIt works for 10 minutes. If you did not ask to reset your password, ignore this email: your password stays the same.`;
    try {
      await this.o.mailer.send({ to: email, subject: purpose === 'verify' ? `${code} is your PosiNext code` : 'Reset your PosiNext password', text });
    } catch (e) {
      this.o.log?.warn('email not sent', { email, error: String(e) });
      throw new HubError('EMAIL_FAILED', 'We could not send the email. Please try again in a minute.', 502);
    }
  }

  /** Checks a code; each wrong try counts (kept even though the request fails), and after 5 the code is locked. */
  private useCode(table: 'email_code' | 'sms_code', userId: string, purpose: CodePurpose | SmsPurpose, codeIn: unknown) {
    const code = String(codeIn ?? '').replace(/\D/g, '');
    const row = one<{ code_hash: string; expires_at: number; attempts: number }>(this.db, `SELECT code_hash, expires_at, attempts FROM ${table} WHERE user_id = ? AND purpose = ?`, userId, purpose);
    if (!row || !row.code_hash || row.expires_at < this.now()) throw new HubError('CODE_EXPIRED', 'This code has expired. Ask for a new one.', 400);
    if (row.attempts >= CODE_ATTEMPTS) throw new HubError('CODE_LOCKED', 'Too many wrong codes. Ask for a new code.', 429);
    const got = Buffer.from(codeHash(userId, purpose, code)), want = Buffer.from(row.code_hash);
    if (code.length !== 6 || got.length !== want.length || !timingSafeEqual(got, want)) {
      exec(this.db, `UPDATE ${table} SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ?`, userId, purpose);
      const left = CODE_ATTEMPTS - row.attempts - 1;
      throw new HubError(left > 0 ? 'WRONG_CODE' : 'CODE_LOCKED', left > 0 ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Ask for a new code.', left > 0 ? 400 : 429);
    }
    // used: the code cannot be used again (the send count for the hour stays)
    exec(this.db, `UPDATE ${table} SET code_hash = '', expires_at = 0 WHERE user_id = ? AND purpose = ?`, userId, purpose);
  }
}

const codeHash = (userId: string, purpose: string, code: string) => hash(`email-code:${purpose}:${userId}:${code}`);
/** +91******3210: enough to recognise one's own number, not to learn someone else's. */
export const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, 3)}******${p.slice(-4)}` : '******');

/** P8-06: one or both products, each once, in a fixed order. */
function checkProducts(value: unknown): ProductCode[] {
  const list = Array.isArray(value) ? value : [];
  const chosen = (Object.keys(PRODUCTS) as ProductCode[]).filter((p) => list.includes(p));
  if (chosen.length === 0 || chosen.length !== list.length) { // an unknown or repeated product is refused
    throw new HubError('VALIDATION', 'Choose QSR, Fine Dine or both.', 400, { fields: { products: 'Choose at least one product.' } });
  }
  return chosen;
}
