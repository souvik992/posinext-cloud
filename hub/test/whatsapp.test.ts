import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { Hub } from '../src/hub.ts';
import { createHubServer } from '../src/http.ts';
import { billLines, billPdf, checkBillDoc, rupees } from '../src/bill-doc.ts';
import type { BillDoc } from '../src/bill-doc.ts';
import { incomingMessages } from '../src/whatsapp.ts';
import { cleanup } from './helpers.ts';

// WhatsApp: codes (WhatsApp first, SMS as the fallback), bills sent from the POS, the bill QR (incoming messages).

const BILL: BillDoc = {
  store: { name: 'Tiffin & Co', address: '12 MG Road, Bengaluru', gstin: '29ABCDE1234F1Z5' },
  title: 'Tax invoice', billNo: 'QS/25-26/0042', issuedAt: '2026-11-22T08:35:00.000Z', orderLabel: 'Table 4',
  lines: [{ name: 'Masala dosa', qty: '2', amountPaise: 24000 }, { name: 'Filter coffee', qty: '1', amountPaise: 4000 }],
  summary: [{ label: 'Subtotal', amountPaise: 28000 }, { label: 'CGST 2.5%', amountPaise: 700 }, { label: 'SGST 2.5%', amountPaise: 700 }],
  totalPaise: 29400, payments: [{ mode: 'UPI', amountPaise: 29400 }], footer: 'Thank you, visit again',
};
const CODE = 'ABCDEFGH2345', CODE2 = 'ZYXWVUT98765';

interface Call { url: string; headers: Record<string, string>; body: Record<string, any> }

async function start(answer: (c: Call) => { status: number; body: string } = () => ({ status: 200, body: '{"messages":[{"id":"wamid.1"}]}' })) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-wa-'));
  const calls: Call[] = [];
  const sms: string[] = [];
  const waFetch = (async (url: string, init: RequestInit) => {
    const c = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    calls.push(c);
    const a = answer(c);
    return new Response(a.body, { status: a.status });
  }) as unknown as typeof fetch;
  const clock = { t: Date.parse('2026-11-22T14:00:00+05:30') };
  const hub = new Hub({ dbPath: join(dir, 'hub.db'), now: () => clock.t, waFetch, sendSms: async (m, _t, code) => { sms.push(`${m}:${code}`); } });
  const server = createHubServer(hub, { adminKey: 'k', publicUrl: 'https://cloud.example' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, o: { body?: unknown; raw?: string; key?: string; admin?: boolean; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.body !== undefined || o.raw !== undefined) headers['content-type'] ??= 'application/json';
    if (o.key) headers.authorization = `Bearer ${o.key}`;
    if (o.admin) headers['x-admin-key'] = 'k';
    const r = await fetch(base + path, { method, headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)), redirect: 'manual' });
    const bytes = Buffer.from(await r.arrayBuffer());
    let json: any = null;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { /* not JSON */ }
    return { status: r.status, json, text: bytes.toString('utf8'), bytes, headers: r.headers };
  };
  const st = hub.createStore('tiffin-co', 'Tiffin & Co');
  const key = hub.pair(st.pairingCode, 'Counter 1').deviceKey;
  const close = () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); hub.close(); cleanup(dir); });
  return { hub, calls, sms, call, key, close, clock };
}

