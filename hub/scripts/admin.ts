// Store admin on the hub machine (works without the admin key: it opens the hub database directly).
// Usage (from hub/):
//   npm run admin -- create-store <slug> "<Store name>"   -> prints a connection link for the POS
//   npm run admin -- pairing-code <slug>                  -> a new connection link (one use, 30 minutes by default)
// Links use HUB_PUBLIC_URL (the hub's https address), else http://localhost:<HUB_PORT>.
//   npm run admin -- list
//   npm run admin -- revoke-device <deviceId>
//   npm run admin -- site-password <slug>                 -> a new password for the store's website builder (/admin)
//   npm run admin -- cloud-key import <file.pem>          -> P7-02: install the licence signing key (from the keygen folder)
//   npm run admin -- cloud-key public                     -> the installed signing key's public half (must match the app's)
import { join } from 'node:path';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadSigningKey, publicKeyBase64 } from '../src/licences.ts';
import { Hub, HubError } from '../src/hub.ts';
import { many } from '../src/db.ts';

const dir = process.env.HUB_DATA_DIR ?? './hub-data';
mkdirSync(dir, { recursive: true });
const hub = new Hub({ dbPath: join(dir, 'hub.db') });
const [cmd, a, b] = process.argv.slice(2);
const link = (code: string) => `${(process.env.HUB_PUBLIC_URL ?? `http://localhost:${process.env.HUB_PORT ?? 4900}`).replace(/\/+$/, '')}/connect/${code}`;
const valid = `one use, ${hub.settings().pairingCodeMinutes} minutes`;
try {
  if (cmd === 'create-store' && a && b) {
    const s = hub.createStore(a, b);
    console.log(`Store "${s.name}" created (${s.slug}).\nConnection link for its POS: ${link(s.pairingCode)}  (${valid})`);
  } else if (cmd === 'pairing-code' && a) {
    console.log(`Connection link for ${a}: ${link(hub.pairingCodeForSlug(a))}  (${valid})`);
  } else if (cmd === 'list') {
    for (const s of many<{ id: string; slug: string; name: string; menu_version: number; accepting: number }>(hub.db, 'SELECT id, slug, name, menu_version, accepting FROM store ORDER BY slug')) {
      console.log(`${s.slug}  ${s.name}  menu v${s.menu_version}  ${s.accepting ? 'accepting' : 'not accepting'}`);
      for (const d of many<{ id: string; name: string; revoked_at: number | null }>(hub.db, 'SELECT id, name, revoked_at FROM device WHERE store_id = ?', s.id)) console.log(`   device ${d.id}  ${d.name}${d.revoked_at ? '  (revoked)' : ''}`);
    }
  } else if (cmd === 'revoke-device' && a) {
    hub.revokeDevice(a); console.log(`Device ${a} can no longer connect.`);
  } else if (cmd === 'site-password' && a) {
    console.log(`Website builder password for ${a}: ${hub.newSitePassword(a).password}\n(The old one no longer works. Sign in at the website's address with /admin at the end.)`);
  } else if (cmd === 'cloud-key' && a === 'import' && b) {
    const key = loadSigningKey(b); // checks it is an Ed25519 private key
    const to = process.env.HUB_LICENCE_SIGNING_KEY_FILE || join(dir, 'licence-signing-key.pem');
    if (existsSync(to)) throw new Error(`A signing key is already installed at ${to}. Remove it first if you really mean to replace it.`);
    copyFileSync(b, to); chmodSync(to, 0o600);
    console.log(`Licence signing key installed at ${to}.
Public key: ${publicKeyBase64(key)}
It must equal CLOUD_LICENCE_PUBLIC_KEY in apps/server/src/licence/public-key.ts. Restart the cloud: sudo systemctl restart posinext-cloud`);
  } else if (cmd === 'cloud-key' && a === 'public') {
    const f = process.env.HUB_LICENCE_SIGNING_KEY_FILE || join(dir, 'licence-signing-key.pem');
    console.log(existsSync(f) ? publicKeyBase64(loadSigningKey(f)) : `No signing key at ${f}.`);
  } else {
    console.log('Commands: create-store <slug> "<name>" | pairing-code <slug> | list | revoke-device <deviceId> | site-password <slug> | cloud-key import <file.pem> | cloud-key public');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof HubError ? e.message : e);
  process.exitCode = 1;
} finally { hub.close(); }
