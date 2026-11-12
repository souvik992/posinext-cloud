// Sends a sample Swiggy or Zomato order to a hub running on this PC, exactly as UrbanPiper would (development only:
// UrbanPiper itself cannot reach a hub on this PC). The UrbanPiper account and the store's details must be saved on the admin page,
// and its POS must have published a menu (the order uses the first two items).
//   npm run urbanpiper-sample -- <store> [swiggy|zomato] [--self] [--cash]
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TOKEN_HEADER } from '../src/urbanpiper.ts';
import type { PublishedMenu } from '../../contract/src/menu.ts';

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--') && a !== 'swiggy' && a !== 'zomato') ?? 'demo';
const platform = args.includes('zomato') ? 'zomato' : 'swiggy';
const self = args.includes('--self'), cash = args.includes('--cash');
const dir = process.env.HUB_DATA_DIR ?? join(import.meta.dirname, '..', 'hub-data');
const port = Number(process.env.HUB_PORT ?? 4900);

const db = new DatabaseSync(join(dir, 'hub.db'), { readOnly: true });
const acct = db.prepare('SELECT biz_id, webhook_token FROM up_account WHERE id = 1').get() as { biz_id: string; webhook_token: string } | undefined;
const link = db.prepare('SELECT u.location_ref, s.menu_json FROM up_link u JOIN store s ON s.id = u.store_id WHERE s.slug = ?').get(slug) as { location_ref: string; menu_json: string | null } | undefined;
db.close();
if (!acct) { console.error('No UrbanPiper account yet. Save it on the admin page first (Hub settings > Swiggy & Zomato).'); process.exit(1); }
if (!link) { console.error(`Store "${slug}" has no UrbanPiper details. Save them on the admin page first (Stores > ${slug} > Swiggy & Zomato).`); process.exit(1); }
const row = { ...acct, ...link };
if (!row.menu_json) { console.error(`Store "${slug}" has no menu yet: connect its POS and turn on online orders first.`); process.exit(1); }
const menu = JSON.parse(row.menu_json) as PublishedMenu;
const items = menu.items.filter((i) => i.available && !i.modifierGroupIds.length).slice(0, 2);
if (!items.length) { console.error('The menu has no available items without options.'); process.exit(1); }
const rupees = (p: number) => Math.round(p) / 100;
const id = Date.now() % 100_000_000;
const subtotal = items.reduce((s, i, n) => s + (i.prices?.[platform] ?? i.price) * (n + 1), 0);
const body = {
  customer: { name: 'Test Customer', phone: '+91-9876543210', email: '', address: { line_1: 'Flat 4, Lake View Apartments', line_2: null, landmark: 'Near the park', city: 'Bengaluru', pin: '560043', latitude: 13.03, longitude: 77.646, sub_locality: 'Kalyan Nagar', is_guest_mode: false, tag: 'home' } },
  order: {
    details: {
      id, channel: platform, order_type: 'delivery', order_state: 'Placed', created: Date.now(), delivery_datetime: Date.now(), instructions: 'Please ring the bell',
      order_subtotal: rupees(subtotal), order_total: rupees(subtotal + 2000), payable_amount: rupees(subtotal + 2000), charges: [{ title: 'Packaging Charge', value: 20, taxes: [] }], taxes: [],
      ext_platforms: [{ id: `${platform === 'swiggy' ? 'SW' : 'ZO'}-${id}`, kind: 'food_aggregator', name: platform, delivery_type: self ? 'self' : 'partner', extras: { order_otp: String(1000 + (id % 9000)), can_reject_order: true, ...(cash ? { cash_to_be_collected: rupees(subtotal + 2000) } : {}) }, discounts: [] }],
    },
    items: items.map((i, n) => ({ id: n + 1, title: i.name, merchant_id: i.id, price: rupees(i.prices?.[platform] ?? i.price), quantity: n + 1, options_to_add: [], options_to_remove: [], charges: [], taxes: [], instructions: n === 0 ? 'Less spicy' : '' })),
    next_state: 'Acknowledged', payment: [{ option: cash ? 'cash' : 'payment_gateway', amount: rupees(subtotal + 2000) }],
    store: { merchant_ref_id: row.location_ref },
  },
};
const r = await fetch(`http://localhost:${port}/v1/urbanpiper/${encodeURIComponent(row.biz_id)}`, { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: row.webhook_token, 'x-upr-event-type': '18' }, body: JSON.stringify(body) });
const j = await r.json().catch(() => null) as { order_ref_id?: string; error?: { message?: string } } | null;
if (!r.ok) { console.error(`The hub refused it (${r.status}): ${j?.error?.message ?? ''}`); process.exit(1); }
console.log(`Sample ${platform === 'swiggy' ? 'Swiggy' : 'Zomato'} order ${body.order.details.ext_platforms[0]!.id} sent: it is ${j?.order_ref_id} on the hub (UrbanPiper order id ${id}).`);
console.log('See it on the admin page (Orders) and on the ODS of the connected POS.');
