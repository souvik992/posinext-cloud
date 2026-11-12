# PosiNext Cloud

The cloud service for **DinePOS (fine dine) only**: its own server, its own data, its own admin key. It is separate
from the Tiffin POS hub, and you install it on its own AWS server. It started as a copy of the Tiffin order hub
(pos-backend `hub/`) and is cut down to what DinePOS uses.

What it does today (P6-01):
- **Online orders from your website**: store page, delivery quotes, OTP, orders sent live to the DinePOS online orders
  screen, accept/reject/status back to the customer.
- **Swiggy and Zomato through UrbanPiper.**
- **Sales sync**: bills and day-end reports from each outlet, licence renewals, online backups.
- **Table QR relay**: guests on mobile data reach the Table QR add-on through `<cloud>/s/<store>/a/tableqr/`.
- **Website builder** for each store's ordering site.

Next (docs/10-roadmap.md, Phase 6):
- **P6-02** captain phones, kitchen screens and terminals connect from anywhere, tunnelled to the outlet PC.
- **P6-03** cloud printing through a small print agent at the outlet.
- **P6-04** fully hosted outlets with no master PC (one database per outlet in the cloud): see below.

Zero runtime dependencies: Node 24 and `node:sqlite`. It imports one library from this repository by source: the
licensing library (`packages/licensing`; ADR-0007). It follows the order contract in `../contract/` (life cycle,
shapes, checks, prices; the pricing code is in `../core/`).

## Put it on AWS (one server, about 10 minutes)

1. **EC2 › Launch instance:** Ubuntu 24.04, t3.micro (free tier), a key pair. In the security group, allow
   SSH (22), HTTP (80) and HTTPS (443). Give it an **Elastic IP** so the address never changes.
2. **Connect** (`ssh -i <key>.pem ubuntu@<elastic ip>`) and run:
   ```
   curl -fsSL https://raw.githubusercontent.com/souvik992/posinext-cloud/main/hub/deploy/install.sh | sudo bash
   ```
   It installs Node 24 and Caddy (free HTTPS), runs PosiNext Cloud as the `posinext-cloud` service, and prints the
   address (`https://<ip>.sslip.io`) and the **admin key**. Save the key.
3. **Own domain (optional):** point a DNS A record (e.g. `cloud.yourbrand.in`) at the Elastic IP, set
   `HUB_DOMAIN=cloud.yourbrand.in` in `/etc/posinext-cloud.env`, then run `sudo posinext-cloud-domain`.
4. **Add an outlet:** open `https://<address>/admin`, enter the admin key, and create a store (for example
   `spice-garden-indiranagar`). Copy its **connection link**.
5. **Connect DinePOS:** on the outlet's main PC, go to **Settings › Online orders › Order hub**, paste the connection
   link and press Connect. Sales sync, licence renewals, online orders and Table QR through the cloud all use that one
   connection.

| Task | Command (on the server) |
|---|---|
| Update to the latest version from GitHub | `sudo posinext-cloud-update` |
| Logs | `journalctl -u posinext-cloud -f` |
| Settings (admin key, domain, port) | `/etc/posinext-cloud.env` |
| Data | `/var/lib/posinext-cloud` (copied daily to `/var/backups/posinext-cloud`, 14 days kept) |

More detail, including Oracle Cloud and ready-made cloud-init files, is in `deploy/README.md`.

## Try it on one PC

```
cd hub
npm run dev
```

This prints a connection link for the POS (`http://localhost:4900/connect/<code>`), the hub admin page (`/admin`) with
an admin key for this run, and a demo ordering page (`/order/sample`). Then:

1. In the POS, open **Settings > Online orders**, turn online orders on, choose Website, and save.
2. In the **Order hub** card, paste the connection link and press **Connect**.
3. Set the store location and areas in **Settings > Serviceability**, and the GST rate for fees.
4. Open a shift.
5. Order on the demo page. The order appears on the **ODS** with a sound. Press **Accept**, and the GST bill and kitchen ticket print.

OTP codes are shown on the demo page in development. In production an SMS provider sends them (not built yet).

## Run it for real

```
HUB_ADMIN_KEY=<long random secret> HUB_DATA_DIR=/var/lib/posinext-cloud npm start
```

| Variable | Meaning |
|---|---|
| `HUB_PORT` | Port (default 4900). |
| `HUB_HOST` | Listen address (default 0.0.0.0). |
| `HUB_DATA_DIR` | Database folder (default `./hub-data`). Back it up. |
| `HUB_ADMIN_KEY` | Needed for the admin page (`/admin`) and `/v1/admin`. Not set: admin over HTTP is off. |
| `HUB_PUBLIC_URL` | The hub's https address as shops reach it, used in connection links. Not set: taken from the admin page's address. |
| `HUB_DEV_OTP=1` | Puts OTP codes in responses. **Development only.** |
| `HUB_ROUTING_URL` | An OSRM server for real road distances. Not set: straight line × the store's road factor. Only the starting value: the admin page can change it. |
| `HUB_ONLINE_PAYMENTS=1` | Online payment (phase 3; needs a payment gateway). |

