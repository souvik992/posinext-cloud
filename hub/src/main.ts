// Starts PosiNext Cloud. Environment:
//   HUB_PORT (default 4900), HUB_HOST (default 0.0.0.0), HUB_DATA_DIR (default ./hub-data)
//   HUB_ADMIN_KEY      required for the admin page (/admin) and /v1/admin (stores, pairing codes, devices, settings)
//   HUB_PUBLIC_URL     the hub's https address as shops reach it, used in connection links (else taken from the admin's browser)
//   HUB_DEV_OTP=1      return OTP codes in responses (development and the demo page only; never in production)
//   HUB_ROUTING_URL    optional OSRM-compatible server for real road distances (else each store's road factor);
//                      only the starting value: a routing server saved on the admin page wins
//   HUB_ONLINE_PAYMENTS=1  online payment (phase 3; needs a payment gateway)
//   HUB_DEVICE_DOMAIN  P6-02: devices reach an outlet at https://<store>.<this domain> (default: the host of HUB_PUBLIC_URL)
//   HUB_OUTLET_SERVER  P6-04: the DinePOS server for hosted outlets (default: ../../outlet-server/server.mjs in this repository)
//   HUB_TIMEZONE       P6-04: hosted outlets' time zone (default Asia/Kolkata)
//   HUB_BREVO_API_KEY, HUB_MAIL_FROM (+ HUB_MAIL_FROM_NAME)  P7-01: email for customer accounts (Brevo). Not set: sign-up is closed
//   HUB_LICENCE_SIGNING_KEY_FILE  P7-02: the cloud's licence signing key (PEM; default <HUB_DATA_DIR>/licence-signing-key.pem if there)
//   HUB_BROWSER_DEMO=1 P7-04: offer the browser demo (off by default since P8-05: the trial is the Windows app)
//   HUB_MAX_DEMOS      P7-04: browser demos running at once (default 10); HUB_DEMO_SEED: the sample outlet (default ../../outlet-server/demo-seed.json)
//   HUB_DEV_MAIL=1     P7-01: development only: no email provider, codes go to this log and sign-up is open
//   HUB_SKIP_EMAIL_VERIFY=1  sign-up without the emailed code (signed in at once); for getting started before email is set up
//   HUB_ALERT_WEBHOOK  Slack / Discord / Google Chat webhook for alerts (hosted outlet down, backups failing)
//   HUB_PORTAL_DIR     P8-09: the built customer portal (deploy/portal.sh fetches it); HUB_PORTAL_DOMAIN: its address
//   HUB_SMTP_HOST, HUB_SMTP_USER, HUB_SMTP_PASS (+ HUB_SMTP_PORT, default 465)  email through a mailbox's SMTP server
//                      instead of Brevo (e.g. Zoho: smtppro.zoho.in, support@posinext.com, an app password)
//   HUB_DEMO_REQUEST_TO  where posinext.com "Book a Demo" requests are emailed (needs Brevo or SMTP above); never shown on the site
//   HUB_SUPPORT_NOTIFY_TO  the support inbox (e.g. support@posinext.com): gets each new portal ticket and customer reply
//   GITHUB_TOKEN       P8-04: optional; downloads not uploaded yet come from GitHub Releases (60 requests an hour without it)
// Installers uploaded with `npm run release` (P8-11) are kept in <HUB_DATA_DIR>/downloads (the newest 3 of each).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from './hub.ts';
import { createHubServer } from './http.ts';
import { UrbanPiper } from './urbanpiper.ts';
import { HostedOutlets } from './hosted.ts';
import { Monitor } from './monitor.ts';
import { mailerFromEnv } from './mailer.ts';
import { Downloads } from './downloads.ts';
import { Portal } from './portal.ts';

