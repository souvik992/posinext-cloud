# Hosting the hub on Oracle Cloud (free)

Oracle Cloud's "Always Free" tier includes a small Linux VM that never expires. This puts the hub on it with HTTPS.

## 1. Make the setup file (on the dev PC)

```
node hub/deploy/make-cloud-init.ts
```

It writes `%USERPROFILE%\.dinepos\cloud\oracle-cloud-init.yaml` and the admin key (`admin-key.txt` next to it). Keep
the key safe: it opens the hub admin page.

## 2. Create the Oracle account (owner only)

Sign up at https://signup.cloud.oracle.com. Oracle asks for name, email, mobile OTP and a card (a small hold that is
returned; Always Free resources are never charged). **Home region: India South (Hyderabad) or India West (Mumbai)**;
it cannot be changed later.

## 3. Create the VM

Menu > Compute > Instances > Create instance:

- **Image:** Canonical Ubuntu 24.04.
- **Shape:** Ampere `VM.Standard.A1.Flex` (1 OCPU, 6 GB is plenty), or `VM.Standard.E2.1.Micro` if Ampere says
  "out of capacity". Both are marked "Always Free eligible".
- **Networking:** create a new public subnet, "Assign a public IPv4 address" on.
- **SSH keys:** "Save private key" (keep the file; needed only for repairs).
- **Show advanced options > Management > Cloud-init script:** paste the file from step 1.

## 4. Open ports 80 and 443

Instance page > subnet link > Security List > Add Ingress Rules, twice: source `0.0.0.0/0`, TCP, destination port `80`,
then `443`.

## 5. Check it

About 5 minutes after the VM starts, open `https://<public-ip-with-dashes>.sslip.io/admin` (for IP 140.1.2.3:
`https://140-1-2-3.sslip.io/admin`) and enter the admin key. Create the store there and copy its connection link into
the POS (Settings > Online orders).

## On AWS instead

AWS's free tier runs out (6 months of credits for accounts made since mid-2025, 12 months for older ones; the public
IPv4 address is charged after that), so Oracle above is the free-for-good choice. On AWS:

1. `node hub/deploy/make-cloud-init.ts` writes `aws-cloud-init.yaml` next to the Oracle one (same admin key).
2. EC2 > **Launch instance**, region **Asia Pacific (Mumbai)**:
   - **Image:** Ubuntu Server 24.04. **Type:** the one marked "Free tier eligible" (`t3.micro`).
   - **Key pair:** create one and keep the `.pem` file (only for repairs).
   - **Network settings:** allow SSH from **My IP**, and **HTTP** and **HTTPS** from the internet.
   - **Storage:** 20-30 GB gp3.
   - **Advanced details > User data:** paste `aws-cloud-init.yaml`.
3. EC2 > **Elastic IPs** > Allocate, then Associate it with the instance, so the address never changes. Then over SSH
   (`ssh -i <key>.pem ubuntu@<elastic ip>`) run `sudo posinext-cloud-domain` once to switch to the new address.
4. Open `https://<elastic-ip-with-dashes>.sslip.io/admin` and enter the admin key; continue as in step 5 above.

Set a billing alert (Billing > Budgets) so the end of the free period is not a surprise. Everything under "Later"
works the same.

## On a server that already runs the Tiffin order hub

PosiNext Cloud can share the Tiffin hub's server. The installer finds the Tiffin hub (`tiffin-hub.service`) and goes
alongside it: PosiNext Cloud listens on port **4910** (Tiffin keeps 4900) and its Caddy sites live in
`/etc/caddy/posinext-cloud.caddy`, which Tiffin's `/etc/caddy/Caddyfile` only imports (one line added at the end).
Tiffin's sites are never rewritten, and `deploy/domain.sh` checks the combined config with `caddy validate` before
reloading; if Caddy does not accept it, everything is put back as it was.

1. Over SSH: `curl -fsSL https://raw.githubusercontent.com/souvik992/posinext-cloud/main/hub/deploy/install.sh | sudo bash`
2. It prints the admin key (keep it) and the addresses: `https://cloud-<ip-with-dashes>.sslip.io` (admin, API, uploads)
   and `https://portal-<ip-with-dashes>.sslip.io` (the customer portal). Dashes, not dots: names under
   `*.<ip>.sslip.io` belong to the Tiffin hub's on-demand certificates, which only it approves.
3. Own domains later: set `HUB_DOMAIN=` and `HUB_PORTAL_DOMAIN=` in `/etc/posinext-cloud.env` (DNS pointing at the
   server), then `sudo posinext-cloud-domain`.

Not served alongside: outlet device addresses (`<store>.<domain>`, P6-02). If the Tiffin hub's Caddyfile is ever
rewritten (e.g. `sudo tiffin-hub-domain`), run `sudo posinext-cloud-domain` again to put the import line back.

## Later (over SSH: `ssh -i <key file> ubuntu@<ip>`)

| Task | Command |
|---|---|
| Update the hub to the latest GitHub version | `sudo posinext-cloud-update` |
| Use your own domain | point its DNS A record at the VM, set `HUB_DOMAIN=` in `/etc/posinext-cloud.env`, run `sudo posinext-cloud-domain` |
| Logs | `journalctl -u posinext-cloud -f` |
| Setup log (if the page never comes up) | `sudo cat /var/log/cloud-init-output.log` |

The hub database is copied daily to `/var/backups/posinext-cloud` (14 days kept). That is on the same VM, so it does not
survive losing the VM: copy it elsewhere now and then.

Notes: the free tier stops idle VMs only if CPU stays under 20% for a week *and* the account is "Always Free" only;
upgrading to Pay As You Go (still free for these resources) avoids that. The `sslip.io` address changes if the VM's
public IP changes (only when the VM is deleted and re-created), and paired POS devices would need a new link; a real
domain avoids that.
