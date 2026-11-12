#!/bin/bash
# P8-09 (ADR-0007): the customer portal on this server. Run as root by posinext-cloud-update, posinext-cloud-domain and
# the installer (it lives in the repository, so updates reach it).
#   1. downloads the newest portal build that saas-portal's CI published (GitHub release portal-build-<n>, asset
#      portal-dist.tar.gz) into /opt/posinext-portal (kept as it was when GitHub cannot be reached);
#   2. sets HUB_PORTAL_DIR in /etc/posinext-cloud.env, so the hub serves it;
#   3. when HUB_PORTAL_DOMAIN is set (e.g. portal.posinext.com, DNS pointing at this server), adds that site to Caddy
#      (its own certificate); the hub serves the portal there and the API on the same address.
# --caddy-only: step 3 only (after posinext-cloud-domain rewrote the Caddyfile).
# HUB_CADDY_MODE=import (alongside another hub, deploy/domain.sh): the site goes in /etc/caddy/posinext-cloud.caddy.
# For tests: POSINEXT_ENV, CADDY_DIR; NO_RELOAD=1 leaves reloading Caddy to the caller (domain.sh validates first).
set -euo pipefail
ENV="${POSINEXT_ENV:-/etc/posinext-cloud.env}"
DIR=/opt/posinext-portal
REPO=souvik992/saas-portal
. "$ENV"

if [ "${1:-}" != "--caddy-only" ]; then
  url=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const r = JSON.parse(s).filter((x) => !x.draft && !x.prerelease && x.tag_name.startsWith("portal-build-") && x.published_at)
          .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
          .map((x) => x.assets.find((a) => a.name === "portal-dist.tar.gz")).find(Boolean);
        if (r) console.log(r.browser_download_url);
      } catch { /* GitHub answered something else: keep the portal there is */ }
    });' || true)
  if [ -z "$url" ]; then
    echo "Portal: no published build found (or GitHub unreachable); keeping ${DIR}."
  else
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "$url" -o "$tmp/portal.tar.gz"
    mkdir "$tmp/dist"
    tar -xzf "$tmp/portal.tar.gz" -C "$tmp/dist"
    test -f "$tmp/dist/index.html" || { echo "Portal: the build has no index.html; keeping ${DIR}." >&2; exit 1; }
    chmod -R a+rX "$tmp/dist"
    rm -rf "${DIR}.old"
    if [ -d "$DIR" ]; then mv "$DIR" "${DIR}.old"; fi
    mv "$tmp/dist" "$DIR"
    echo "Portal updated from $url"
  fi
  if ! grep -q '^HUB_PORTAL_DIR=' "$ENV"; then echo "HUB_PORTAL_DIR=$DIR" >> "$ENV"; fi
  if ! grep -q '^HUB_PORTAL_DOMAIN=' "$ENV"; then
    printf '%s\n' '# The customer portal address (e.g. portal.posinext.com) once its DNS points at this server; then run posinext-cloud-domain.' 'HUB_PORTAL_DOMAIN=' >> "$ENV"
  fi
fi

# Caddy: the portal's site, between markers (replaced each time)
if [ "${HUB_CADDY_MODE:-own}" = "import" ]; then CADDY="${CADDY_DIR:-/etc/caddy}/posinext-cloud.caddy"; else CADDY="${CADDY_DIR:-/etc/caddy}/Caddyfile"; fi
if [ -f "$CADDY" ]; then
  sed -i '/^# >>> dinepos portal/,/^# <<< dinepos portal/d' "$CADDY"
  domain=$(grep '^HUB_PORTAL_DOMAIN=' "$ENV" | tail -1 | cut -d= -f2- | tr -d '[:space:]')
  if [ -n "$domain" ]; then
    cat >> "$CADDY" <<EOF
# >>> dinepos portal (hub/deploy/portal.sh)
$domain {
  encode gzip
  reverse_proxy 127.0.0.1:${HUB_PORT:-4900}
}
# <<< dinepos portal
EOF
    echo "Portal address: https://$domain"
  fi
  if [ "${NO_RELOAD:-}" != "1" ]; then systemctl reload caddy 2>/dev/null || true; fi
fi
