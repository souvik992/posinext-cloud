import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * WhatsApp messages through the WhatsApp Business Platform, by one of two providers (set up on the admin page,
 * src/whatsapp-bills.ts keeps the details):
 *   meta   Meta's Cloud API (graph.facebook.com): a phone number id and a permanent access token. Incoming messages
 *          arrive at /v1/whatsapp/meta, signed with the app secret (X-Hub-Signature-256).
 *   msg91  MSG91's WhatsApp API (control.msg91.com) with the account's auth key and its WhatsApp number. Incoming
 *          messages arrive at /v1/whatsapp/msg91/<secret> (MSG91 does not sign them: the secret in the address is the check).
 *
 * Messages a business starts must use a template Meta approved (codes: an "authentication" template with a copy-code
 * button; bills: a "utility" template with a document header). Within 24 hours of the customer's own message, free
 * text and documents may be sent without one, and Meta does not charge for them: the bill QR flow uses that.
 *
 * MSG91 notes: its documentation shows the template call (body_1…, header_1) and text session messages; a document
 * header's file name, the button_1 component and the incoming-message format are not in it, so they follow what MSG91's
 * panel shows and are read loosely. A bill sent by MSG91 inside the 24 hours goes as a text with the bill's link.
 */

export type WaProvider = 'meta' | 'msg91';

export interface WaTemplate {
  name: string;
  language: string;
  /** a document at the top (the bill PDF) */
  document?: { url: string; filename: string };
  /** {{1}}, {{2}}, … of the template body, in order */
  body: string[];
  /** the first button's variable: an authentication template's copy-code button (the code), or a URL button's suffix */
  button?: string;
}

export interface WhatsApp {
  provider: WaProvider;
  sendTemplate(to: string, t: WaTemplate): Promise<void>;
  /** Free text: only inside the 24 hours after the customer's own message. */
  sendText(to: string, text: string): Promise<void>;
  /** A document with a caption: only inside the 24 hours. MSG91: the caption and the link as text. */
  sendDocument(to: string, doc: { url: string; filename: string; caption: string }): Promise<void>;
}

/** WhatsApp wants the country code without '+': 10-digit Indian numbers get 91 in front. */
export function waNumber(mobile: string): string {
  const d = mobile.replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d.replace(/^0+/, '');
}

/** The last 10 digits of an Indian WhatsApp number (919876543210 → 9876543210); other numbers as they are. */
export function localMobile(wa: string): string {
  const d = wa.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d;
}

async function answer(r: Response, who: string): Promise<unknown> {
  const text = await r.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const b = (body ?? {}) as { error?: { message?: string; error_data?: { details?: string } }; hasError?: boolean; status?: string; errors?: unknown; message?: string };
  if (!r.ok || b.error || b.hasError === true || b.status === 'fail' || b.status === 'error') {
    const why = b.error?.error_data?.details ?? b.error?.message ?? (typeof b.errors === 'string' ? b.errors : b.errors ? JSON.stringify(b.errors) : b.message) ?? text;
    throw new Error(`${who} refused the WhatsApp message (${r.status}): ${String(why).slice(0, 300)}`);
  }
  return body;
}

export interface MetaOptions { phoneNumberId: string; accessToken: string; fetch?: typeof fetch; graph?: string }

