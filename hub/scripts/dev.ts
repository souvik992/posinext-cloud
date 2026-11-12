// Runs a local hub for trying online orders on this PC (development only: OTP codes are shown on screen).
// Creates the store "sample" ("demo" is a reserved cloud address) the first time and prints a pairing code for the POS and the demo ordering page address.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Hub } from '../src/hub.ts';
import { createHubServer } from '../src/http.ts';
import { UrbanPiper } from '../src/urbanpiper.ts';
import { one } from '../src/db.ts';

const dir = process.env.HUB_DATA_DIR ?? join(import.meta.dirname, '..', 'hub-data');
mkdirSync(dir, { recursive: true });
const hub = new Hub({ dbPath: join(dir, 'hub.db'), devOtp: true, allowLogMailer: true, log: { info: (m, d) => console.log(m, d ?? ''), warn: (m, d) => console.warn(m, d ?? '') } });
const port = Number(process.env.HUB_PORT ?? 4900);
const adminKey = process.env.HUB_ADMIN_KEY ?? randomBytes(12).toString('base64url'); // a new one each run unless set
const urbanpiper = new UrbanPiper(hub, { log: { info: (m, d) => console.log(m, d ?? ''), warn: (m, d) => console.warn(m, d ?? '') } });
const server = createHubServer(hub, { adminKey, urbanpiper, downloadsDir: join(dir, 'downloads') }); // P8-11: npm run release uploads here
setInterval(() => { hub.sweep(); void urbanpiper.pump(); }, 5000).unref();
server.listen(port, '0.0.0.0', () => {
  const exists = one(hub.db, "SELECT 1 FROM store WHERE slug = 'sample'");
  const code = exists ? hub.pairingCodeForSlug('sample') : hub.createStore('sample', 'Sample store').pairingCode;
  const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
  console.log(`\nOrder hub (development) running.\n`);
  console.log(`  In the POS: Settings > Online orders > Order hub, paste the connection link:`);
  console.log(`     http://localhost:${port}/connect/${code}   (one use, ${hub.settings().pairingCodeMinutes} minutes)\n`);
  console.log(`  Hub admin page: http://localhost:${port}/admin\n     Admin key: ${adminKey}\n`);
  console.log(`  Demo ordering page: http://localhost:${port}/order/sample${lan ? `\n  From a phone on the same Wi-Fi: http://${lan}:${port}/order/sample` : ''}\n`);
  console.log(`  Customer portal (sign up, codes in this log): http://localhost:${port}/signup
`);
  console.log('  OTP codes are shown on the ordering page (development only). Ctrl+C stops the hub.\n');
});
