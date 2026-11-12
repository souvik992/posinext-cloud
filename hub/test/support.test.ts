import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';

// P8-08: support tickets, announcements, the knowledge base and service status for the customer portal.
async function customer(h: TestHub, email: string, phone: string, business = 'Spice Garden') {
  await h.call('POST', '/v1/account/signup', { body: { businessName: business, name: 'Asha Rao', email, phone, password: 'tandoor-2026' } });
  const code = /\b(\d{6})\b/.exec(h.mail.at(-1)!.text)![1];
  const res = await fetch(`${h.base}/v1/account/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
  const cookie = String(res.headers.get('set-cookie')).split(';')[0]!;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(h.base + path, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  return { call };
}

test('support: a ticket opened in the portal is answered from the admin page; the reply shows in the portal and is emailed', async () => {
  const h = await startHub();
  try {
    const a = await customer(h, 'asha@spicegarden.in', '9876543210');
    const opened = await a.call('POST', '/v1/account/tickets', { subject: 'Printer not printing KOTs', product: 'fine_dine', body: 'The kitchen printer stopped after the update.' });
    assert.equal(opened.status, 200, JSON.stringify(opened.json));
    assert.deepEqual([opened.json.number, opened.json.status, opened.json.product, opened.json.messages.length], [1001, 'open', 'fine_dine', 1]);
    // the admin page lists it (waiting for us), answers it
    const list = await h.call('GET', '/v1/admin/tickets', { admin: true });
    assert.deepEqual(list.json.tickets.map((t: any) => [t.number, t.status, t.account.name]), [[1001, 'open', 'Spice Garden']]);
    const mails = h.mail.length;
    const answered = await h.call('POST', `/v1/admin/tickets/${opened.json.id}/reply`, { admin: true, body: { body: 'Please update to build 12 and restart the PC.', name: 'Ravi (support)' } });
    assert.equal(answered.json.status, 'answered');
    assert.equal(h.mail.length, mails + 1);
    assert.deepEqual([h.mail.at(-1)!.to, h.mail.at(-1)!.subject], ['asha@spicegarden.in', 'Re: [Ticket #1001] Printer not printing KOTs']);
    // the portal shows the conversation; the customer replies (open again), then closes it
    const seen = await a.call('GET', `/v1/account/tickets/${opened.json.id}`);
    assert.deepEqual(seen.json.messages.map((m: any) => [m.from, m.name]), [['customer', 'Asha Rao'], ['staff', 'Ravi (support)']]);
    assert.equal((await a.call('POST', `/v1/account/tickets/${opened.json.id}/reply`, { body: 'Thanks, that fixed it.' })).json.status, 'open');
    assert.equal((await a.call('POST', `/v1/account/tickets/${opened.json.id}/close`)).json.status, 'closed');
    assert.deepEqual((await a.call('GET', '/v1/account/tickets')).json.tickets.map((t: any) => [t.number, t.status]), [[1001, 'closed']]);
  } finally { await h.close(); cleanup(h.dir); }
});

test('support: new tickets and customer replies are emailed to the support inbox (HUB_SUPPORT_NOTIFY_TO); "Reply" goes to the customer', async () => {
  const INBOX = 'support@posinext.com';
  const h = await startHub(undefined, undefined, undefined, { supportNotifyTo: INBOX });
  try {
    const a = await customer(h, 'asha@spicegarden.in', '9876543210');
    const t = (await a.call('POST', '/v1/account/tickets', { subject: 'Growth plan', product: 'fine_dine', body: 'I would like the Growth plan.' })).json;
    const m = h.mail.at(-1)!;
    assert.deepEqual([m.to, m.subject, m.replyTo], [INBOX, '[Ticket #1001] Growth plan', 'asha@spicegarden.in']);
    assert.match(m.text, /Spice Garden/);
    assert.match(m.text, /9876543210/);
    assert.match(m.text, /I would like the Growth plan\./);
    await a.call('POST', `/v1/account/tickets/${t.id}/reply`, { body: 'Two outlets, please.' });
    assert.deepEqual([h.mail.at(-1)!.to, h.mail.at(-1)!.subject], [INBOX, 'Re: [Ticket #1001] Growth plan']);
    assert.match(h.mail.at(-1)!.text, /Two outlets, please\./);
  } finally { await h.close(); cleanup(h.dir); }
});

test('support: without HUB_SUPPORT_NOTIFY_TO no inbox email is sent', async () => {
  const h = await startHub();
  try {
    const a = await customer(h, 'asha@spicegarden.in', '9876543210');
    const before = h.mail.length;
    await a.call('POST', '/v1/account/tickets', { subject: 'Help', body: 'Question' });
    assert.equal(h.mail.length, before);
  } finally { await h.close(); cleanup(h.dir); }
});

test('support: tickets are private to their account; checked; admin routes need the admin key', async () => {
  const h = await startHub();
  try {
    const a = await customer(h, 'asha@spicegarden.in', '9876543210');
    const b = await customer(h, 'b@example.com', '9123456780', 'Other Cafe');
    const t = (await a.call('POST', '/v1/account/tickets', { subject: 'Help', body: 'Question' })).json;
    assert.equal(t.product, null);
    assert.equal((await b.call('GET', `/v1/account/tickets/${t.id}`)).status, 404);
    assert.equal((await b.call('POST', `/v1/account/tickets/${t.id}/reply`, { body: 'x' })).status, 404);
    assert.deepEqual((await b.call('GET', '/v1/account/tickets')).json.tickets, []);
    const bad = await a.call('POST', '/v1/account/tickets', { subject: ' ', body: 'x', product: 'pizza' });
    assert.deepEqual([bad.status, bad.json.error.code], [400, 'VALIDATION']);
    assert.equal((await fetch(`${h.base}/v1/account/tickets`)).status, 401);
    assert.equal((await h.call('GET', '/v1/admin/tickets')).status, 403);
    assert.equal((await h.call('POST', `/v1/admin/tickets/${t.id}/reply`, { body: { body: 'x' } })).status, 403);
  } finally { await h.close(); cleanup(h.dir); }
});

test('support: announcements and knowledge-base articles are written on the admin page and read by everyone', async () => {
  const h = await startHub();
  try {
    await h.call('POST', '/v1/admin/announcements', { admin: true, body: { title: 'DinePOS 0.1.7', body: 'Reservations badge and bills search.', product: 'fine_dine' } });
    h.clock.t += 1000;
    await h.call('POST', '/v1/admin/announcements', { admin: true, body: { title: 'Planned maintenance', body: 'Sunday 2 am.' } });
    assert.deepEqual((await h.call('GET', '/v1/announcements')).json.announcements.map((a: any) => a.title), ['Planned maintenance', 'DinePOS 0.1.7']);
    assert.deepEqual((await h.call('GET', '/v1/announcements?product=tiffin_qsr')).json.announcements.map((a: any) => a.title), ['Planned maintenance']);
    const saved = await h.call('POST', '/v1/admin/kb', { admin: true, body: { title: 'Start your free trial', body: 'Open Settings › Licence and sign in.', category: 'Getting started' } });
    assert.equal(saved.json.slug, 'start-your-free-trial');
    await h.call('POST', '/v1/admin/kb', { admin: true, body: { slug: 'start-your-free-trial', title: 'Start your 30-day free trial', body: 'Updated.', category: 'Getting started' } });
    const list = await h.call('GET', '/v1/kb');
    assert.deepEqual(list.json.articles.map((a: any) => [a.slug, a.title, 'body' in a]), [['start-your-free-trial', 'Start your 30-day free trial', false]]);
    assert.equal((await h.call('GET', '/v1/kb/start-your-free-trial')).json.body, 'Updated.');
    assert.equal((await h.call('GET', '/v1/kb/nope')).status, 404);
    assert.equal((await h.call('POST', '/v1/admin/kb', { body: { title: 'x', body: 'y' } })).status, 403);
    assert.equal((await h.call('POST', '/v1/admin/kb/start-your-free-trial/delete', { admin: true })).status, 200);
    assert.deepEqual((await h.call('GET', '/v1/kb')).json.articles, []);
  } finally { await h.close(); cleanup(h.dir); }
});

test('support: service status says what works', async () => {
  const gh = (async () => new Response('[]', { status: 200 })) as typeof fetch;
  const h = await startHub(undefined, undefined, undefined, { githubFetch: gh });
  try {
    const s = await h.call('GET', '/v1/status');
    assert.equal(s.status, 200);
    const by = Object.fromEntries(s.json.components.map((c: any) => [c.name, c.status]));
    assert.deepEqual(by, { 'Client area and sign-in': 'ok', 'Licence activation and renewals': 'ok', Downloads: 'degraded', 'Online orders relay': 'ok' });
    assert.equal(s.json.ok, false, 'no installer published yet');
  } finally { await h.close(); cleanup(h.dir); }
});