export function metaWhatsApp(o: MetaOptions): WhatsApp {
  const f = o.fetch ?? fetch;
  const send = async (payload: Record<string, unknown>) => {
    const r = await f(`${o.graph ?? 'https://graph.facebook.com/v21.0'}/${encodeURIComponent(o.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
      signal: AbortSignal.timeout(15_000),
    });
    await answer(r, 'WhatsApp (Meta)');
  };
  return {
    provider: 'meta',
    sendTemplate: (to, t) => send({ to: waNumber(to), type: 'template', template: { name: t.name, language: { code: t.language }, components: [
      ...(t.document ? [{ type: 'header', parameters: [{ type: 'document', document: { link: t.document.url, filename: t.document.filename } }] }] : []),
      ...(t.body.length ? [{ type: 'body', parameters: t.body.map((text) => ({ type: 'text', text })) }] : []),
      ...(t.button !== undefined ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: t.button }] }] : []),
    ] } }),
    sendText: (to, text) => send({ to: waNumber(to), type: 'text', text: { body: text, preview_url: true } }),
    sendDocument: (to, d) => send({ to: waNumber(to), type: 'document', document: { link: d.url, filename: d.filename, caption: d.caption } }),
  };
}

export interface Msg91WaOptions { authKey: string; /** the business's WhatsApp number in MSG91 (integrated number) */ number: string; fetch?: typeof fetch; base?: string }

export function msg91WhatsApp(o: Msg91WaOptions): WhatsApp {
  const f = o.fetch ?? fetch;
  const base = o.base ?? 'https://control.msg91.com/api/v5/whatsapp';
  const post = async (path: string, body: unknown) => {
    const r = await f(`${base}/${path}`, {
      method: 'POST',
      headers: { authkey: o.authKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    await answer(r, 'MSG91');
  };
  const text = (to: string, t: string) => post('whatsapp-outbound-message/', { integrated_number: waNumber(o.number), recipient_number: waNumber(to), content_type: 'text', text: t });
  return {
    provider: 'msg91',
    sendTemplate: (to, t) => {
      const components: Record<string, unknown> = {};
      if (t.document) components.header_1 = { type: 'document', value: t.document.url, filename: t.document.filename };
      t.body.forEach((v, i) => { components[`body_${i + 1}`] = { type: 'text', value: v }; });
      if (t.button !== undefined) components.button_1 = { subtype: 'url', type: 'text', value: t.button };
      return post('whatsapp-outbound-message/bulk/', {
        integrated_number: waNumber(o.number), content_type: 'template',
        payload: { messaging_product: 'whatsapp', type: 'template', template: { name: t.name, language: { code: t.language, policy: 'deterministic' }, namespace: null, to_and_components: [{ to: [waNumber(to)], components }] } },
      });
    },
    sendText: text,
    sendDocument: (to, d) => text(to, `${d.caption}\n${d.url}`),
  };
}

/** Meta's X-Hub-Signature-256: sha256=<HMAC of the raw body with the app secret>. */
export function metaSignatureOk(appSecret: string, raw: Buffer, header: unknown): boolean {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', appSecret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7).toLowerCase());
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface Incoming { from: string; text: string }

const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const s = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** The customers' text messages in a webhook call (statuses and other notices are left out). */
export function incomingMessages(provider: WaProvider, body: unknown): Incoming[] {
  const out: Incoming[] = [];
  if (provider === 'meta') {
    for (const e of Array.isArray(o(body).entry) ? o(body).entry as unknown[] : []) {
      for (const c of Array.isArray(o(e).changes) ? o(e).changes as unknown[] : []) {
        for (const m of Array.isArray(o(o(c).value).messages) ? o(o(c).value).messages as unknown[] : []) {
          const msg = o(m);
          const text = s(o(msg.text).body) || s(o(msg.button).text) || s(o(o(msg.interactive).button_reply).title);
          if (s(msg.from) && text) out.push({ from: s(msg.from), text });
        }
      }
    }
    return out;
  }
  // MSG91: one message or a list; the names differ between its panels, so the usual ones are tried
  for (const m of Array.isArray(body) ? body : Array.isArray(o(body).data) ? o(body).data as unknown[] : [body]) {
    const msg = o(m);
    if (s(msg.direction) && !/^(in|inbound|incoming|0)$/i.test(s(msg.direction))) continue;
    const from = s(msg.customerNumber) || s(msg.customer_number) || s(msg.sender) || s(msg.from) || s(msg.mobile) || s(msg.recipient_number);
    let text = s(msg.text) || s(msg.body) || s(msg.message);
    if (!text && msg.content !== undefined) {
      const c = typeof msg.content === 'string' ? (() => { try { return JSON.parse(msg.content as string) as unknown; } catch { return msg.content; } })() : msg.content;
      text = typeof c === 'string' ? c : s(o(c).text) || s(o(o(c).text).body) || s(o(c).body);
    }
    if (from && text) out.push({ from, text });
  }
  return out;
}