Put it behind HTTPS: a reverse proxy such as Caddy or nginx, with response buffering off for `/v1/pos/events` and
`/v1/orders/*/events`. The POS refuses a plain `http://` hub address unless the hub is on the same PC.

### Admin page

Open `https://<hub address>/admin` and enter the admin key (kept only in that browser tab; ten wrong keys a minute
from one address are refused for the rest of the minute).

- **Orders:** the latest 100 of all stores or one store, filtered Open / Delivered / Cancelled / Failed / All. Each row:
  order number, sales channel (Swiggy and Zomato in their colours, Website, App), date and time (India time), status,
  pickup or delivery, payment mode, total. Status is one of Placed, Accepted, Preparing, In transit, Delivered,
  Cancelled by store, Cancelled by customer or Failed, with what happened (reject reason, rider, "did not reach the
  store: its POS was offline", "the store did not accept in time", payment not completed). **Failed** also lists order
  attempts that never became orders (store offline or closed, changed price, outside the area, missing OTP, technical
  errors on the hub, with the error code), kept 30 days (table `order_attempt`). Click a row for its items, charges,
  customer (mobile masked), address and POS bill number.
- **Stores:** each store's state (POS online, shift open, what customers are told, open orders and orders in 24 h).
  Open a store for its POS devices and the **store settings its POS published**: accepting (auto or by staff and the
  time limit), channels, pickup and delivery, payments, pickup minimum and time, packaging charge, GST on charges,
  location, road factor, delivery bands, opening hours and menu by category. They are read-only here: the shop changes
  them in its POS, which sends them with the menu.
- **Website builder password** (on each store's page): the store designs its own ordering website in the website
  builder (the website's `/admin` page). Here you only make its password (shown once; a new one signs every builder
  out), and see when the website was last published. Also `npm run admin -- site-password <slug>`.
- **Add a store** to get a **connection link** (`<hub address>/connect/<code>`, Copy button). The shop pastes only this
  into its POS (Settings > Online orders > Order hub). It works once and for a limited time (Hub settings); make a new
  one from the store's page. Opened in a browser, the link only explains where to paste it.
- **Pause online orders** for a store from the hub, with a message for customers. Its POS cannot undo this; the POS is
  not told yet, so tell the shop. **Resume** reopens it.
- **Revoke** a POS device (lost or stolen PC): refused at once.
- **Hub settings**, saved in the hub database and used at once: road-routing server, how long until a disconnected
  store counts as offline, how long connection links are valid, and the per-minute request limits (OTP, orders, pairing).
  `HUB_DEV_OTP` and `HUB_ONLINE_PAYMENTS` are only shown: they change only by restarting the hub, so the admin key
  alone can never switch on OTP codes on screen.

The admin calls (`X-Admin-Key` header): `GET /v1/admin/overview`, `PUT /v1/admin/settings`, `POST /v1/admin/stores`
and `POST /v1/admin/stores/<slug>/pairing-code` (both return `connectUrl`), `GET /v1/admin/stores/<slug>`,
`GET /v1/admin/orders?store=<slug>&status=open|all&limit=`, `GET /v1/admin/stores/<slug>/orders`,
`PUT /v1/admin/stores/<slug>/pause` (`{ paused, reason }`), `POST /v1/admin/stores/<slug>/site-password` (a new website builder password), `POST /v1/admin/devices/<id>/revoke`.

### Stores and pairing from the command line

```
npm run admin -- create-store spice-garden "Spice Garden"   # prints a connection link (uses HUB_PUBLIC_URL)
npm run admin -- pairing-code kalyan-nagar                          # a new link (one use, 30 minutes by default)
npm run admin -- list
npm run admin -- revoke-device <deviceId>                           # a lost or stolen PC
```

A connection link (its pairing code) gives the POS a device key that the hub keeps only as a hash. A revoked device is refused at once.

## Menu photos

The POS sends each menu item's photo once (`GET /v1/pos/images` lists what the hub has; `PUT /v1/pos/images/<sha256>.<ext>`
with `{ dataBase64 }`). The hub refuses a photo whose bytes do not match its name or are not JPG/PNG/WebP, and deletes
photos that are no longer on the menu. Customers' pages load them from `/v1/stores/<slug>/images/<name>`.

## Online backups

The same hub stores the POS's online backups (Settings > Backups > Online backup, `src/backups.ts`). A shop that only
wants backups needs a store here too: `npm run admin -- create-store <slug> "<Store name>"` prints a pairing code; the
owner types the hub address and the code into the POS.

| Endpoint (POS device key) | What |
|---|---|
| `GET /v1/pos/backups` | this store's backups, newest first: `{name, bytes, uploadedAt, sha256}` |
| `PUT /v1/pos/backups/<kind>-<time>.db.gz` | raw gzip body with `X-Content-SHA256`; streamed to disk, refused (and not kept) if the hash differs or it is larger than 1 GB |
| `GET /v1/pos/backups/<name>` | the file, with `X-Content-SHA256` |
| `GET /v1/pos/backup-images`, `PUT`/`GET /v1/pos/backup-images/<sha256>.<ext>` | menu photos the backups use, checked against their name |

Files live in `backups/<storeId>/` next to `hub.db` (never in the database); the newest 30 backups per store are kept.
They are not encrypted (the owner's choice, docs/DECISIONS.md), so secure the server and its disk.

## Customer accounts and the portal (P7-01, ADR-0006)

The portal for DinePOS customers, at `portal.posinext.com` (any host name that reaches this cloud works; `portal`,
`www`, `app`, `api`, `admin` and a few others can never be store addresses). Pages: `/signup`, `/login`, `/forgot`,
`/app` (one page, `public/portal.html`). The admin page lists accounts under **Accounts**.

Sign up (business name, your name, email, mobile, password) → a 6-digit code by email → verified and signed in.
- Passwords: scrypt (N=16384, salted), never stored or logged in clear. At least 8 characters.
- Codes: 10 minutes, 5 wrong tries lock the code (ask for a new one), at most 5 codes an hour per person.
- Sign-in: a random 256-bit token in an HttpOnly, SameSite=Lax cookie: over https `__Host-dp_account` (Secure, Path=/,
  no Domain: kept to that exact host), else `dp_account`. Only its SHA-256 is stored. It stays while used: each visit
  (`GET /v1/account/me`) moves the end 400 days on and renews the cookie, so a sign-in ends only after 400 days without
  a visit (the longest browsers keep a cookie), on sign-out, or as below. Someone whose email is not verified never
  gets one. A password reset ends every sign-in of that person; a password change ends the others.
- Devices: `GET /v1/account/sessions` (last used, browser, which is this one; a 16-hex reference, never the token),
  `POST /v1/account/sessions/<id>/revoke`, `POST /v1/account/sessions/revoke-others` (portal: My account).
- Other websites: changes (`POST /v1/account/...`) whose `Origin` is another host are refused (403), and these routes
  send no CORS headers. Portal pages are served with a Content-Security-Policy (own scripts only, no framing),
  Permissions-Policy, and HSTS over https.
- `HUB_SKIP_EMAIL_VERIFY=1` (for getting started before email is set up): sign-up is open without an email provider,
  needs no code and signs in at once; accounts made earlier sign in with their password. Anyone can then sign up with
  an email that is not theirs, and "forgot password" cannot work: set up Brevo, then remove it.
- Limits per IP: sign-up, resend and forgot 5 a minute; sign-in 10; codes 20. 10 wrong passwords for one email lock it
  for 15 minutes.

| Endpoint | |
|---|---|
| `POST /v1/account/signup` | `{businessName, name, email, phone, password}` → `{email, verify: true}`; 409 `EMAIL_TAKEN` |
| `POST /v1/account/verify` | `{email, code}` → sets the cookie |
| `POST /v1/account/resend` · `/forgot` | `{email}` → `{ok}` (the same answer for unknown emails) |
| `POST /v1/account/reset` | `{email, code, password}` → sets the cookie, ends other sign-ins |
| `POST /v1/account/login` · `/logout` | `{email, password}`; 403 `EMAIL_NOT_VERIFIED` (a new code is sent) |
| `GET /v1/account/me` | `{user, account, stores}` |
| `POST /v1/account/password` | `{current, password}` |
| `GET /v1/account/status` | `{signupOpen}` |
| `GET /v1/admin/accounts` (admin key) | the newest 500 accounts |

**Email** (`src/mailer.ts`): Brevo, free plan. Set `HUB_BREVO_API_KEY`, `HUB_MAIL_FROM` (a sender verified in Brevo)
and optionally `HUB_MAIL_FROM_NAME` in `/etc/posinext-cloud.env`. Without them, sign-up is **closed**. For development,
`HUB_DEV_MAIL=1` (and `npm run dev`) writes the codes to the log instead.

**Email without Brevo: a mailbox's SMTP server** (e.g. Zoho Mail for `support@posinext.com`). In
`/etc/posinext-cloud.env` set `HUB_SMTP_HOST=smtppro.zoho.in`, `HUB_SMTP_USER=support@posinext.com`,
`HUB_SMTP_PASS=<Zoho app password>` and `HUB_MAIL_FROM_NAME=POSINEXT` (port 465 with TLS; `HUB_SMTP_PORT` changes it;
the sender is `HUB_MAIL_FROM`, default the user). Brevo is used instead when its settings are there.

## Licence keys signed by the cloud (P7-02)

The cloud signs trial, demo and paid keys itself with its own Ed25519 key. The DinePOS app trusts it next to the
vendor's master key, but only for keys of at most 400 days. Signing, the key format and hardware ids come from the
licensing library (`packages/licensing`); keys say
`product: "fine_dine"`, which the app accepts like keys without it.
- **Install the key once** (the private key is in the vendor's keygen folder:
  `keys/posinext-cloud-signing-private.pem`). Copy it to the server, then run
  `sudo -u posinext-cloud npm run admin -- cloud-key import /path/to/posinext-cloud-signing-private.pem`, delete the
  copied file, and restart the service. `npm run admin -- cloud-key public` must print the same value as
  `CLOUD_LICENCE_PUBLIC_KEY` in `apps/server/src/licence/public-key.ts`.
- Every key signed here is a `licence_grant` row (append-only: only a revoke can be recorded, once). A grant is put in
  the store's licence slot, so the outlet installs it within an hour. Revoking takes it off the slot; a key an outlet
  already installed keeps working until it ends.
- Admin page › a store › Licence: **Keys signed by this cloud** (sign one for a hardware id, 1 to 400 days, seats;
  revoke). API: `GET`/`POST /v1/admin/stores/<slug>/grants`, `POST /v1/admin/grants/<id>/revoke`,
  `GET /v1/admin/licence-signing`.

## Windows trial and activation (P7-03, P8-02)

Two products (`src/products.ts`; ADR-0007): `fine_dine` (DinePOS) and `tiffin_qsr` (Tiffin POS). DinePOS on a PC:
**Settings › Licence › Your DinePOS account**; Tiffin POS the same (P8-10). The app's server calls `POST /v1/activate`
`{email, password, hardwareId, outletName, mode: "trial" | "signin", link, product}` (10 a minute per IP; `product`
missing = `fine_dine`, for DinePOS builds before P8-02):
- `trial`: a 30-day key for that product (DinePOS: 1 terminal, 1 captain phone, 1 kitchen screen; Tiffin POS: 1
  terminal, 1 kitchen screen). One trial per product for each PC, email and mobile (`trial_claim`, with `product`).
  The first activation makes the account's outlet for that PC and product (`account_store`) and, with `link`, pairs
  it with this cloud, so renewals and paid keys arrive by themselves.
- `signin`: the key the account already has for this PC and product (after a reinstall); otherwise `NO_LICENCE`.
- Keys say `product`; each app refuses keys for the other (DinePOS still accepts its unlabelled keys from before).
- The same password check as the portal (wrong passwords lock the email for 15 minutes; an unverified email gets a
  new code).

## Windows downloads (P8-04)

The portal's downloads (`src/downloads.ts`; ADR-0007): for **Fine Dine** the DinePOS installer and the Table QR and
Kitchen display (DinePOS Kitchen, `apps/kitchen`) add-ons, and the Captain app for waiters' phones (Android APK,
`apps/captain-android`),
for **QSR** the Tiffin POS installer and the ODS add-on, always the newest build.

**Releasing (P8-11).** Installers are built on the vendor's Windows PC and uploaded here; CI does not publish them.
1. Once: create `%USERPROFILE%\.dinepos\release.json` with `{"hubUrl": "https://<this cloud>", "adminKey": "<HUB_ADMIN_KEY>"}`
   (never in a repository). Add-ons are signed with the keys already on that PC (`%USERPROFILE%\.dinepos\addon-signing`,
   `%USERPROFILE%\.tiffinpos\addon-signing`).
2. In fine-dine: `npm run release` (DinePOS, Table QR, Kitchen and the Captain APK). In tiffin: `npm run release` (Tiffin POS + ODS). Each builds
   from a clean commit, checks the address and key first, then uploads with progress. `-- --no-build` uploads what is
   already built; `-- --only tableqr` (or `dinepos`, `kitchen`, `captain`, `tiffin`, `ods`) one item.
3. The portal offers the new version at once.

- `PUT /v1/admin/downloads/<item>/<file name>` (admin key, raw body, `X-Content-SHA256`): the file must be that item's
  installer (`DinePOS-Setup-<v>.exe`, `DinePOS-Captain-<v>.apk`, ...); it is streamed to `<HUB_DATA_DIR>/downloads/<item>/` and kept only if its
  SHA-256 matches. The same version again replaces it; the newest 3 versions of each item are kept.
- `DELETE /v1/admin/downloads/<item>/<version>` (admin key): withdraw a version; the newest one left is offered.
- Uploaded files are not in the nightly backup (they can be uploaded again from the build PC).
- An item never uploaded is offered from GitHub Releases (fine-dine `dinepos-build-<n>`, tiffin `tiffin-build-<n>`,
  published by CI before P8-11), read from the GitHub API.
- `GET /v1/downloads`: the list (version, build, size, date, product), cached 10 minutes. When GitHub cannot be reached
  the last list is used, also after a restart (kept in `setting`). An add-on missing from the newest build (its
  signing secret was not set) comes from the newest build that has it.
- `GET /v1/account/downloads/<id>` (signed in): records the download (`download_log`), then streams the uploaded file
  (`Content-Disposition: attachment`, `X-Content-SHA256`) or redirects to GitHub's.
- `GET /v1/admin/downloads` (admin key): downloads per file and version, and the uploaded files.
- `GITHUB_TOKEN` (optional): GitHub allows 60 API requests an hour per server without it; the cache needs at most 12.

## Customer portal hosting (P8-09)

The portal is built by souvik992/saas-portal's CI on every push to main (release `portal-build-<n>`, file
`portal-dist.tar.gz`). `deploy/portal.sh` (run by `posinext-cloud-update`, `posinext-cloud-domain` and the installer)
fetches the newest build into `/opt/posinext-portal`, sets `HUB_PORTAL_DIR`, and adds the portal's site to Caddy. The
hub (`src/portal.ts`) serves it on `HUB_PORTAL_DOMAIN`; its `/v1/...` calls reach the hub on the same address.

