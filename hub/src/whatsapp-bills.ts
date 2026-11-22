import { randomBytes, randomInt } from 'node:crypto';
import { exec, many, one } from './db.ts';
import type { Db } from './db.ts';
import { HubError } from './hub.ts';
import type { DeviceRef } from './hub.ts';
import type { SalesSync } from './sync.ts';
import type { SendSms } from './sms.ts';
import { checkBillDoc, rupees } from './bill-doc.ts';
import type { BillDoc } from './bill-doc.ts';
import { incomingMessages, localMobile, metaSignatureOk, metaWhatsApp, msg91WhatsApp, waNumber } from './whatsapp.ts';
import type { WaProvider, WhatsApp } from './whatsapp.ts';
import { MOBILE_RE, normaliseMobile } from '../../contract/src/validate.ts';

/**
 * WhatsApp in the hub (admin page > Hub settings > WhatsApp), with Meta's Cloud API or MSG91 (src/whatsapp.ts):
 *  - Codes: the hub's SMS codes (order OTP, portal sign-in codes, mobile verification) go on WhatsApp through an
 *    authentication template, "WhatsApp first" (SMS when WhatsApp fails) or "WhatsApp only".
 *  - Bills: a POS sends a bill to a customer's number (POST /v1/pos/bills/:code/whatsapp) through a utility template
 *    with the bill PDF on top. Meta charges per message.
 *  - Bill QR: a POS prints a QR code on the bill (/wa/bill/<code>). It opens WhatsApp with "Send my bill <code>" to the
 *    hub's number; the hub answers with the bill PDF. The customer wrote first, so the answer is free. The POS sends
 *    the bill up inside its bill.printed sync event (payload.share = { code, receipt }), so the QR works even when
 *    the bill was printed offline (it answers "not found yet" until the bill arrives).
 *
 * A bill's code (12 characters, A-Z and 2-9 without I and O) is made by the POS and is the only key to the bill: the
 * page /b/<code>, the PDF and the QR all use it. Bills are kept 180 days. Customers' numbers are never stored whole.
 */

export interface WaSetup {
  provider: WaProvider;
  /** the business's WhatsApp number with country code (919876543210): wa.me links, MSG91's integrated number */
  number: string;
  /** template language code (en, en_US, hi, …) */
  language: string;
  // Meta Cloud API
  phoneNumberId?: string; accessToken?: string; appSecret?: string; verifyToken?: string;
  // MSG91
  authKey?: string; inboundSecret?: string;
  /** codes on WhatsApp: off, WhatsApp first (SMS if it fails), WhatsApp only */
  codes: 'off' | 'first' | 'only';
  /** the authentication template ({{1}} = the code, copy-code button) */
  otpTemplate: string;
  /** the bill template: document header, {{1}} store, {{2}} bill number, {{3}} amount; '' = only the QR flow */
  billTemplate: string;
  /** the bill template has a URL button https://<hub>/b/{{1}} (the bill's code) */
  billButton: boolean;
}

