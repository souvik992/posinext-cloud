#!/bin/bash
# Installs (or repairs) the PosiNext Cloud on a fresh Ubuntu 24.04 server (AWS EC2, Oracle, any VPS), in one go:
#   curl -fsSL https://raw.githubusercontent.com/souvik992/posinext-cloud/main/hub/deploy/install.sh | sudo bash
# The same as the cloud-init files next to it, for a server that was started without them. Safe to run again: it keeps
# the admin key, the settings and the data, and updates the hub. Ports 80 and 443 must be open to the internet.
#
# Alongside another hub (e.g. the Tiffin order hub on the same server: port 4900, owns /etc/caddy/Caddyfile): found
# automatically (tiffin-hub.service), or forced with HUB_ALONGSIDE=1. Then PosiNext Cloud uses port 4910 and keeps its
# Caddy sites in /etc/caddy/posinext-cloud.caddy, which the Caddyfile only imports (see deploy/domain.sh).
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run it with sudo." >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
say() { printf '\n==> %s\n' "$*"; }

say "Packages (git, curl, sqlite3)"
apt-get update -q
apt-get install -y -q git curl sqlite3 debian-keyring debian-archive-keyring apt-transport-https gnupg ca-certificates

if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  say "Node 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v aws >/dev/null && command -v snap >/dev/null; then
  say "AWS CLI (off-server backups to S3)"
  snap install aws-cli --classic || echo "AWS CLI not installed: backups stay on this server."
fi

if ! command -v caddy >/dev/null; then
  say "Caddy (HTTPS)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

# A server that runs DinePOS Cloud (the name before 2026-11-12) becomes PosiNext Cloud: same settings, admin key,
# data, backups and Caddy sites, under the new names. Once only: afterwards /etc/dinepos-cloud.env is gone.
MOVED=0
if [ -f /etc/dinepos-cloud.env ] && [ ! -f /etc/posinext-cloud.env ]; then
  say "DinePOS Cloud becomes PosiNext Cloud (same data and admin key)"
  systemctl stop dinepos-cloud 2>/dev/null || true
  systemctl disable dinepos-cloud 2>/dev/null || true
  sed -e 's#/var/lib/dinepos-cloud#/var/lib/posinext-cloud#g' -e 's#dinepos-cloud\.caddy#posinext-cloud.caddy#g' /etc/dinepos-cloud.env > /etc/posinext-cloud.env
  chmod 600 /etc/posinext-cloud.env
  if [ -d /var/lib/dinepos-cloud ] && [ ! -e /var/lib/posinext-cloud ]; then mv /var/lib/dinepos-cloud /var/lib/posinext-cloud; fi
  if [ -d /var/backups/dinepos-cloud ] && [ ! -e /var/backups/posinext-cloud ]; then mv /var/backups/dinepos-cloud /var/backups/posinext-cloud; fi
  if [ -f /etc/caddy/dinepos-cloud.caddy ]; then
    mv /etc/caddy/dinepos-cloud.caddy /etc/caddy/posinext-cloud.caddy
    [ -f /etc/caddy/Caddyfile ] && sed -i 's#/etc/caddy/dinepos-cloud\.caddy#/etc/caddy/posinext-cloud.caddy#; s#DinePOS Cloud#PosiNext Cloud#' /etc/caddy/Caddyfile
  fi
  rm -f /etc/systemd/system/dinepos-cloud.service /usr/local/bin/dinepos-cloud-domain /usr/local/bin/dinepos-cloud-update \
        /etc/cron.hourly/dinepos-cloud-backup /etc/cron.daily/dinepos-cloud-backup
  mv /etc/dinepos-cloud.env /etc/dinepos-cloud.env.moved # kept for reference; nothing reads it
  MOVED=1
fi

say "Settings"
ALONGSIDE=0
if [ "${HUB_ALONGSIDE:-}" = "1" ] || [ -f /etc/systemd/system/tiffin-hub.service ]; then ALONGSIDE=1; fi
NEW_KEY=""
if [ ! -f /etc/posinext-cloud.env ]; then
  NEW_KEY=$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
  if [ "$ALONGSIDE" = "1" ]; then
    PORT=4910; MODE=import
    echo "Another hub runs on this server: PosiNext Cloud goes alongside it (port 4910, its own Caddy file)."
  else
    PORT=4900; MODE=own
  fi
  cat > /etc/posinext-cloud.env <<EOF
