# PosiNext Cloud

One cloud service for every PosiNext product: **Fine Dine** (DinePOS), **Tiffin QSR**, **PosiNext Grocery**,
**PosiNext Apparel** and **PosiNext Pharmacy**. It is DinePOS Cloud and the Tiffin order hub merged into one
(2026-11-12; fine-dine `docs/adr/0008-posinext-cloud.md`).

It holds customer accounts, trials and licence keys, the downloads, the customer portal's backend, online orders (the
store's own website, Swiggy and Zomato through UrbanPiper), sales sync, online backups, the Table QR relay, and hosted
outlets.

| Folder | What |
|---|---|
| `hub/` | The service. Node 24 (type stripping), `node:sqlite`, no runtime dependencies. `hub/README.md` covers what it does, its settings and the admin page. |
| `hub/deploy/` | Server set-up for Ubuntu 24.04 with Caddy and systemd: `install.sh`, the cloud-init files, `domain.sh`, `backup.sh`, `portal.sh` and `merge-tiffin.sh`. |
| `outlet-server/` | The DinePOS server bundle for hosted outlets (Linux). It is built in fine-dine with `npm run bundle:cloud` and committed here. |
| `packages/licensing` | The licence-key library that the cloud signs keys with. Each app keeps its own copy of the checks. |
| `contract/`, `core/` | The online-order contract and the shared money and tax code the hub uses. |

## Working on it

```
cd hub
npm run dev     # a local hub with a sample store; prints a POS connection link and the admin key
npm test
```

The POS repositories (fine-dine, pos-backend) test against this repository when it is checked out next to them, or at
`POSINEXT_CLOUD_DIR`. Without it, their hub tests are skipped.

## A new server

```
curl -fsSL https://raw.githubusercontent.com/souvik992/posinext-cloud/main/hub/deploy/install.sh | sudo bash
```

## Moving the servers that run today

1. **DinePOS Cloud:** run the same `install.sh` on that server. It moves `/etc/dinepos-cloud.env`, the data, the
   backups and the Caddy sites to the PosiNext Cloud names. The admin key, the stores and the paired devices stay the
   same. It runs once; afterwards the old env file is `/etc/dinepos-cloud.env.moved`.
2. **The Tiffin order hub** (live): on the server where both run, as root:
   `bash /opt/posinext-cloud/hub/deploy/merge-tiffin.sh`
   - It starts with a dry run and waits until you type `MERGE`.
   - It stops both hubs and keeps copies of both databases, the env and the Caddyfile in
     `/var/backups/posinext-cloud/merge-<time>/`.
   - It imports the stores, devices, orders, backups and UrbanPiper set-up.
   - PosiNext Cloud then also answers the Tiffin hub's address (`HUB_EXTRA_DOMAINS`), so paired POS PCs, ordering
     pages and webhooks keep working. The old UrbanPiper header and token are still accepted.
   - A store whose address is reserved or already taken gets the address `<slug>-qsr`; the report lists these stores.
   - At the end it prints the steps to go back.

   Afterwards, in the admin page, go to Hub settings › UrbanPiper › Set up order links. This moves the webhooks to the
   new secret.

   If the Tiffin hub runs on another server, copy its `/var/lib/tiffin-hub` across first and set `TIFFIN_DATA` and
   `TIFFIN_ADDRESS`. Point its DNS at this server afterwards.