Moving portal.posinext.com from Lovable to this server (once):
1. Merge saas-portal's portal into main, so its CI publishes the first `portal-build`.
2. On the server, once: `sudo bash /opt/posinext-cloud/hub/deploy/install.sh` (installs the new update script); later
   updates are `sudo posinext-cloud-update`.
3. Email must work for sign-up codes: `HUB_BREVO_API_KEY` and `HUB_MAIL_FROM` in `/etc/posinext-cloud.env`.
4. Cloudflare DNS for posinext.com: replace the `portal` record (Lovable's) with an **A** record to this server's IP,
   **DNS only** (grey cloud) so Caddy can get the certificate. Remove the custom domain from the Lovable project.
5. In `/etc/posinext-cloud.env` set `HUB_PORTAL_DOMAIN=portal.posinext.com`, then `sudo posinext-cloud-domain`.
   `https://portal.posinext.com` then serves the portal; until the first build is fetched it says it is being installed.

## Customer portal: licences, support, announcements, knowledge base, status (P8-07, P8-08)

The portal (souvik992/saas-portal `cloud/saas-web`; ADR-0007) reads all of this from here, on the same origin:
- `GET /v1/account/licences`: the account's keys (product, outlet, PC, seats, end, revoked, key text).
- `POST /v1/account/products` `{products}`: QSR (`tiffin_qsr`), Fine Dine (`fine_dine`) or both (owner or admin).
- Tickets (`src/support.ts`): `GET|POST /v1/account/tickets`, `GET /v1/account/tickets/<id>`, `POST .../reply`,
  `POST .../close`. Numbered from #1001; private to the account. Admin page › **Support**: tickets waiting for an
  answer first; an answer is emailed to the customer who opened the ticket (`/v1/admin/tickets...`). Set
  `HUB_SUPPORT_NOTIFY_TO=support@posinext.com` in `/etc/posinext-cloud.env` (needs Brevo or SMTP email) and each new
  ticket and each customer reply is emailed there too; replying to that email goes to the customer by email only, so
  answer on the admin page for it to show in the portal.
- Announcements: `GET /v1/announcements` (`?product=`), written on the admin page (`/v1/admin/announcements`).
- Knowledge base: `GET /v1/kb`, `GET /v1/kb/<slug>` (plain text; blank lines make paragraphs), written on the admin page.
- `GET /v1/status`: sign-in, licence activation, downloads published, online orders relay.

## posinext.com "Book a Demo" requests

The posinext.com website (a static site; souvik992/saas-portal `site/`) posts its demo form to
`POST /v1/demo-requests` on this hub (CORS open, 10 a minute per address, a hidden field drops bots). Each request is
saved and emailed to `HUB_DEMO_REQUEST_TO` (needs Brevo or SMTP email, above; a reply goes to the restaurant's email) in `/etc/posinext-cloud.env`. That address
lives only on the server: it is never in the website or in any response. A request whose email fails is still kept;
list them with `GET /v1/admin/demo-requests` (admin key).

## Browser demo (P7-04; off since P8-05)

Off by default (ADR-0007: the trial is the Windows app). Start the cloud with `HUB_BROWSER_DEMO=1` to offer it again;
without it the portal's demo routes answer that there is no browser demo.

A signed-in portal user presses **Start the browser demo** (portal › account page). In about 3 to 30 seconds they get a
sample restaurant, run here as a hosted outlet (`demo-xxxxxx`). It has 12 tables, 30 dishes, sample printers, and
staff whose PINs are shown on the page (owner 1234, manager 2345, cashier 1111, captain 3333). **Open the demo
terminal** opens the real billing screens in the browser, already paired. Each demo has a 3-day licence signed by
this cloud and is deleted after 72 hours.

Needs: hosted outlets (`cloud/outlet-server`, which holds `web/pos` and `demo-seed.json`), the signing key above, and a
device domain (`HUB_DEVICE_DOMAIN` or the host of `HUB_PUBLIC_URL`), with wildcard DNS for `*.<domain>`.
`HUB_MAX_DEMOS` (default 10) caps how many run at once. Each one is a DinePOS server, about 60 to 80 MB of memory, so
size the instance for it. `GET`/`POST /v1/account/demo`, `GET /v1/admin/demos`.

## DinePOS outlets: sales sync and licence renewals

A DinePOS outlet connected to this hub (the same pairing as its online orders) sends its sales up and fetches licence
renewals (`src/sync.ts`). Neither side needs the other to work: the outlet bills offline and catches up later.

| Endpoint | What |
|---|---|
| `POST /v1/pos/sync/batches` (device key) | `{streamId, fromSeq, events[]}`: the outlet's outbox (`day.closed`, `bill.printed`, `bill.settled`, `bill.voided`) numbered by its own `seq`. Returns `{ackSeq}`, the highest number held. Resending is harmless; a gap (409 `SYNC_GAP`, with `ackSeq`) makes the outlet resend; a different record under a number already held is 409 `SYNC_CONFLICT` |
| `GET /v1/pos/licence` (device key) | `{key, updatedAt}`: the licence key the vendor put here, or `null` |
| `GET /v1/admin/stores/<slug>/sales?days=14` | business days, newest first: a closed day from its Z report, an open day added up from its bills |
| `GET`/`PUT /v1/admin/stores/<slug>/licence` | `{key}` puts a renewed key here (empty removes it); the hub only reads what the key says about itself, the POS verifies it |

Each outlet database is its own stream (`streamId`), so a reinstalled or restored POS never overwrites what an earlier
one sent; the sales view counts each bill and each business day once. The admin store page shows both.

## Swiggy and Zomato (through UrbanPiper)

Orders from Swiggy and Zomato come through UrbanPiper (`src/urbanpiper.ts`; their guide: https://api-docs.urbanpiper.com/downstream).
One UrbanPiper account serves all stores. On the admin page:

1. **Hub settings > Swiggy & Zomato (UrbanPiper account)**: the test account (pos-int.urbanpiper.com) until UrbanPiper
   certifies the setup, then the live address from their certification email; **API username, API key, Biz ID** from
   UrbanPiper's sandbox email (or the Postman collection's `Authorization: apikey <username>:<key>` and `X-UPR-Biz-Id`
   headers). The key stays on the hub and is never shown again. **Save account**, **Test connection** (lists the
   account's webhooks; changes nothing), **Set up order links** (registers `/v1/urbanpiper/<Biz ID>` for 9 webhook
   events with a secret header, for all stores; UrbanPiper allows 5 calls a minute, so this takes about 2 minutes; refused
   while the hub runs on localhost, which UrbanPiper cannot reach).
2. **Each store** (Stores > the store > Swiggy & Zomato): its own **Store ID at UrbanPiper** (the hub store address by
   default; one per store), city, address, phone, Swiggy and/or Zomato, packaging charge, on/off. **Save store details**,
   **Send store details**, **Send menu**.

`npm run urbanpiper-sample -- <store> [swiggy|zomato] [--self] [--cash]` sends a sample order into a hub on this PC, as
UrbanPiper would (development only).

Then:
- **Orders** arrive like website orders, numbered S-… (Swiggy) and Z-… (Zomato), priced from the published menu at the
  channel price (the POS bill); the platform's order number, OTP, total, charges, discounts and notes travel with it.
  The same order sent twice makes one order. Unknown stores and other platforms are refused with 422 (not retried).
- **Accept / Ready / Out for delivery / Delivered / Reject / Cancel** in the POS go back as order status updates
  (Acknowledged with the preparation time for Zomato, Food Ready, Dispatched with the rider, Completed, Cancelled with a
  reason code). When the platform's rider delivers, only the platform marks the order picked up and delivered.
- **From the platform**: cancellations (also after accepting: the POS asks to cancel the bill), the rider's name, phone
  and progress, and pickup and delivery.
- **After the first "Send menu"**: menu changes from the POS are sent by themselves; items sold out or back on, and the
  store not taking orders (no shift, or paused here), switch them off and on at Swiggy and Zomato.
- **Requests from the ODS about one order**: Swiggy, before the food is ready: **Item out of stock** (Swiggy asks the
  customer to change the order and the store gets the customer's masked number and a PIN, or the order is cancelled).
  Zomato: **Customer's number**, **Ask for another rider** (bulk orders only) and **Rider check** (temperature, mask).
  The platform's answers, and any request UrbanPiper refuses, appear on the order.
- **Packaging charge on Swiggy and Zomato** (in the card): none, rupees per item, or a percentage of the item price; sent
  with the menu as an item-level charge (both platforms take only that). GST on it is set in Atlas (Zomato) or by the
  Swiggy contact. Cess stays inside the item price (UrbanPiper has GST taxes only).
- Calls to UrbanPiper go through an outbox that retries while UrbanPiper cannot be reached or is busy. Everything sent
  and received is listed under **Activity** on the store's page.
- The menu is checked against the platforms' rules first (unique names, Zomato ignoring numbers in names, descriptions,
  meat named in non-veg items, offer and alcohol words, veg marking). Prices that include GST are sent without it, with
  CGST and SGST as taxes, so the customer pays the POS price.

Needs the hub on the internet with an https address (UrbanPiper sends orders to it). Not tested against UrbanPiper's
real test account yet (docs/HARDWARE_TEST_PLAN.md).

## What the hub already handles

- Orders placed while the shop's internet is down wait on the hub. The POS collects them when it reconnects.
- An order that was not accepted in time is rejected automatically and the customer is told.
- The same order cannot be sent twice (idempotency keys).
- Cash on delivery needs a verified mobile (OTP).
- A changed price is refused before the order is placed.
- A store that is closed, offline or not accepting (no shift open) gets no orders.
- When a customer cancels just as the shop accepts, the POS flags the bill for cancelling.

See `docs/ONLINE_ORDERS_PLAN.md` for the failure cases (F1 to F13).

## Not built yet

- SMS for OTP.
- The payment gateway (online payment).
- Hosting the hub (and backups of the hub database itself, including the shops' online backups).
- The store apps (the demo page stands in for them).
- Swiggy/Zomato: category timing groups (menu sections for certain hours).
- More than one hub process: one process per database for now.
- Telling the POS when the hub admin pauses its store (the ODS still shows "accepting").
- Admin accounts: one shared admin key, no per-person logins or audit log.

Tests: `npm test` (from `hub/`) or `node --test --test-concurrency=1 hub/test/*.test.ts` from the repo root.

## Website builder

The ordering website's `/admin` page is a website builder: the shop signs in with its **website editor password**
(made on the admin page or with `npm run admin -- site-password <slug>`; it works for that store only) and designs the
website beside a live preview: theme (colours, fonts, corners, buttons, header; ready-made looks), logo, tab icon,
Google title and description, share picture, contact and social links, how dishes show (cards or list, photos,
descriptions, veg marks, category buttons), an announcement bar, and the home page as sections it can add, reorder,
hide and edit: hero, featured dishes, menu (always one), about, gallery, reviews, opening hours, contact and map, FAQ,
text. Photos are uploaded to the hub (made smaller in the browser first). Changes are saved as a **draft**; **Publish**
makes them live (customers get the design with the store, `site` in `GET /v1/stores/<slug>`). The menu, prices, item
photos and opening hours still come from the POS.

Every saved design is checked field by field (`src/site.ts`): unknown fields and wrong values are refused, and a broken
saved design falls back to the standard one. Calls (CORS, `X-Site-Token` from the sign-in, 30 days):
`POST /v1/site/<slug>/login` (`{ password }`, 10 per minute per address), `POST /v1/site/<slug>/logout`,
`GET /v1/site/<slug>` (draft, published, unpublished), `PUT /v1/site/<slug>/draft` (`{ site }`),
`POST /v1/site/<slug>/publish`, `POST /v1/site/<slug>/discard`, `PUT /v1/site/<slug>/images/<sha256>.<jpg|png|webp>`
(`{ dataBase64 }`, the same checks as POS menu photos; the design refers to it as `hub:<name>`).

## Brand website: orders go to the nearest outlet (P6-05)

A store's own page (`/order/<store>`) sends every order to that store. A **brand** is one ordering website for several
outlets: `/order/<brand>`. Make it on the admin page (**Brands**: add a brand, then add its outlets; a store is in one
brand at most, and brand and store addresses never clash).

- The customer chooses pickup or delivery and gives their location first.
- **Delivery** goes to the nearest outlet that can take it right now: POS online, shift open, not paused, inside its
  opening hours, delivery on, and the address inside its delivery bands. If the nearest cannot, the next nearest is
  tried. **Pickup** goes to the nearest open outlet that offers pickup.
- Distance is by road when the hub has a routing server (Hub settings), otherwise straight line × the outlet's road
  factor: the same distance its delivery bands use.
- The customer then sees the chosen outlet's name and distance, and orders from **its own menu, prices, GST and fees**.
  If the address or pickup/delivery changes, the outlet is chosen again; cart items the new outlet does not sell are
  taken out and the customer is told.
- The order is placed in that outlet exactly like a store-page order. If the choice changed after the customer saw it
  (an outlet closed or opened), nothing is placed (`OUTLET_CHANGED`) and the page shows the new outlet. A placed order
  never moves to another outlet.
- No outlet can take it: the customer sees "no outlet delivers here right now" (or "is open for pickup"), and the admin
  page lists a failed attempt (`NO_OUTLET`) under the brand's main outlet.
- The website design is the **main outlet's** (the first outlet added; **Make main** changes it), made in that outlet's
  website builder.

Calls: admin (`X-Admin-Key`) `GET /v1/admin/brands`, `POST /v1/admin/brands` (`{ slug, name }`),
`GET /v1/admin/brands/<brand>`, `PUT|DELETE /v1/admin/brands/<brand>/stores/<store>` (add or take out; the store and its
orders are untouched), `PUT /v1/admin/brands/<brand>/main` (`{ store }`). Customers (CORS): `GET /v1/brands/<brand>`
(name, design, outlets), `POST /v1/brands/<brand>/outlet` (`{ fulfilment, location }` → the outlet's store page and
distance, or `NO_OUTLET`), `POST /v1/brands/<brand>/orders` (the store-page order body plus `store`, the outlet shown,
and `near`, the customer's location for pickup; `Idempotency-Key` as for store orders). Code: `src/brands.ts`.

## DinePOS add-on guest pages (relay)

DinePOS add-ons such as Table QR can let guests on mobile data reach their pages through the hub:
`<hub>/s/<store>/a/<addon>/...` (`src/relay.ts`). The hub stores nothing. It sends each request down the store's own POS
event stream as a `guest.request` event (no event number, never replayed). The POS answers with
`POST /v1/pos/relay/:id`, and the hub passes that answer back to the phone with a strict content policy.

- If no POS is connected, the guest gets "The restaurant's system is not connected right now" (503).
- If the POS does not answer within 15 s, the guest gets "did not answer in time" (504).
- Limits: 240 requests a minute per address, and at most 40 waiting requests per store.
- The page and its script and style files are kept for a minute.

## Devices from anywhere (P6-02)

Each outlet has its own address, `https://<store>.<cloud address>`, for example `https://spice-garden.3-6-30-45.sslip.io`
or `https://spice-garden.cloud.yourbrand.in`. Captain phones, kitchen screens and terminals use it exactly like the
outlet PC's LAN address, but from anywhere.

- The outlet's main PC keeps one outgoing WebSocket to `/v1/pos/tunnel`, authorised with its device key. Every request
  and live stream for the outlet's address goes down it (`src/tunnel.ts`; `src/ws.ts` is the small WebSocket server).
  Nothing is stored here.
- Caddy makes each outlet address's HTTPS certificate on demand, only after `/v1/tls-ask` confirms the store (see the
  Caddyfile written by `posinext-cloud-domain`). With your own domain, add a wildcard DNS record `*.cloud.yourbrand.in`
  pointing at the server too.
- `HUB_DEVICE_DOMAIN` overrides the base name (default: the host of `HUB_PUBLIC_URL`).
- If the PC is not connected, devices get a clear 503: the outlet's own network still works.
- On the outlet PC: **Settings › Cloud sync › Devices from anywhere**, switch on. It shows the outlet's address and how
  to set up each kind of device.

## Hosted outlets: no main PC (P6-04)

An outlet can run entirely in the cloud. Its DinePOS server runs on this machine: one process and one database per
outlet, in `<HUB_DATA_DIR>/outlets/<store id>/`, listening on 127.0.0.1 only. Devices use `https://<store>.<cloud>`
exactly as with a main PC. Billing needs the internet at the outlet. Printers need a DinePOS Print Agent on a PC at the
outlet (P6-03).

1. On the admin page, open the store and choose **DinePOS in the cloud › Run this outlet in the cloud**.
2. **First step:** enter the outlet name, the owner's name and the owner's PIN.
3. On the outlet's first terminal, set the server address to `https://<store>.<cloud>`. It shows a pairing code: enter
   it on the admin page with the owner's PIN. Later devices are approved on that terminal (Settings › Devices).
4. **Licence:** in DinePOS, Settings › Licence shows this outlet's own hardware id. Make its key with the keygen as
   usual. Each hosted outlet needs its own key.
5. **Printers:** add a print agent (Settings › Kitchen & printers) and install DinePOS Print Agent on a PC by the
   printers, with the server address `https://<store>.<cloud>`.

- The server it runs is `cloud/outlet-server` (`HUB_OUTLET_SERVER` overrides). Rebuild it with
  `npm run bundle:cloud -w @dinepos/server` whenever DinePOS changes, and commit it; `posinext-cloud-update` brings it here.
- **Stop running in the cloud** stops the outlet's server and keeps its data. Running it again carries on.
- Back up `<HUB_DATA_DIR>/outlets` with the cloud's data (the daily copy covers the cloud's own database only). Each
  outlet's DinePOS server also keeps its own backups in its data folder.

## Backups off the server

Every hour, `deploy/backup.sh` (run by `/etc/cron.hourly/posinext-cloud-backup`) does three things:
- copies the cloud's own database into `/var/backups/posinext-cloud`, one copy a day;
- copies each hosted outlet's newest DinePOS backup into `.../outlets/<store id>/`;
- keeps 14 days of copies there.

A copy on the same server is lost with the server. To copy them off it:

1. Create an S3 bucket (for example `yourbrand-dinepos-backups`, in the same region, with public access blocked).
2. **EC2 › the instance › Actions › Security › Modify IAM role:** give it a role whose policy allows `s3:PutObject`,
   `s3:ListBucket` and `s3:GetObject` on that bucket.
3. In `/etc/posinext-cloud.env`, set `HUB_S3_BUCKET=yourbrand-dinepos-backups`.

From the next hour, everything is copied to `s3://<bucket>/posinext-cloud/`, so losing the server loses at most an hour.
The result of each run is in `<data>/backup-status.json`. The admin page warns while backups fail, or stay on the server
only. For extra safety, also turn on daily EBS snapshots (**EC2 › Lifecycle Manager**).

Servers installed before this change: run the one-line installer again. It keeps the key, the settings and the data, adds
the hourly job and the AWS CLI, and removes the old daily job. Then add the `HUB_S3_BUCKET=` and `HUB_ALERT_WEBHOOK=`
lines to `/etc/posinext-cloud.env` yourself.

## Monitoring and alerts

- `GET /health/deep` answers 503 while a hosted outlet is down (more than a minute) or backups fail or have not run for
  two hours. It names the problems, and lists store addresses only, no data. Point a free uptime service at it, for
  example UptimeRobot with an HTTP(s) monitor on `https://<cloud>/health/deep`, to get an email or SMS when it is not 200.
- `HUB_ALERT_WEBHOOK=<Slack, Discord or Google Chat webhook>` in `/etc/posinext-cloud.env` posts each new problem, a
  reminder every 6 hours while it lasts, and "resolved" when it is fixed (`src/monitor.ts`).
- The admin page shows the same problems at the top.