const dir = process.env.HUB_DATA_DIR ?? './hub-data';
mkdirSync(dir, { recursive: true });
function signingKeyFile(): string | undefined {
  const f = process.env.HUB_LICENCE_SIGNING_KEY_FILE || join(dir, 'licence-signing-key.pem');
  return existsSync(f) ? f : undefined;
}
const log = { info: (m: string, d?: unknown) => console.log(new Date().toISOString(), m, d ?? ''), warn: (m: string, d?: unknown) => console.warn(new Date().toISOString(), m, d ?? '') };
const hub = new Hub({
  dbPath: join(dir, 'hub.db'), devOtp: process.env.HUB_DEV_OTP === '1', onlinePayments: process.env.HUB_ONLINE_PAYMENTS === '1', log,
  settingDefaults: { routingUrl: process.env.HUB_ROUTING_URL ?? '' },
  mailer: mailerFromEnv(process.env, log), licenceSigningKey: signingKeyFile(), allowLogMailer: process.env.HUB_DEV_MAIL === '1',
  skipEmailVerify: process.env.HUB_SKIP_EMAIL_VERIFY === '1',
});
if (process.env.HUB_SKIP_EMAIL_VERIFY === '1') log.warn('HUB_SKIP_EMAIL_VERIFY=1: sign-up does not check email addresses (set up email, then remove it)');
if (!process.env.HUB_ADMIN_KEY) log.warn('HUB_ADMIN_KEY is not set: store admin is disabled (use scripts/admin.ts on this machine)');
else log.info('hub admin page: /admin');
const urbanpiper = new UrbanPiper(hub, { log }); // Swiggy / Zomato (set up per store on the admin page)
// P6-04: outlets with no main PC: their DinePOS server runs here, one per outlet, data in <HUB_DATA_DIR>/outlets
const hosted = new HostedOutlets(hub, {
  serverEntry: process.env.HUB_OUTLET_SERVER ?? join(import.meta.dirname, '..', '..', 'outlet-server', 'server.mjs'),
  dataRoot: join(dir, 'outlets'),
  timeZone: process.env.HUB_TIMEZONE ?? 'Asia/Kolkata',
  log,
});
hosted.start();
// alerts: hosted outlets down, backups failing (deploy/backup.sh writes backup-status.json every hour)
const monitor = new Monitor(hub, { hosted, backupStatusFile: join(dir, 'backup-status.json'), webhook: process.env.HUB_ALERT_WEBHOOK || undefined, log });
const watcher = setInterval(() => void monitor.tick().catch((e) => log.warn('monitor failed', String(e))), 30_000);
watcher.unref();
const outletServerDir = join(import.meta.dirname, '..', '..', 'outlet-server');
// P8-04 / P8-11: Windows downloads: installers uploaded by `npm run release` (kept in <HUB_DATA_DIR>/downloads), else the
// newest GitHub Release (GITHUB_TOKEN optional: more API requests an hour)
const downloads = new Downloads(hub.db, { dir: join(dir, 'downloads'), githubToken: process.env.GITHUB_TOKEN || undefined, log });
const browserDemo = process.env.HUB_BROWSER_DEMO === '1' ? { seed: process.env.HUB_DEMO_SEED ?? join(outletServerDir, 'demo-seed.json'), max: Number(process.env.HUB_MAX_DEMOS ?? 10) || 10 } : undefined;
// P8-09: the customer portal on its own address (HUB_PORTAL_DOMAIN; else any portal.<host>)
const portal = process.env.HUB_PORTAL_DIR ? new Portal({ dir: process.env.HUB_PORTAL_DIR, hosts: (process.env.HUB_PORTAL_DOMAIN ?? '').split(',') }) : undefined;
const server = createHubServer(hub, { downloads, ...(portal ? { portal } : {}), ...(browserDemo ? { demo: browserDemo } : {}), hosted, monitor, adminKey: process.env.HUB_ADMIN_KEY, publicUrl: process.env.HUB_PUBLIC_URL || undefined, deviceDomain: process.env.HUB_DEVICE_DOMAIN || undefined, extraDeviceDomains: (process.env.HUB_EXTRA_DOMAINS ?? '').split(',').filter((d) => d.trim()), urbanpiper, demoRequestTo: process.env.HUB_DEMO_REQUEST_TO || undefined, supportNotifyTo: process.env.HUB_SUPPORT_NOTIFY_TO || undefined, log });
const sweeper = setInterval(() => { try { hub.sweep(); } catch (e) { log.warn('sweep failed', String(e)); } void urbanpiper.pump().catch((e) => log.warn('urbanpiper outbox failed', String(e))); }, 5000);
// P7-04: browser demos past their 72 hours are stopped and deleted
const demoSweeper = setInterval(() => void server.demos?.sweep().catch((e) => log.warn('demo sweep failed', String(e))), 60_000);
demoSweeper.unref();
const port = Number(process.env.HUB_PORT ?? 4900);
server.listen(port, process.env.HUB_HOST ?? '0.0.0.0', () => log.info(`PosiNext Cloud on http://localhost:${port} (data: ${dir})`));
const stop = () => { clearInterval(sweeper); server.close(); server.closeAllConnections(); void hosted.stop().finally(() => { hub.close(); process.exit(0); }); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
