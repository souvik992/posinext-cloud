#!/bin/bash
# Points Caddy at PosiNext Cloud and sets HUB_PUBLIC_URL. Run as root by `posinext-cloud-domain` (install.sh) after the
# addresses in /etc/posinext-cloud.env change. In the repository, so `posinext-cloud-update` brings fixes.
#
# HUB_CADDY_MODE=own (default): this hub owns /etc/caddy/Caddyfile: HUB_DOMAIN (else <public-ip>.sslip.io), and
#   <store>.<domain> for outlet devices with on-demand certificates (P6-02).
# HUB_CADDY_MODE=import: another hub on this server (e.g. the Tiffin order hub) owns the Caddyfile. This hub's sites
#   go in /etc/caddy/posinext-cloud.caddy, which the Caddyfile imports (one line, added if missing): HUB_DOMAIN (else
#   cloud-<public-ip>.sslip.io) and HUB_PORTAL_DOMAIN (else portal-<public-ip>.sslip.io). No outlet device addresses.
#   (Dashes, not dots: the other hub serves *.<public-ip>.sslip.io with on-demand certificates that only it approves,
#   so cloud.<public-ip>.sslip.io would never get a certificate.)
#   The other hub's sites are never rewritten, and a config Caddy does not accept is rolled back before reloading.
#   If the other hub rewrites its Caddyfile later, run posinext-cloud-domain again to put the import line back.
#
# For tests: POSINEXT_ENV, CADDY_DIR, PUBLIC_IP, CADDY_VALIDATE and RELOAD override the real paths and commands.
set -euo pipefail
ENV="${POSINEXT_ENV:-/etc/posinext-cloud.env}"
CADDY_DIR="${CADDY_DIR:-/etc/caddy}"
CADDYFILE="$CADDY_DIR/Caddyfile"
OURS="$CADDY_DIR/posinext-cloud.caddy"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
validate() { # prints Caddy's complaint on failure
  if [ -n "${CADDY_VALIDATE:-}" ]; then eval "$CADDY_VALIDATE"; else caddy validate --adapter caddyfile --config "$CADDYFILE"; fi
}
reload() {
  if [ -n "${RELOAD:-}" ]; then eval "$RELOAD"; return; fi
  systemctl restart posinext-cloud
  systemctl reload caddy || systemctl restart caddy
}
. "$ENV"
port="${HUB_PORT:-4900}"
mode="${HUB_CADDY_MODE:-own}"
ip_dashed() { local ip="${PUBLIC_IP:-$(curl -fsS https://api.ipify.org)}"; echo "${ip//./-}"; }
set_env() { # set_env NAME VALUE: replace or add one line
  sed -i "/^$1=/d" "$ENV"
  echo "$1=$2" >> "$ENV"
}

backup=$(mktemp -d)
trap 'rm -rf "$backup"' EXIT
[ -f "$CADDYFILE" ] && cp -p "$CADDYFILE" "$backup/Caddyfile"
[ -f "$OURS" ] && cp -p "$OURS" "$backup/ours"
restore() {
  if [ -f "$backup/Caddyfile" ]; then cp -p "$backup/Caddyfile" "$CADDYFILE"; else rm -f "$CADDYFILE"; fi
  if [ -f "$backup/ours" ]; then cp -p "$backup/ours" "$OURS"; else rm -f "$OURS"; fi
}

if [ "$mode" = "import" ]; then
  domain="${HUB_DOMAIN:-}"
  portal="${HUB_PORTAL_DOMAIN:-}"
  if [ -z "$domain" ] || [ -z "$portal" ]; then
    d=$(ip_dashed)
    [ -z "$domain" ] && domain="cloud-$d.sslip.io"
    [ -z "$portal" ] && { portal="portal-$d.sslip.io"; set_env HUB_PORTAL_DOMAIN "$portal"; }
  fi
  cat > "$OURS" <<EOF
# PosiNext Cloud (hub/deploy/domain.sh). Imported by the Caddyfile, which another hub on this server owns.
$domain {
  encode gzip
  reverse_proxy 127.0.0.1:$port {
    flush_interval -1
  }
}
EOF
  touch "$CADDYFILE"
  grep -qxF "import $OURS" "$CADDYFILE" || printf '\n# PosiNext Cloud, alongside (its sites are in that file)\nimport %s\n' "$OURS" >> "$CADDYFILE"
else
  domain="${HUB_DOMAIN:-}"
  [ -z "$domain" ] && domain="$(ip_dashed).sslip.io"
  cat > "$CADDYFILE" <<EOF
# P6-02: each outlet's device address <store>.$domain gets its own certificate on demand, only for stores the
# cloud knows (it answers /v1/tls-ask).
{
  on_demand_tls {
    ask http://127.0.0.1:$port/v1/tls-ask
  }
}
$domain {
  encode gzip
  reverse_proxy 127.0.0.1:$port {
    flush_interval -1
  }
}
*.$domain {
  tls {
    on_demand
  }
  encode gzip
  reverse_proxy 127.0.0.1:$port {
    flush_interval -1
  }
}
EOF
  # HUB_EXTRA_DOMAINS (comma-separated, no spaces): addresses this cloud also answers, e.g. the Tiffin order hub's after
  # merge-tiffin.sh, so its paired POS PCs, customers' ordering pages and UrbanPiper webhooks keep working.
  extra_list="${HUB_EXTRA_DOMAINS:-}"
  for extra in ${extra_list//,/ }; do
    cat >> "$CADDYFILE" <<EOF
# an address of a hub merged into this cloud (deploy/merge-tiffin.sh)
$extra {
  encode gzip
  reverse_proxy 127.0.0.1:$port {
    flush_interval -1
  }
}
EOF
  done
fi

# the customer portal's site (portal.sh appends it to this hub's Caddy file)
POSINEXT_ENV="$ENV" CADDY_DIR="$CADDY_DIR" NO_RELOAD=1 bash "$HERE/portal.sh" --caddy-only || true

if ! out=$(validate 2>&1); then
  restore
  echo "Caddy did not accept the new configuration; it was put back as it was. Nothing changed." >&2
  printf '%s\n' "$out" | tail -5 >&2
  exit 1
fi
set_env HUB_PUBLIC_URL "https://$domain"
reload
echo "Hub address: https://$domain  (admin page: https://$domain/admin)"
if [ "$mode" = "import" ]; then echo "Portal address: https://$(grep '^HUB_PORTAL_DOMAIN=' "$ENV" | tail -1 | cut -d= -f2-)"; fi
