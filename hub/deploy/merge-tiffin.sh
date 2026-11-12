#!/bin/bash
# Moves the Tiffin order hub into PosiNext Cloud on the same server (decided 2026-11-12: one hub for every product).
# Run as root after install.sh, on the server where both run (tiffin-hub.service and posinext-cloud.service):
#   sudo bash /opt/posinext-cloud/hub/deploy/merge-tiffin.sh            (shows a dry run, then asks to go ahead)
#   sudo bash /opt/posinext-cloud/hub/deploy/merge-tiffin.sh --yes      (no question)
#
# What it does:
#   1. a dry run of the import (nothing changes) and its report: stores, devices, orders, renamed addresses, UrbanPiper
#   2. stops both hubs and copies both databases to /var/backups/posinext-cloud/merge-<time>/ (the way back)
#   3. imports the Tiffin hub's database and its stores' online backups into PosiNext Cloud
#   4. PosiNext Cloud takes over /etc/caddy/Caddyfile and also answers the Tiffin hub's address (HUB_EXTRA_DOMAINS), so
#      paired Tiffin POS PCs, customers' ordering pages and UrbanPiper webhooks keep working with no change on their side
#   5. switches the Tiffin hub off (its files stay) and starts PosiNext Cloud
# Then: in the PosiNext Cloud admin page, Hub settings > UrbanPiper > Set up order links (moves the webhooks to the
# new secret header), and check the stores listed as renamed.
#
# Tiffin hub on a different server: copy its /var/lib/tiffin-hub here first (stop it, then rsync -a), set
# TIFFIN_DATA to that folder and TIFFIN_ADDRESS to its domain, and point that domain's DNS at this server afterwards.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run it with sudo." >&2; exit 1; fi
say() { printf '\n==> %s\n' "$*"; }
YES=0; [ "${1:-}" = "--yes" ] && YES=1

CLOUD_ENV=/etc/posinext-cloud.env
TIFFIN_ENV=/etc/tiffin-hub.env
[ -f "$CLOUD_ENV" ] || { echo "PosiNext Cloud is not installed here (no $CLOUD_ENV). Run install.sh first." >&2; exit 1; }
# shellcheck disable=SC1090
. "$CLOUD_ENV"
CLOUD_DATA="${HUB_DATA_DIR:-/var/lib/posinext-cloud}"
CLOUD_URL="${HUB_PUBLIC_URL:-}"
TIFFIN_DATA="${TIFFIN_DATA:-/var/lib/tiffin-hub}"
TIFFIN_ADDRESS="${TIFFIN_ADDRESS:-}"
if [ -z "$TIFFIN_ADDRESS" ] && [ -f "$TIFFIN_ENV" ]; then
  TIFFIN_ADDRESS=$(grep -E '^HUB_PUBLIC_URL=' "$TIFFIN_ENV" | tail -1 | cut -d= -f2- | sed -E 's#^https?://##; s#/.*$##')
fi
[ -f "$TIFFIN_DATA/hub.db" ] || { echo "No Tiffin hub database at $TIFFIN_DATA/hub.db (set TIFFIN_DATA)." >&2; exit 1; }
[ -n "$TIFFIN_ADDRESS" ] || { echo "The Tiffin hub's address is not known: set TIFFIN_ADDRESS (e.g. orders.example.in)." >&2; exit 1; }
CLOUD_HOST=$(printf '%s' "$CLOUD_URL" | sed -E 's#^https?://##; s#/.*$##')
HUB=/opt/posinext-cloud/hub

say "Dry run (nothing changes yet)"
node "$HUB/scripts/import-hub.ts" --from "$TIFFIN_DATA" --to "$CLOUD_DATA" --dry-run
echo
echo "  PosiNext Cloud keeps its address ${CLOUD_HOST:-(none set yet)} and also answers ${TIFFIN_ADDRESS}."
if [ "$YES" != "1" ]; then
  read -r -p "Go ahead? Both hubs stop for about a minute. Type MERGE: " answer
  [ "$answer" = "MERGE" ] || { echo "Nothing changed."; exit 0; }
fi

say "Stopping both hubs and keeping copies of both databases"
STAMP=$(date +%Y%m%d-%H%M%S)
KEEP=/var/backups/posinext-cloud/merge-$STAMP
install -d -m 0700 "$KEEP"
systemctl stop tiffin-hub 2>/dev/null || true
systemctl stop posinext-cloud
sqlite3 "$TIFFIN_DATA/hub.db" ".backup '$KEEP/tiffin-hub.db'"
[ -f "$CLOUD_DATA/hub.db" ] && sqlite3 "$CLOUD_DATA/hub.db" ".backup '$KEEP/posinext-cloud.db'"
cp -p "$CLOUD_ENV" "$KEEP/posinext-cloud.env"
[ -f /etc/caddy/Caddyfile ] && cp -p /etc/caddy/Caddyfile "$KEEP/Caddyfile"
echo "  Copies in $KEEP"

say "Importing the Tiffin hub"
if ! node "$HUB/scripts/import-hub.ts" --from "$TIFFIN_DATA" --to "$CLOUD_DATA" | tee "$KEEP/import-report.txt"; then
  echo "The import stopped; nothing was imported. Starting both hubs again as they were." >&2
  systemctl start posinext-cloud; systemctl start tiffin-hub 2>/dev/null || true
  exit 1
fi
chown -R posinextcloud:posinextcloud "$CLOUD_DATA"

say "Addresses: PosiNext Cloud takes over the Caddyfile and answers the Tiffin hub's address too"
set_env() { sed -i "/^$1=/d" "$CLOUD_ENV"; echo "$1=$2" >> "$CLOUD_ENV"; }
[ -n "$CLOUD_HOST" ] && [ -z "${HUB_DOMAIN:-}" ] && set_env HUB_DOMAIN "$CLOUD_HOST"
extras="$(grep -E '^HUB_EXTRA_DOMAINS=' "$CLOUD_ENV" | tail -1 | cut -d= -f2- || true)"
case ",$extras," in *",$TIFFIN_ADDRESS,"*) ;; *) extras="${extras:+$extras,}$TIFFIN_ADDRESS" ;; esac
set_env HUB_EXTRA_DOMAINS "$extras"
set_env HUB_CADDY_MODE own

say "Switching the Tiffin hub off (its files stay) and starting PosiNext Cloud"
systemctl disable tiffin-hub 2>/dev/null || true
/usr/local/bin/posinext-cloud-domain

cat <<EOF

Done. PosiNext Cloud now serves the Tiffin stores too, at ${CLOUD_HOST:-its address} and ${TIFFIN_ADDRESS}.
Next, in the PosiNext Cloud admin page:
  - Hub settings > UrbanPiper > Set up order links (moves Swiggy/Zomato webhooks to PosiNext Cloud's own secret)
  - check any store listed as renamed above, and tell that shop its new ordering page address
The way back (if something is wrong):
  sudo systemctl stop posinext-cloud
  sudo cp -p $KEEP/posinext-cloud.db $CLOUD_DATA/hub.db && sudo cp -p $KEEP/posinext-cloud.env $CLOUD_ENV && sudo cp -p $KEEP/Caddyfile /etc/caddy/Caddyfile
  sudo systemctl enable --now tiffin-hub && sudo systemctl start posinext-cloud && sudo systemctl reload caddy
EOF