export const BILL_CODE = /^[A-HJ-NP-Z2-9]{12}$/;
const BILL_DAYS = 180;
const TEMPLATE = /^[a-z0-9_]{1,512}$/;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS wa_bill (
  code TEXT PRIMARY KEY, store_id TEXT NOT NULL, bill_id TEXT, doc_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  sent_to TEXT, sent_at INTEGER, sends INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS wa_bill_age ON wa_bill(created_at);
CREATE TABLE IF NOT EXISTS wa_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, store_id TEXT, kind TEXT NOT NULL, to_masked TEXT, ok INTEGER NOT NULL, detail TEXT);
`;
const mask = (n: string) => { const d = localMobile(n); return d.length >= 4 ? `${d.slice(0, 2)}******${d.slice(-2)}` : '****'; };
const ending = (s: string | undefined) => (s ? s.slice(-4) : null);

export interface WhatsAppOptions { fetch?: typeof fetch; log?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void } }

export class WhatsAppHub {
  private db: Db; private now: () => number; private o: WhatsAppOptions;
  private cache: { json: string; wa: WhatsApp } | null = null;
  /** sends per store and replies per customer in the last hour (in memory: limits, not records) */
  private counts = new Map<string, { n: number; start: number }>();
  /** the last webhook call's work (tests wait for it) */
  pending: Promise<void> = Promise.resolve();

  constructor(db: Db, now: () => number, sync: SalesSync, o: WhatsAppOptions = {}) {
    this.db = db; this.now = now; this.o = o;
    db.exec(SCHEMA);
    const before = sync.onStored; // analytics and inventory listen too
    sync.onStored = (storeId, kind, payload, createdAt) => { before?.(storeId, kind, payload, createdAt); this.fromSync(storeId, kind, payload); };
  }

  // ---------------------------------------------------------------- setup (setting "whatsapp")

  setup(): WaSetup | null {
    const r = one<{ value_json: string }>(this.db, "SELECT value_json FROM setting WHERE key = 'whatsapp'");
    return r ? JSON.parse(r.value_json) as WaSetup : null;
  }

  /** The sender for the saved setup, or null. */
  sender(): WhatsApp | null {
    const r = one<{ value_json: string }>(this.db, "SELECT value_json FROM setting WHERE key = 'whatsapp'");
    if (!r) return null;
    if (this.cache?.json !== r.value_json) {
      const c = JSON.parse(r.value_json) as WaSetup;
      this.cache = { json: r.value_json, wa: c.provider === 'meta' ? metaWhatsApp({ phoneNumberId: c.phoneNumberId!, accessToken: c.accessToken!, fetch: this.o.fetch }) : msg91WhatsApp({ authKey: c.authKey!, number: c.number, fetch: this.o.fetch }) };
    }
    return this.cache.wa;
  }

  /** What the admin page shows: never the token, app secret or auth key, only their last 4 characters. */
  view() {
    const c = this.setup();
    if (!c) return { configured: false as const };
    return {
      configured: true as const, provider: c.provider, number: c.number, language: c.language, codes: c.codes, otpTemplate: c.otpTemplate,
      billTemplate: c.billTemplate, billButton: c.billButton,
      phoneNumberId: c.phoneNumberId ?? null, tokenEnding: ending(c.accessToken), appSecretSet: Boolean(c.appSecret), verifyToken: c.verifyToken ?? null,
      authKeyEnding: ending(c.authKey),
      /** where the provider sends incoming messages (the bill QR flow) */
      webhookPath: c.provider === 'meta' ? '/v1/whatsapp/meta' : `/v1/whatsapp/msg91/${c.inboundSecret}`,
      log: many<{ at: number; store: string | null; kind: string; to_masked: string | null; ok: number; detail: string | null }>(this.db,
        'SELECT l.at, s.name AS store, l.kind, l.to_masked, l.ok, l.detail FROM wa_log l LEFT JOIN store s ON s.id = l.store_id ORDER BY l.id DESC LIMIT 50')
        .map((l) => ({ at: l.at, store: l.store, kind: l.kind, to: l.to_masked, ok: l.ok === 1, detail: l.detail })),
    };
  }

  /** Saves the admin page's details. Empty secrets keep the saved ones. */
  save(input: unknown) {
    const b = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
    const before = this.setup();
    const errors: Record<string, string> = {};
    const text = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
    const provider = b.provider === 'meta' || b.provider === 'msg91' ? b.provider : null;
    if (!provider) errors.provider = 'Choose Meta Cloud API or MSG91.';
    const number = waNumber(text('number'));
    if (!/^[1-9]\d{9,14}$/.test(number)) errors.number = 'Enter the WhatsApp business number with country code, e.g. 919876543210.';
    const language = text('language') || 'en';
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) errors.language = 'A template language code such as en, en_US or hi.';
    const keep = (k: 'accessToken' | 'appSecret' | 'authKey') => text(k) || (before?.provider === provider ? before?.[k] : undefined);
    const value: WaSetup = {
      provider: provider ?? 'meta', number, language,
      codes: b.codes === 'first' || b.codes === 'only' ? b.codes : 'off',
      otpTemplate: text('otpTemplate'), billTemplate: text('billTemplate'), billButton: b.billButton === true,
    };
    if (provider === 'meta') {
      value.phoneNumberId = text('phoneNumberId');
      if (!/^\d{5,30}$/.test(value.phoneNumberId)) errors.phoneNumberId = 'The phone number id (digits) from Meta for Developers > WhatsApp > API setup.';
      value.accessToken = keep('accessToken');
      if (!value.accessToken || !/^[A-Za-z0-9_\-.|]{20,1000}$/.test(value.accessToken)) errors.accessToken = 'Paste the permanent access token (a system user token from Meta Business settings).';
      value.appSecret = keep('appSecret');
      if (value.appSecret && !/^[a-f0-9]{16,64}$/i.test(value.appSecret)) errors.appSecret = 'The app secret is letters a-f and digits (Meta for Developers > App settings > Basic).';
      value.verifyToken = before?.provider === 'meta' && before.verifyToken ? before.verifyToken : randomBytes(18).toString('base64url');
    } else if (provider === 'msg91') {
      value.authKey = keep('authKey');
      if (!value.authKey || !/^[A-Za-z0-9]{10,100}$/.test(value.authKey)) errors.authKey = 'The MSG91 auth key is letters and digits only (MSG91 > API > Auth key).';
      value.inboundSecret = before?.provider === 'msg91' && before.inboundSecret ? before.inboundSecret : randomBytes(18).toString('base64url');
    }
    for (const k of ['otpTemplate', 'billTemplate'] as const) if (value[k] && !TEMPLATE.test(value[k])) errors[k] = 'The template name as approved: lowercase letters, digits and _.';
    if (value.codes !== 'off' && !value.otpTemplate) errors.otpTemplate = 'Codes on WhatsApp need the authentication template.';
    if (Object.keys(errors).length) throw new HubError('VALIDATION', Object.values(errors)[0]!, 400, { fields: errors });
    exec(this.db, "INSERT INTO setting (key, value_json, updated_at) VALUES ('whatsapp',?,?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at", JSON.stringify(value), this.now());
    this.o.log?.info('WhatsApp set up from the admin page', { provider: value.provider, codes: value.codes, otpTemplate: value.otpTemplate, billTemplate: value.billTemplate });
    return this.view();
  }

  remove() {
    exec(this.db, "DELETE FROM setting WHERE key = 'whatsapp'");
    this.o.log?.info('WhatsApp removed from the admin page');
    return this.view();
  }

  /** Codes go on WhatsApp (an authentication template is set up and "codes" is not off). */
  codesOn(): boolean {
    const c = this.setup();
    return Boolean(c && c.codes !== 'off' && c.otpTemplate);
  }

  /** What the POS needs to know: can it send bills to a number, and does the bill QR get answered. */
  forPos() {
    const c = this.setup();
    return { bills: Boolean(c?.billTemplate), qr: Boolean(c && (c.provider === 'msg91' || c.appSecret)), number: c?.number ?? null };
  }

  // ---------------------------------------------------------------- codes

  /**
   * The code sender the hub uses: WhatsApp (authentication template) when it is on, with SMS when WhatsApp fails
   * ("first") or never ("only"); else the SMS sender as it is.
   */
  codeSender(sms: SendSms | undefined): SendSms | undefined {
    const c = this.setup(), wa = this.sender();
    if (!c || !wa || c.codes === 'off' || !c.otpTemplate) return sms;
    return async (mobile, text, code) => {
      try {
        await wa.sendTemplate(mobile, { name: c.otpTemplate, language: c.language, body: [code], button: code });
        this.record(null, 'code', mobile, true, null);
      } catch (e) {
        this.record(null, 'code', mobile, false, String((e as Error).message ?? e));
        if (c.codes === 'first' && sms) { this.o.log?.warn('WhatsApp code failed, sent by SMS', String((e as Error).message ?? e)); return sms(mobile, text, code); }
        throw e;
      }
    };
  }

  /** Admin page test: a code (authentication template) or a sample bill (bill template) to a number. */
  async test(input: unknown, base: string) {
    const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const c = this.setup(), wa = this.sender();
    if (!c || !wa) throw new HubError('WHATSAPP_NOT_SET_UP', 'Set up WhatsApp first.', 400);
    const mobile = normaliseMobile(String(b.mobile ?? ''));
    if (!MOBILE_RE.test(mobile)) throw new HubError('VALIDATION', 'Enter a 10-digit mobile number.', 400, { fields: { mobile: 'Enter a 10-digit mobile number.' } });
    const what = b.what === 'bill' ? 'bill' : 'code';
    try {
      if (what === 'code') {
        if (!c.otpTemplate) throw new HubError('VALIDATION', 'Enter the authentication template first.', 400);
        const code = String(randomInt(100000, 1000000));
        await wa.sendTemplate(mobile, { name: c.otpTemplate, language: c.language, body: [code], button: code });
        this.record(null, 'test', mobile, true, 'code');
        return { sent: true, what, code };
      }
      if (!c.billTemplate) throw new HubError('VALIDATION', 'Enter the bill template first.', 400);
      const code = sampleCode();
      this.store(null, code, SAMPLE_BILL(new Date(this.now()).toISOString()), null);
      await this.sendBillTemplate(c, wa, mobile, code, SAMPLE_BILL(new Date(this.now()).toISOString()), base);
      this.record(null, 'test', mobile, true, 'bill');
      return { sent: true, what, code, page: `${base}/b/${code}` };
    } catch (e) {
      if (e instanceof HubError) throw e;
      this.record(null, 'test', mobile, false, String((e as Error).message ?? e));
      throw new HubError('WHATSAPP_FAILED', String((e as Error).message ?? e), 502);
    }
  }

  // ---------------------------------------------------------------- bills

  private store(storeId: string | null, code: string, doc: BillDoc, billId: string | null) {
    const was = one<{ store_id: string }>(this.db, 'SELECT store_id FROM wa_bill WHERE code = ?', code);
    if (was && storeId !== null && was.store_id !== storeId) throw new HubError('BILL_CODE_TAKEN', 'Another store already has a bill with this code.', 409);
    exec(this.db, `INSERT INTO wa_bill (code, store_id, bill_id, doc_json, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET doc_json = excluded.doc_json, bill_id = COALESCE(excluded.bill_id, wa_bill.bill_id)`,
      code, storeId ?? '', billId, JSON.stringify(doc), this.now());
    if (Math.random() < 0.05) exec(this.db, 'DELETE FROM wa_bill WHERE created_at < ?', this.now() - BILL_DAYS * 86_400_000);
  }

  /** A bill by its code (the page, the PDF, the QR answer); NOT_FOUND when unknown or older than 180 days. */
  bill(code: string): { doc: BillDoc; storeId: string } {
    const c = String(code ?? '').toUpperCase();
    const r = BILL_CODE.test(c) ? one<{ doc_json: string; store_id: string; created_at: number }>(this.db, 'SELECT doc_json, store_id, created_at FROM wa_bill WHERE code = ?', c) : undefined;
    if (!r || r.created_at < this.now() - BILL_DAYS * 86_400_000) throw new HubError('NOT_FOUND', 'This bill is not here. Ask the store for it.', 404);
    return { doc: JSON.parse(r.doc_json) as BillDoc, storeId: r.store_id };
  }

  /** PUT /v1/pos/bills/:code: keeps a bill for its page and QR without sending it. */
  putBill(dev: DeviceRef, codeIn: string, input: unknown) {
    const code = checkCode(codeIn);
    const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    this.store(dev.storeId, code, checkBillDoc(b.bill), typeof b.billId === 'string' ? b.billId.slice(0, 80) : null);
    return { code, stored: true };
  }

  /** POST /v1/pos/bills/:code/whatsapp: keeps the bill (when sent along) and sends it to the customer's number. */
  async sendBill(dev: DeviceRef, codeIn: string, input: unknown, base: string) {
    const code = checkCode(codeIn);
    const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const c = this.setup(), wa = this.sender();
    if (!c || !wa || !c.billTemplate) throw new HubError('WHATSAPP_NOT_SET_UP', 'Sending bills on WhatsApp is not set up on PosiNext Cloud yet.', 409);
    const mobile = normaliseMobile(String(b.mobile ?? ''));
    if (!MOBILE_RE.test(mobile)) throw new HubError('VALIDATION', 'Enter the customer\'s 10-digit mobile number.', 400, { fields: { mobile: 'Enter a 10-digit mobile number.' } });
    if (b.bill !== undefined) this.store(dev.storeId, code, checkBillDoc(b.bill), typeof b.billId === 'string' ? b.billId.slice(0, 80) : null);
    const { doc, storeId } = this.bill(code);
    if (storeId !== dev.storeId) throw new HubError('NOT_FOUND', 'This bill is not here. Send it again with the bill.', 404);
    this.limit(`store:${dev.storeId}`, 300, 'This store sent many bills in the last hour. Try again later.');
    try { await this.sendBillTemplate(c, wa, mobile, code, doc, base); }
    catch (e) {
      this.record(dev.storeId, 'bill', mobile, false, String((e as Error).message ?? e));
      throw new HubError('WHATSAPP_FAILED', `WhatsApp did not take the bill: ${String((e as Error).message ?? e)}`, 502);
    }
    exec(this.db, 'UPDATE wa_bill SET sent_to = ?, sent_at = ?, sends = sends + 1 WHERE code = ?', mask(mobile), this.now(), code);
    this.record(dev.storeId, 'bill', mobile, true, doc.billNo);
    return { sent: true, to: mask(mobile), page: `${base}/b/${code}` };
  }

  private sendBillTemplate(c: WaSetup, wa: WhatsApp, mobile: string, code: string, doc: BillDoc, base: string) {
    return wa.sendTemplate(mobile, {
      name: c.billTemplate, language: c.language,
      document: { url: `${base}/b/${code}.pdf`, filename: pdfName(doc) },
      body: [doc.store.name, doc.billNo, rupees(doc.totalPaise)],
      button: c.billButton ? code : undefined,
    });
  }

  /** A bill inside a POS's bill.printed sync event (payload.share = { code, receipt }): kept for its QR. Never throws. */
  private fromSync(storeId: string, kind: string, payload: unknown) {
    if (kind !== 'bill.printed') return;
    const p = (payload && typeof payload === 'object' ? payload : {}) as { billId?: unknown; share?: { code?: unknown; receipt?: unknown } };
    if (!p.share) return;
    try {
      this.store(storeId, checkCode(String(p.share.code ?? '')), checkBillDoc(p.share.receipt), typeof p.billId === 'string' ? p.billId.slice(0, 80) : null);
    } catch (e) {
      this.o.log?.warn('a synced bill could not be kept for WhatsApp', { store: storeId, error: (e as Error).message });
    }
  }

  // ---------------------------------------------------------------- incoming messages (the bill QR)

  /** GET /v1/whatsapp/meta: Meta checks the webhook address once (hub.verify_token must match). */
  metaVerify(q: URLSearchParams): string {
    const c = this.setup();
    if (c?.provider !== 'meta' || !c.verifyToken || q.get('hub.mode') !== 'subscribe' || q.get('hub.verify_token') !== c.verifyToken) throw new HubError('FORBIDDEN', 'Wrong verify token.', 403);
    return q.get('hub.challenge') ?? '';
  }

  /** POST /v1/whatsapp/meta: checks Meta's signature, then answers bill requests (in the background). */
  metaWebhook(raw: Buffer, signature: unknown, base: string) {
    const c = this.setup();
    if (c?.provider !== 'meta' || !c.appSecret) throw new HubError('NOT_SET_UP', 'Incoming WhatsApp messages are not set up (Meta app secret).', 404);
    if (!metaSignatureOk(c.appSecret, raw, signature)) throw new HubError('FORBIDDEN', 'Bad signature.', 403);
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HubError('BAD_JSON', 'Not JSON.', 400); }
    this.pending = this.answer(incomingMessages('meta', body), base);
    return { ok: true };
  }

  /** POST /v1/whatsapp/msg91/:secret: MSG91's incoming messages (the secret in the address is the check). */
  msg91Webhook(secret: string, body: unknown, base: string) {
    const c = this.setup();
    if (c?.provider !== 'msg91' || !c.inboundSecret || secret !== c.inboundSecret) throw new HubError('NOT_FOUND', 'Not found.', 404);
    this.pending = this.answer(incomingMessages('msg91', body), base);
    return { ok: true };
  }

  /** Answers "Send my bill <code>" with the bill; other messages get no answer. Never throws. */
  private async answer(msgs: Array<{ from: string; text: string }>, base: string) {
    const wa = this.sender();
    if (!wa) return;
    for (const m of msgs) {
      const code = /\b([A-HJ-NP-Z2-9]{12})\b/.exec(m.text.toUpperCase())?.[1];
      if (!code) continue;
      try {
        this.limit(`from:${m.from}`, 20, 'too many');
      } catch { continue; } // someone trying codes: no answers for the rest of the hour
      let found: { doc: BillDoc; storeId: string } | null = null;
      try { found = this.bill(code); } catch { /* not here (yet) */ }
      try {
        if (!found) {
          await wa.sendText(m.from, 'We could not find that bill yet. If it was printed just now, please send the same message again in a minute.');
          this.record(null, 'qr', m.from, false, `not found: ${code}`);
          continue;
        }
        const d = found.doc;
        await wa.sendDocument(m.from, { url: `${base}/b/${code}.pdf`, filename: pdfName(d), caption: `Your bill ${d.billNo} from ${d.store.name}: Rs. ${rupees(d.totalPaise)}. Thank you!` });
        exec(this.db, 'UPDATE wa_bill SET sent_to = ?, sent_at = ?, sends = sends + 1 WHERE code = ?', mask(m.from), this.now(), code);
        this.record(found.storeId || null, 'qr', m.from, true, d.billNo);
      } catch (e) {
        this.record(found?.storeId || null, 'qr', m.from, false, String((e as Error).message ?? e));
        this.o.log?.warn('WhatsApp bill answer failed', String((e as Error).message ?? e));
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  private limit(key: string, perHour: number, message: string) {
    const now = this.now(), s = this.counts.get(key);
    if (!s || now - s.start > 3_600_000) { this.counts.set(key, { n: 1, start: now }); return; }
    if (++s.n > perHour) throw new HubError('TOO_MANY_REQUESTS', message, 429);
  }

  private record(storeId: string | null, kind: string, to: string, ok: boolean, detail: string | null) {
    exec(this.db, 'INSERT INTO wa_log (at, store_id, kind, to_masked, ok, detail) VALUES (?,?,?,?,?,?)', this.now(), storeId || null, kind, mask(to), ok ? 1 : 0, detail?.slice(0, 300) ?? null);
    if (Math.random() < 0.02) exec(this.db, 'DELETE FROM wa_log WHERE id <= (SELECT max(id) - 2000 FROM wa_log)');
  }
}

function checkCode(code: string): string {
  const c = String(code ?? '').toUpperCase();
  if (!BILL_CODE.test(c)) throw new HubError('VALIDATION', 'The bill code is 12 characters (A-Z and 2-9, no I or O).', 400);
  return c;
}

const pdfName = (d: BillDoc) => `Bill-${d.billNo.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'bill'}.pdf`;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sampleCode = () => Array.from(randomBytes(12), (b) => CODE_CHARS[b % 32]).join('');
const SAMPLE_BILL = (issuedAt: string): BillDoc => ({
  store: { name: 'PosiNext Sample Cafe', address: 'Sample address', gstin: '29ABCDE1234F1Z5' },
  title: 'Tax invoice', billNo: 'TEST-1', issuedAt, orderLabel: 'Test bill',
  lines: [{ name: 'Masala dosa', qty: '2', amountPaise: 24000 }, { name: 'Filter coffee', qty: '2', amountPaise: 8000 }],
  summary: [{ label: 'Subtotal', amountPaise: 32000 }, { label: 'CGST 2.5%', amountPaise: 800 }, { label: 'SGST 2.5%', amountPaise: 800 }],
  totalPaise: 33600, payments: [{ mode: 'UPI', amountPaise: 33600 }], footer: 'This is a test bill from PosiNext Cloud.',
});
