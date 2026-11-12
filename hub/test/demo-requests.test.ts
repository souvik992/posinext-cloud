import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, startHub } from './helpers.ts';

// posinext.com "Book a Demo": the static website posts here; the request is saved and emailed to the address set on
// the server (HUB_DEMO_REQUEST_TO), which is never part of any response.
const SALES = 'sales-inbox@example.com';
const form = { name: 'Asha Rao', phone: '+91 98765 43210', email: 'asha@spicegarden.in', restaurant: 'Spice Garden', city: 'Kolkata', outlets: '2-5', message: 'Fine dine with Table QR', source: 'Book a Demo' };

test('demo requests: saved, emailed to the sales address only, which no response shows', async () => {
  const h = await startHub(undefined, undefined, undefined, { demoRequestTo: SALES });
  try {
    const r = await fetch(`${h.base}/v1/demo-requests`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://posinext.com' }, body: JSON.stringify(form) });
    const text = await r.text();
    assert.equal(r.status, 200, text);
    assert.deepEqual(JSON.parse(text), { ok: true });
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.ok(!text.includes(SALES));
    const mail = h.mail.at(-1)!;
    assert.deepEqual([mail.to, mail.subject, mail.replyTo], [SALES, 'Demo request: Spice Garden (Asha Rao)', form.email]);
    for (const v of [form.name, form.phone, form.email, form.restaurant, form.city, form.outlets, form.message]) assert.ok(mail.text.includes(v), v);
    const list = await h.call('GET', '/v1/admin/demo-requests', { admin: true });
    assert.deepEqual(list.json.requests.map((x: any) => [x.restaurant, x.phone, x.mailed]), [['Spice Garden', '+91 98765 43210', true]]);
    assert.ok(!JSON.stringify(list.json).includes(SALES));
  } finally { await h.close(); cleanup(h.dir); }
});

test('demo requests: checked; bots (hidden field) dropped; preflight allowed; the list needs the admin key', async () => {
  const h = await startHub(undefined, undefined, undefined, { demoRequestTo: SALES });
  try {
    const bad = await h.call('POST', '/v1/demo-requests', { body: { ...form, phone: 'call me' } });
    assert.deepEqual([bad.status, bad.json.error.code, Object.keys(bad.json.error.details.fields)], [400, 'VALIDATION', ['phone']]);
    assert.equal((await h.call('POST', '/v1/demo-requests', { body: { ...form, restaurant: ' ' } })).status, 400);
    assert.equal((await h.call('POST', '/v1/demo-requests', { body: { ...form, email: 'nope' } })).status, 400);
    const bot = await h.call('POST', '/v1/demo-requests', { body: { ...form, website: 'http://spam.example' } });
    assert.deepEqual([bot.status, bot.json], [200, { ok: true }]);
    assert.equal(h.mail.length, 0);
    const pre = await fetch(`${h.base}/v1/demo-requests`, { method: 'OPTIONS', headers: { origin: 'https://posinext.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.ok(pre.status < 300, String(pre.status));
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.equal((await h.call('GET', '/v1/admin/demo-requests')).status, 403);
    assert.deepEqual((await h.call('GET', '/v1/admin/demo-requests', { admin: true })).json.requests, []);
  } finally { await h.close(); cleanup(h.dir); }
});

test('demo requests: kept when no sales address is set or the email fails', async () => {
  const h = await startHub();
  try {
    assert.equal((await h.call('POST', '/v1/demo-requests', { body: form })).status, 200);
    assert.equal(h.mail.length, 0);
    assert.deepEqual((await h.call('GET', '/v1/admin/demo-requests', { admin: true })).json.requests.map((x: any) => x.mailed), [false]);
  } finally { await h.close(); cleanup(h.dir); }
  const warned: string[] = [];
  const h2 = await startHub(undefined, undefined, undefined, { demoRequestTo: SALES, log: { warn: (m) => warned.push(m) } });
  try {
    h2.hub.mailer.send = async () => { throw new Error('Brevo down'); };
    assert.equal((await h2.call('POST', '/v1/demo-requests', { body: form })).status, 200);
    assert.deepEqual((await h2.call('GET', '/v1/admin/demo-requests', { admin: true })).json.requests.map((x: any) => x.mailed), [false]);
    assert.match(warned[0]!, /Brevo down/);
  } finally { await h2.close(); cleanup(h2.dir); }
});