HUB_ADMIN_KEY=$NEW_KEY
HUB_HOST=127.0.0.1
HUB_PORT=$PORT
# own: this hub writes /etc/caddy/Caddyfile. import: another hub owns it; this hub's sites are in /etc/caddy/posinext-cloud.caddy
HUB_CADDY_MODE=$MODE
HUB_DATA_DIR=/var/lib/posinext-cloud
# Set to your own domain (e.g. hub.example.in) once its DNS points at this server, then run posinext-cloud-domain.
HUB_DOMAIN=
# Off-server backups: an S3 bucket name (the server needs an IAM role that may write to it). Empty: backups stay here.
HUB_S3_BUCKET=
# Alerts (hosted outlet down, backup failed): a Slack, Discord or Google Chat webhook address. Empty: no alerts.
HUB_ALERT_WEBHOOK=
EOF
  chmod 600 /etc/posinext-cloud.env
fi

cat > /etc/systemd/system/posinext-cloud.service <<'EOF'
[Unit]
Description=PosiNext Cloud
After=network-online.target
Wants=network-online.target

[Service]
User=posinextcloud
EnvironmentFile=/etc/posinext-cloud.env
Environment=NODE_ENV=production
WorkingDirectory=/opt/posinext-cloud/hub
ExecStart=/usr/bin/node src/main.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/posinext-cloud

[Install]
WantedBy=multi-user.target
EOF

# Points Caddy at the hub's address and sets HUB_PUBLIC_URL (deploy/domain.sh: in the repository, so updates reach it).
cat > /usr/local/bin/posinext-cloud-domain <<'SCRIPT'
#!/bin/bash
exec /bin/bash /opt/posinext-cloud/hub/deploy/domain.sh "$@"
SCRIPT
chmod 755 /usr/local/bin/posinext-cloud-domain

# Downloads the latest hub from GitHub and restarts it.
cat > /usr/local/bin/posinext-cloud-update <<'SCRIPT'
#!/bin/bash
set -euo pipefail
git -C /opt/posinext-cloud fetch --depth 1 origin main
git -C /opt/posinext-cloud reset --hard origin/main
bash /opt/posinext-cloud/hub/deploy/portal.sh || echo "Portal not updated; the hub is."
systemctl restart posinext-cloud
echo "Hub updated to $(git -C /opt/posinext-cloud log -1 --format='%h %s')"
SCRIPT
chmod 755 /usr/local/bin/posinext-cloud-update

# Daily copy of the hub database, last 14 days kept.
# Every hour: the cloud's database and each hosted outlet's newest backup, kept 14 days here, and copied to S3 when
# HUB_S3_BUCKET is set (deploy/backup.sh in the repository, so updates reach it).
rm -f /etc/cron.daily/posinext-cloud-backup
cat > /etc/cron.hourly/posinext-cloud-backup <<'SCRIPT'
#!/bin/bash
exec /bin/bash /opt/posinext-cloud/hub/deploy/backup.sh
SCRIPT
chmod 755 /etc/cron.hourly/posinext-cloud-backup

say "The hub"
id posinextcloud >/dev/null 2>&1 || useradd --system --home /var/lib/posinext-cloud --shell /usr/sbin/nologin posinextcloud
install -d -o posinextcloud -g posinextcloud -m 0750 /var/lib/posinext-cloud
# data moved from DinePOS Cloud belongs to the old service user: hand it over
if [ "$MOVED" = "1" ]; then chown -R posinextcloud:posinextcloud /var/lib/posinext-cloud; fi
if [ -d /opt/posinext-cloud/.git ]; then
  git -C /opt/posinext-cloud fetch --depth 1 origin main
  git -C /opt/posinext-cloud reset --hard origin/main
  bash /opt/posinext-cloud/hub/deploy/portal.sh || echo "Portal not updated; the hub is."
else
  git clone --depth 1 https://github.com/souvik992/posinext-cloud.git /opt/posinext-cloud
  bash /opt/posinext-cloud/hub/deploy/portal.sh || echo "Portal not installed yet; run posinext-cloud-update later."
fi
systemctl daemon-reload
systemctl enable posinext-cloud
systemctl enable caddy

say "Address and HTTPS"
/usr/local/bin/posinext-cloud-domain
sleep 2
if systemctl is-active --quiet posinext-cloud; then echo "The hub is running."; else echo "The hub did not start: see journalctl -u posinext-cloud -n 50"; fi

if [ -n "$NEW_KEY" ]; then
  printf '\n  Admin key (save it now; it is also in /etc/posinext-cloud.env):\n    %s\n' "$NEW_KEY"
else
  printf '\n  Admin key: unchanged (sudo grep HUB_ADMIN_KEY /etc/posinext-cloud.env shows it).\n'
fi
printf '  The first visit to the admin page can take a minute while the HTTPS certificate is made.\n\n'
