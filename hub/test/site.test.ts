import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cleanup, menu, startHub } from './helpers.ts';
import type { TestHub } from './helpers.ts';
import { checkSite, DEFAULT_SITE, newSection, readSite } from '../src/site.ts';

const tok = (t: string) => ({ headers: { 'x-site-token': t } });
async function twoStores(h: TestHub) {
  await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'demo-burger', name: 'Demo Burger Hub' } });
  await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'other-shop', name: 'Other Shop' } });
}
const design = (o: Record<string, unknown> = {}) => ({ ...structuredClone(DEFAULT_SITE), ...o });

test('site: a design is checked field by field; it needs exactly one menu section; older or broken ones fall back', () => {
  assert.equal(checkSite(design()).ok, true);
  const bad = checkSite(design({
    theme: { ...DEFAULT_SITE.theme, primary: 'orange', font: 'Comic Sans' },
    contact: { ...DEFAULT_SITE.contact, instagram: 'http://insecure.example.com', colour: 1 },
    sections: [{ ...newSection('hero', 'a'), image: 'javascript:alert(1)' }, { id: 'b', type: 'popup' }],
  }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(Object.keys(bad.errors).sort(), ['contact.colour', 'contact.instagram', 'sections.0.image', 'sections.1.type', 'theme.font', 'theme.primary']);
  const noMenu = checkSite(design({ sections: [newSection('hero', 'hero')] }));
  assert.equal(noMenu.ok, false);
  const twoIds = checkSite(design({ sections: [newSection('menu', 'x'), newSection('about', 'x')] }));
  assert.equal(twoIds.ok, false);
  // every section type starts valid, and missing fields get their blank value
  const all = checkSite(design({ sections: ['hero', 'featured', 'menu', 'about', 'gallery', 'reviews', 'hours', 'contact', 'faq', 'text'].map((t, i) => newSection(t, `s${i}`)) }));
  assert.equal(all.ok, true);
  const partial = checkSite({ v: 1, sections: [{ id: 'm', type: 'menu' }] });
  assert.equal(partial.ok && partial.value.sections[0]!.title, '');
  // text is tidied: spaces collapsed, multi-line text keeps its paragraphs
  const tidy = checkSite(design({ sections: [{ ...newSection('about', 'a'), title: '  Our   story ', text: 'Line one\r\n\r\n\r\n\r\nLine   two' }, newSection('menu', 'm')] }));
  assert.ok(tidy.ok);
  if (tidy.ok) assert.deepEqual([tidy.value.sections[0]!.title, tidy.value.sections[0]!.text], ['Our story', 'Line one\n\nLine two']);
  assert.deepEqual(readSite('not json'), DEFAULT_SITE);
  // the first, flat website settings become a design
  const flat = readSite(JSON.stringify({ heroTitle: 'Hot biryani', phone: '+91 98765 43210', announcement: 'Closed on Diwali', brandColor: '#c2410c' }));
  assert.deepEqual([flat.sections[0]!.title, flat.contact.phone, flat.bar.show, flat.bar.text, flat.theme.primary], ['Hot biryani', '+91 98765 43210', true, 'Closed on Diwali', '#c2410c']);
});

test('site: the editor password signs in to one store only; drafts are saved, published to customers, or thrown away', async () => {
  let h = await startHub();
  try {
    await twoStores(h);
    // no password yet: nobody can sign in
    assert.equal((await h.call('POST', '/v1/site/demo-burger/login', { body: { password: 'ABCD-EFGH-JKLM' } })).status, 401);
    assert.equal((await h.call('POST', '/v1/admin/stores/demo-burger/site-password', { body: {} })).status, 403);
    const { password } = (await h.call('POST', '/v1/admin/stores/demo-burger/site-password', { admin: true, body: {} })).json;
    assert.match(password, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal((await h.call('GET', '/v1/admin/stores/demo-burger', { admin: true })).json.website.editorPassword, true);
    assert.equal((await h.call('POST', '/v1/site/demo-burger/login', { body: { password: 'WRONG-PASS-WORD' } })).status, 401);
    assert.equal((await h.call('POST', '/v1/site/other-shop/login', { body: { password } })).status, 401); // another store's password
    const login = await h.call('POST', '/v1/site/demo-burger/login', { body: { password: password.toLowerCase().replace(/-/g, ' ') } }); // typed loosely
    assert.equal(login.status, 200);
    const t = login.json.token as string;
    assert.equal((await h.call('GET', '/v1/site/demo-burger')).status, 401);
    assert.equal((await h.call('GET', '/v1/site/other-shop', tok(t))).status, 401); // a token works for its own store only

    const first = (await h.call('GET', '/v1/site/demo-burger', tok(t))).json;
    assert.deepEqual([first.store.name, first.unpublished, first.publishedAt], ['Demo Burger Hub', false, null]);
    assert.deepEqual(first.draft, DEFAULT_SITE);

    const mine = design({ theme: { ...DEFAULT_SITE.theme, primary: '#c2410c', font: 'Poppins' }, bar: { show: true, text: 'Free delivery above ₹499', link: '' },
      sections: [newSection('hero', 'hero'), { ...newSection('about', 'about'), text: 'Since 1998.' }, newSection('menu', 'menu')] });
    const bad = await h.call('PUT', '/v1/site/demo-burger/draft', { ...tok(t), body: { site: design({ sections: [] }) } });
    assert.equal(bad.status, 400);
    const saved = await h.call('PUT', '/v1/site/demo-burger/draft', { ...tok(t), body: { site: mine } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.unpublished, true);
    // customers still see the published design (the default) until Publish
    assert.deepEqual((await h.call('GET', '/v1/stores/demo-burger')).json.site, DEFAULT_SITE);
    const pub = await h.call('POST', '/v1/site/demo-burger/publish', tok(t));
    assert.deepEqual([pub.status, pub.json.unpublished, typeof pub.json.publishedAt], [200, false, 'number']);
    h = await h.restart();
    const live = (await h.call('GET', '/v1/stores/demo-burger')).json.site;
    assert.deepEqual([live.theme.primary, live.theme.font, live.bar.text, live.sections.map((s: { type: string }) => s.type)], ['#c2410c', 'Poppins', 'Free delivery above ₹499', ['hero', 'about', 'menu']]);
    // also once the POS has published a menu
    const code = (await h.call('POST', '/v1/admin/stores/demo-burger/pairing-code', { admin: true })).json.pairingCode;
    const key = (await h.call('POST', '/v1/pos/pair', { body: { code, deviceName: 'Counter 1' } })).json.deviceKey as string;
    await h.call('PUT', '/v1/pos/menu', { key, body: menu() });
    assert.equal((await h.call('GET', '/v1/stores/demo-burger')).json.site.theme.primary, '#c2410c');

    // a draft can be thrown away
    await h.call('PUT', '/v1/site/demo-burger/draft', { ...tok(t), body: { site: design() } });
    const discarded = (await h.call('POST', '/v1/site/demo-burger/discard', tok(t))).json;
    assert.deepEqual([discarded.unpublished, discarded.draft.theme.primary], [false, '#c2410c']);

    // a new password signs out every builder; signing out ends the token
    await h.call('POST', '/v1/admin/stores/demo-burger/site-password', { admin: true, body: {} });
    assert.equal((await h.call('GET', '/v1/site/demo-burger', tok(t))).status, 401);
    const { password: p2 } = (await h.call('POST', '/v1/admin/stores/demo-burger/site-password', { admin: true, body: {} })).json;
    const t2 = (await h.call('POST', '/v1/site/demo-burger/login', { body: { password: p2 } })).json.token as string;
    assert.equal((await h.call('POST', '/v1/site/demo-burger/logout', tok(t2))).status, 200);
    assert.equal((await h.call('GET', '/v1/site/demo-burger', tok(t2))).status, 401);
    // sign-ins end after 30 days
    const t3 = (await h.call('POST', '/v1/site/demo-burger/login', { body: { password: p2 } })).json.token as string;
    h.clock.t += 31 * 86_400_000;
    assert.equal((await h.call('GET', '/v1/site/demo-burger', tok(t3))).status, 401);
  } finally { await h.close(); cleanup(h.dir); }
});

test('site: photos uploaded from the builder are checked, kept with the store and served for the website', async () => {
  const h = await startHub();
  try {
    await twoStores(h);
    const { password } = (await h.call('POST', '/v1/admin/stores/demo-burger/site-password', { admin: true, body: {} })).json;
    const t = (await h.call('POST', '/v1/site/demo-burger/login', { body: { password } })).json.token as string;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3e2a6a80000000049454e44ae426082', 'hex');
    const name = `${createHash('sha256').update(png).digest('hex')}.png`;
    const body = { dataBase64: png.toString('base64') };
    assert.equal((await h.call('PUT', `/v1/site/demo-burger/images/${name}`, { body })).status, 401);
    assert.equal((await h.call('PUT', `/v1/site/demo-burger/images/${'0'.repeat(64)}.png`, { ...tok(t), body })).status, 400); // name is not its hash
    assert.equal((await h.call('PUT', `/v1/site/demo-burger/images/${name.replace('.png', '.jpg')}`, { ...tok(t), body })).status, 400); // not a JPG
    const up = await h.call('PUT', `/v1/site/demo-burger/images/${name}`, { ...tok(t), body });
    assert.deepEqual([up.status, up.json.ref], [200, `hub:${name}`]);
    const got = await fetch(`${h.base}/v1/stores/demo-burger/images/${name}`);
    assert.deepEqual([got.status, got.headers.get('content-type'), got.headers.get('access-control-allow-origin')], [200, 'image/png', '*']);
    // a design can use it
    const saved = await h.call('PUT', '/v1/site/demo-burger/draft', { ...tok(t), body: { site: design({ brand: { ...DEFAULT_SITE.brand, logo: up.json.ref } }) } });
    assert.equal(saved.json.draft.brand.logo, `hub:${name}`);
  } finally { await h.close(); cleanup(h.dir); }
});