const META = { provider: 'meta', number: '91 98450 12345', phoneNumberId: '1234567890', accessToken: 'EAAG' + 'x'.repeat(40), appSecret: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', codes: 'first', otpTemplate: 'login_code', billTemplate: 'bill_pdf', billButton: true };

test('bill document: checked, money as printed, PDF and receipt lines', () => {
  assert.equal(rupees(29400), '294.00');
  assert.equal(rupees(12345678), '1,23,456.78');
  assert.equal(rupees(-2500), '-25.00');
  assert.throws(() => checkBillDoc({ ...BILL, lines: [] }), { code: 'VALIDATION' });
  assert.throws(() => checkBillDoc({ ...BILL, totalPaise: 294.5 }), { code: 'VALIDATION' });
  assert.throws(() => checkBillDoc({ ...BILL, issuedAt: 'yesterday' }), { code: 'VALIDATION' });
  const doc = checkBillDoc({ ...BILL, extra: 'dropped', store: { ...BILL.store, name: '  Tiffin & Co  ' } });
  assert.equal(doc.store.name, 'Tiffin & Co');
  assert.ok(!('extra' in doc));
  const lines = billLines(doc).map((l) => l.text);
  assert.ok(lines.every((l) => l.length <= 42), 'fits 42 columns');
  assert.ok(lines.some((l) => /^TOTAL\s+Rs\. 294\.00$/.test(l)));
  assert.ok(lines.some((l) => /22-11-2026 14:05$/.test(l)), 'the time in India');
  const pdf = billPdf(doc).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF'));
  // the xref offsets point at the objects
  const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
  assert.ok(pdf.slice(xref).startsWith('xref'));
  const first = Number(/\n(\d{10}) 00000 n/.exec(pdf)![1]);
  assert.ok(pdf.slice(first).startsWith('1 0 obj'));
  assert.match(pdf, /\(Masala dosa x 2 +240\.00\) Tj/);
});

test('WhatsApp setup: validated, secrets never shown, codes go on WhatsApp first and SMS when it fails', async () => {
  let fail = false;
  const h = await start(() => (fail ? { status: 400, body: '{"error":{"message":"(#131026) Message undeliverable"}}' } : { status: 200, body: '{"messages":[{"id":"x"}]}' }));
  try {
    const bad = await h.call('PUT', '/v1/admin/whatsapp', { admin: true, body: { provider: 'meta', number: '12', codes: 'first' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.details.fields.number && bad.json.error.details.fields.phoneNumberId && bad.json.error.details.fields.accessToken && bad.json.error.details.fields.otpTemplate);
    assert.equal((await h.call('PUT', '/v1/admin/whatsapp', { body: META })).status, 403, 'admin only');
    const saved = await h.call('PUT', '/v1/admin/whatsapp', { admin: true, body: META });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.number, '919845012345');
    assert.equal(saved.json.tokenEnding, 'xxxx');
    assert.equal(saved.json.webhookPath, '/v1/whatsapp/meta');
    assert.ok(saved.json.verifyToken.length > 10);
    assert.ok(!JSON.stringify(saved.json).includes(META.accessToken) && !JSON.stringify(saved.json).includes(META.appSecret));
    // an empty token keeps the saved one
    await h.call('PUT', '/v1/admin/whatsapp', { admin: true, body: { ...META, accessToken: '', appSecret: '' } });
    assert.equal(h.hub.whatsapp.setup()!.accessToken, META.accessToken);
    assert.equal(h.hub.whatsapp.setup()!.verifyToken, saved.json.verifyToken, 'the verify token stays');

    // order OTP: the authentication template with the code (body and copy-code button)
    await h.hub.otpSend('9876543210', { channel: 'website' });
    const c = h.calls.at(-1)!;
    assert.equal(c.url, 'https://graph.facebook.com/v21.0/1234567890/messages');
    assert.equal(c.headers.authorization, `Bearer ${META.accessToken}`);
    assert.equal(c.body.to, '919876543210');
    assert.equal(c.body.template.name, 'login_code');
    const code = c.body.template.components[0].parameters[0].text;
    assert.match(code, /^\d{6}$/);
    assert.deepEqual(c.body.template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
    assert.equal(h.sms.length, 0);

    // WhatsApp refuses: the code goes by SMS ("first")
    fail = true;
    await h.hub.otpSend('9876543211', { channel: 'website' });
    assert.equal(h.sms.length, 1);
    assert.match(h.sms[0]!, /^9876543211:\d{6}$/);
    // "only": no SMS, the error comes back
    await h.call('PUT', '/v1/admin/whatsapp', { admin: true, body: { ...META, accessToken: '', appSecret: '', codes: 'only' } });
    await assert.rejects(h.hub.otpSend('9876543212', { channel: 'website' }), /undeliverable/);
    assert.equal(h.sms.length, 1);
    fail = false;

    const view = await h.call('GET', '/v1/admin/whatsapp', { admin: true });
    assert.ok(view.json.log.some((l: { kind: string; ok: boolean; to: string }) => l.kind === 'code' && !l.ok && l.to === '98******11'));
    assert.ok(!JSON.stringify(view.json.log).includes('9876543211'), 'numbers are masked');
    // off: SMS as before
    await h.call('PUT', '/v1/admin/whatsapp', { admin: true, body: { ...META, accessToken: '', appSecret: '', codes: 'off' } });
    await h.hub.otpSend('9876543213', { channel: 'website' });
    assert.equal(h.sms.length, 2);
    assert.equal((await h.call('DELETE', '/v1/admin/whatsapp', { admin: true })).json.configured, false);
  } finally { await h.close(); }
});

test('bills: the POS sends a bill to a number; the page and PDF; refused when not set up', async () => {
  const h = await start();
  try {
    const notSet = await h.call('POST', `/v1/pos/bills/${CODE}/whatsapp`, { key: h.key, body: { mobile: '9876543210', bill: BILL } });
    assert.equal(notSet.status, 409);
    assert.equal(notSet.json.error.code, 'WHATSAPP_NOT_SET_UP');
    assert.deepEqual((await h.call('GET', '/v1/pos/whatsapp', { key: h.key })).json, { bills: false, qr: false, number: null });
    await h.call('PUT', '/v1/admin/whatsapp', { admin: true, body: META });
    assert.deepEqual((await h.call('GET', '/v1/pos/whatsapp', { key: h.key })).json, { bills: true, qr: true, number: '919845012345' });
    assert.equal((await h.call('GET', '/v1/pos/whatsapp')).status, 401);

    assert.equal((await h.call('POST', '/v1/pos/bills/abc/whatsapp', { key: h.key, body: { mobile: '9876543210', bill: BILL } })).status, 400);
    assert.equal((await h.call('POST', `/v1/pos/bills/${CODE}/whatsapp`, { key: h.key, body: { mobile: '12345', bill: BILL } })).status, 400);
    const sent = await h.call('POST', `/v1/pos/bills/${CODE.toLowerCase()}/whatsapp`, { key: h.key, body: { mobile: '+91 98765 43210', bill: BILL, billId: 'inv-1' } });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.deepEqual(sent.json, { sent: true, to: '98******10', page: `https://cloud.example/b/${CODE}` });
    const t = h.calls.at(-1)!.body;
    assert.equal(t.to, '919876543210');
    assert.equal(t.template.name, 'bill_pdf');
    assert.deepEqual(t.template.components[0], { type: 'header', parameters: [{ type: 'document', document: { link: `https://cloud.example/b/${CODE}.pdf`, filename: 'Bill-QS-25-26-0042.pdf' } }] });
    assert.deepEqual(t.template.components[1].parameters.map((p: { text: string }) => p.text), ['Tiffin & Co', 'QS/25-26/0042', '294.00']);
    assert.equal(t.template.components[2].parameters[0].text, CODE);
    // sent again without the bill: the kept one
    assert.equal((await h.call('POST', `/v1/pos/bills/${CODE}/whatsapp`, { key: h.key, body: { mobile: '9876543210' } })).status, 200);
    assert.equal((await h.call('POST', `/v1/pos/bills/${CODE2}/whatsapp`, { key: h.key, body: { mobile: '9876543210' } })).status, 404, 'unknown bill');
    // another store cannot use the code
    const other = h.hub.pair(h.hub.createStore('other-store', 'Other').pairingCode, 'POS').deviceKey;
    assert.equal((await h.call('POST', `/v1/pos/bills/${CODE}/whatsapp`, { key: other, body: { mobile: '9876543210', bill: BILL } })).status, 409);
    assert.equal((await h.call('POST', `/v1/pos/bills/${CODE}/whatsapp`, { key: other, body: { mobile: '9876543210' } })).status, 404);

    const page = await h.call('GET', `/b/${CODE}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Tiffin &#38; Co/);
    assert.match(page.text, /QS\/25-26\/0042/);
    assert.match(page.text, /₹294\.00/);
    assert.match(page.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    const pdf = await h.call('GET', `/b/${CODE}.pdf`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok(pdf.bytes.subarray(0, 8).toString() === '%PDF-1.4');
    assert.equal((await h.call('GET', `/b/${CODE2}`)).status, 404);
    // older than 180 days: gone
    h.clock.t += 181 * 86_400_000;
    assert.equal((await h.call('GET', `/b/${CODE}`)).status, 404);
  } finally { await h.close(); }
});

test('bill QR: kept from the sales sync, the QR opens WhatsApp, the answer is the PDF; Meta signs, MSG91 has a secret address', async () => {
  const h = await start();
  try {
    // without WhatsApp, the QR shows the bill page
    assert.equal((await h.call('GET', `/wa/bill/${CODE}`)).headers.get('location'), `/b/${CODE}`);
    await h.call('PUT', '/v1/admin/whatsapp', { admin: true, body: META });
    assert.equal((await h.call('GET', `/wa/bill/${CODE}`)).headers.get('location'), `https://wa.me/919845012345?text=Send%20my%20bill%20${CODE}`);

    // the POS's bill.printed sync event carries the bill and its code
    const batch = { streamId: 'a'.repeat(32), fromSeq: 1, events: [
      { seq: 1, kind: 'bill.printed', createdAt: BILL.issuedAt, payload: { billId: 'inv-1', billNo: BILL.billNo, totalPaise: BILL.totalPaise, businessDate: '2026-11-22', share: { code: CODE, receipt: BILL } } },
      { seq: 2, kind: 'bill.printed', createdAt: BILL.issuedAt, payload: { billId: 'inv-2', billNo: 'X', totalPaise: 1, businessDate: '2026-11-22', share: { code: 'bad', receipt: BILL } } },
    ] };
    const synced = await h.call('POST', '/v1/pos/sync/batches', { key: h.key, body: batch });
    assert.equal(synced.status, 200, JSON.stringify(synced.json));
    assert.equal(h.hub.whatsapp.bill(CODE).doc.billNo, BILL.billNo);

    // Meta checks the address once
    const v = h.hub.whatsapp.setup()!.verifyToken!;
    const ok = await h.call('GET', `/v1/whatsapp/meta?hub.mode=subscribe&hub.verify_token=${v}&hub.challenge=12345`);
    assert.equal(ok.text, '12345');
    assert.equal((await h.call('GET', '/v1/whatsapp/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);

    const incoming = (text: string, from = '919876543210') => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ from, id: 'wamid.in', type: 'text', text: { body: text } }] } }] }] });
    const sign = (raw: string) => `sha256=${createHmac('sha256', META.appSecret).update(raw).digest('hex')}`;
    const raw = incoming(`Send my bill ${CODE.toLowerCase()}`);
    assert.equal((await h.call('POST', '/v1/whatsapp/meta', { raw, headers: { 'x-hub-signature-256': 'sha256=00' } })).status, 403, 'bad signature');
    const before = h.calls.length;
    assert.equal((await h.call('POST', '/v1/whatsapp/meta', { raw, headers: { 'x-hub-signature-256': sign(raw) } })).status, 200);
    await h.hub.whatsapp.pending;
    assert.equal(h.calls.length, before + 1);
    const doc = h.calls.at(-1)!.body;
    assert.equal(doc.type, 'document');
    assert.equal(doc.to, '919876543210');
    assert.equal(doc.document.link, `https://cloud.example/b/${CODE}.pdf`);
    assert.match(doc.document.caption, /QS\/25-26\/0042 from Tiffin & Co: Rs\. 294\.00/);

    // not here yet: a short answer; no code: no answer
    let raw2 = incoming(`Send my bill ${CODE2}`);
    await h.call('POST', '/v1/whatsapp/meta', { raw: raw2, headers: { 'x-hub-signature-256': sign(raw2) } });
    await h.hub.whatsapp.pending;
    assert.equal(h.calls.at(-1)!.body.type, 'text');
    assert.match(h.calls.at(-1)!.body.text.body, /could not find that bill yet/);
    const n = h.calls.length;
    raw2 = incoming('hello');
    await h.call('POST', '/v1/whatsapp/meta', { raw: raw2, headers: { 'x-hub-signature-256': sign(raw2) } });
    await h.hub.whatsapp.pending;
    assert.equal(h.calls.length, n);

    // MSG91: template components and a secret webhook address
    const saved = await h.call('PUT', '/v1/admin/whatsapp', { admin: true, body: { provider: 'msg91', number: '919845012345', authKey: 'abcDEF1234567890', codes: 'off', billTemplate: 'bill_pdf' } });
    assert.match(saved.json.webhookPath, /^\/v1\/whatsapp\/msg91\/[\w-]{20,}$/);
    await h.call('POST', `/v1/pos/bills/${CODE}/whatsapp`, { key: h.key, body: { mobile: '9876543210' } });
    const m = h.calls.at(-1)!;
    assert.equal(m.url, 'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/');
    assert.equal(m.headers.authkey, 'abcDEF1234567890');
    assert.equal(m.body.integrated_number, '919845012345');
    const tc = m.body.payload.template.to_and_components[0];
    assert.deepEqual(tc.to, ['919876543210']);
    assert.deepEqual(tc.components.header_1, { type: 'document', value: `https://cloud.example/b/${CODE}.pdf`, filename: 'Bill-QS-25-26-0042.pdf' });
    assert.deepEqual(tc.components.body_3, { type: 'text', value: '294.00' });
    assert.equal(tc.components.button_1, undefined, 'no button unless set up');
    assert.equal((await h.call('POST', '/v1/whatsapp/msg91/wrong', { body: { customerNumber: '919876543210', text: `Send my bill ${CODE}` } })).status, 404);
    assert.equal((await h.call('POST', saved.json.webhookPath, { body: { customerNumber: '919876543210', text: `Send my bill ${CODE}`, direction: 'inbound' } })).status, 200);
    await h.hub.whatsapp.pending;
    const reply = h.calls.at(-1)!;
    assert.equal(reply.url, 'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/');
    assert.equal(reply.body.recipient_number, '919876543210');
    assert.match(reply.body.text, new RegExp(`https://cloud.example/b/${CODE}\\.pdf`));
    // a form post works too
    assert.equal((await h.call('POST', saved.json.webhookPath, { raw: `customerNumber=919876543210&text=Send+my+bill+${CODE}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 200);
    await h.hub.whatsapp.pending;
    assert.equal(h.calls.at(-1)!.body.recipient_number, '919876543210');
  } finally { await h.close(); }
});

test('incoming messages: Meta statuses and MSG91 outbound echoes are left out', () => {
  assert.deepEqual(incomingMessages('meta', { entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'read' }] } }] }] }), []);
  assert.deepEqual(incomingMessages('meta', { entry: [{ changes: [{ value: { messages: [{ from: '91999', type: 'button', button: { text: 'Send my bill' } }] } }] }] }), [{ from: '91999', text: 'Send my bill' }]);
  assert.deepEqual(incomingMessages('msg91', { customerNumber: '91999', content: '{"text":"hi"}' }), [{ from: '91999', text: 'hi' }]);
  assert.deepEqual(incomingMessages('msg91', { customerNumber: '91999', text: 'hi', direction: 'outbound' }), []);
  assert.deepEqual(incomingMessages('msg91', [{ sender: '91999', message: 'a' }, { from: '91888', body: 'b' }]), [{ from: '91999', text: 'a' }, { from: '91888', text: 'b' }]);
});
