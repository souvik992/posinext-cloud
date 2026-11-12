import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, startHub, TEST_CLOUD_KEY } from './helpers.ts';
import { Hub } from '../src/hub.ts';
import { verifyKey } from '../../packages/licensing/src/index.ts';

const HW = 'AB12-CD34-EF56-7890-1A2B';
const trusted = [{ id: 'cloud', publicKey: TEST_CLOUD_KEY.publicKey, maxDays: 400 }];

async function storeWithPos(h: Awaited<ReturnType<typeof startHub>>) {
  const s = await h.call('POST', '/v1/admin/stores', { admin: true, body: { slug: 'spice-garden', name: 'Spice Garden' } });
  const p = await h.call('POST', '/v1/pos/pair', { body: { code: s.json.pairingCode, deviceName: 'Main PC' } });
  return { slug: 'spice-garden', storeId: s.json.storeId as string, deviceKey: p.json.deviceKey as string };
}

test('licences: the admin signs a cloud key; the DinePOS verifier accepts it; it reaches the outlet through the hourly renewal', async () => {
  const h = await startHub();
  try {
    const { slug, deviceKey } = await storeWithPos(h);
    assert.equal((await h.call('GET', `/v1/pos/licence`, { key: deviceKey })).json.key, null);
    const g = await h.call('POST', `/v1/admin/stores/${slug}/grants`, { admin: true, body: { hardwareId: HW.toLowerCase(), days: 365, terminals: 2, captains: 3, kds: 1 } });
    assert.equal(g.status, 200, JSON.stringify(g.json));
    assert.deepEqual([g.json.kind, g.json.hardwareId, g.json.seats, g.json.licensee], ['manual', HW, { terminals: 2, captains: 3, kds: 1 }, 'Spice Garden']);
    const v = verifyKey(g.json.key, trusted, HW);
    assert.ok(v.ok, v.ok ? '' : v.reason);
    if (v.ok) {
      assert.equal(v.payload.kid, 'cloud');
      assert.equal(Date.parse(v.payload.expiresAt) - Date.parse(v.payload.issuedAt), 365 * 86_400_000);
      // signed with the licensing library (packages/licensing), labelled for this product
      assert.equal((v.payload as { product?: string }).product, 'fine_dine');
    }
    // the outlet's renewal fetch now gets it
    const slot = await h.call('GET', '/v1/pos/licence', { key: deviceKey });
    assert.equal(slot.json.key, g.json.key);
    const list = await h.call('GET', `/v1/admin/stores/${slug}/grants`, { admin: true });
    assert.equal(list.json.grants.length, 1);
    assert.equal((await h.call('GET', `/v1/admin/stores/${slug}/grants`)).status, 403);
  } finally { await h.close(); cleanup(h.dir); }
});

test('licences: at most 400 days, a real hardware id and at least one terminal; no signing key → not available', async () => {
  const h = await startHub();
  try {
    const { slug } = await storeWithPos(h);
    const bad = async (body: Record<string, unknown>) => (await h.call('POST', `/v1/admin/stores/${slug}/grants`, { admin: true, body: { hardwareId: HW, days: 30, terminals: 1, ...body } })).status;
    assert.equal(await bad({ days: 401 }), 400);
    assert.equal(await bad({ days: 0 }), 400);
    assert.equal(await bad({ hardwareId: 'my pc' }), 400);
    assert.equal(await bad({ terminals: 0 }), 400);
    assert.equal(await bad({ days: 400 }), 200);
  } finally { await h.close(); cleanup(h.dir); }
  const none = new Hub({ dbPath: ':memory:' });
  try {
    assert.equal(none.licences.ready, false);
    const st = none.createStore('some-shop', 'Some Shop');
    assert.throws(() => none.licences.issue({ storeId: st.storeId, hardwareId: HW, kind: 'manual', days: 14, seats: { terminals: 1, captains: 0, kds: 0 }, licensee: 'x' }), (e: Error & { code?: string }) => e.code === 'NOT_AVAILABLE');
  } finally { none.close(); }
});

test('licences: grants are append-only; a revoke takes the key off the slot', async () => {
  const h = await startHub();
  try {
    const { slug, deviceKey } = await storeWithPos(h);
    const g = (await h.call('POST', `/v1/admin/stores/${slug}/grants`, { admin: true, body: { hardwareId: HW, days: 14 } })).json;
    assert.throws(() => h.hub.db.prepare('DELETE FROM licence_grant').run(), /append-only/);
    assert.throws(() => h.hub.db.prepare('UPDATE licence_grant SET expires_at = expires_at + 1').run(), /append-only/);
    const r = await h.call('POST', `/v1/admin/grants/${g.id}/revoke`, { admin: true, body: { reason: 'sent to the wrong outlet' } });
    assert.equal(r.json.revokedReason, 'sent to the wrong outlet');
    assert.equal((await h.call('GET', '/v1/pos/licence', { key: deviceKey })).json.key, null);
    // revoked once: a second revoke changes nothing, and the row cannot be un-revoked
    assert.equal((await h.call('POST', `/v1/admin/grants/${g.id}/revoke`, { admin: true, body: {} })).json.revokedReason, 'sent to the wrong outlet');
    assert.throws(() => h.hub.db.prepare('UPDATE licence_grant SET revoked_at = NULL').run(), /append-only/);
  } finally { await h.close(); cleanup(h.dir); }
});
