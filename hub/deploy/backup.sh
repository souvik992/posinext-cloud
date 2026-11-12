#!/bin/bash
# PosiNext Cloud backups, run every hour by cron as root (/etc/cron.hourly/posinext-cloud-backup runs this file from the
# repository, so `posinext-cloud-update` keeps it current).
#   - the cloud's own database: one copy per day in /var/backups/posinext-cloud
#   - each hosted outlet: its newest DinePOS backup (DinePOS makes one every 15 minutes) in .../outlets/<store id>/
#   - 14 days kept here; and OFF this server to S3 when HUB_S3_BUCKET is set in /etc/posinext-cloud.env (needs the AWS
#     CLI and an EC2 instance role allowed to write to that bucket). Losing the server then loses at most an hour.
# The result goes to <data>/backup-status.json, which the cloud's monitoring reads (/health/deep, alerts).
set -uo pipefail
ENV_FILE=/etc/posinext-cloud.env
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
DATA="${HUB_DATA_DIR:-/var/lib/posinext-cloud}"
OUT="${BACKUP_OUT:-/var/backups/posinext-cloud}"
STATUS="$DATA/backup-status.json"
mkdir -p "$OUT/outlets"
err=""

if [ -f "$DATA/hub.db" ]; then
  sqlite3 "$DATA/hub.db" ".backup '$OUT/hub-$(date +%F).db'" || err="the cloud database could not be copied"
fi

count=0
if [ -d "$DATA/outlets" ]; then
  for dir in "$DATA"/outlets/*/; do
    [ -d "${dir}backups" ] || continue
    id=$(basename "$dir")
    newest=$(find "${dir}backups" -maxdepth 1 -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
    [ -n "$newest" ] || continue
    mkdir -p "$OUT/outlets/$id"
    if cp -p "$newest" "$OUT/outlets/$id/"; then count=$((count + 1)); else err="outlet $id could not be copied"; fi
  done
fi
find "$OUT" -type f -mtime +14 -delete

target="this server only"
if [ -n "${HUB_S3_BUCKET:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    if aws s3 sync "$OUT" "s3://$HUB_S3_BUCKET/posinext-cloud/" --only-show-errors; then
      target="s3://$HUB_S3_BUCKET"
    else
      err="the copy to S3 failed (check the instance role and the bucket name)"
    fi
  else
    err="HUB_S3_BUCKET is set but the AWS CLI is not installed (run the installer again)"
  fi
fi

ok=true
[ -n "$err" ] && ok=false
errjson=null
[ -n "$err" ] && errjson="\"$err\""
offsite=false
[ "${target#s3://}" != "$target" ] && offsite=true
printf '{"at":"%s","ok":%s,"outlets":%d,"target":"%s","offsite":%s,"error":%s}\n' "$(date -u +%FT%TZ)" "$ok" "$count" "$target" "$offsite" "$errjson" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
chown posinextcloud "$STATUS" 2>/dev/null || true
[ "$ok" = true ]
